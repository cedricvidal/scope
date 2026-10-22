// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadCases, loadGold, assertObservation } from "./cases.js";
import { prepareInput, skippedResultSchema, validateResult, atifSchema, contextSchema, SCHEMA_VERSION } from "./contracts.js";
import { copilotAI, skippedExecutor } from "./copilot.js";
import { restoreArtifact, contractHash } from "./optimization.js";
import { buildReadout } from "./readout.js";

/**
 * Resolves committed fixtures/evidence relative to the package root.
 *
 * @param path - Package-relative fixture or evidence path.
 */
const file = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

/**
 * Reads an evidence file without weakening its unknown boundary.
 *
 * @param path - Package-relative JSON path.
 */
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(file(path), "utf8")) as unknown;

describe("committed real experiment artifacts (offline verification only)", () => {
  it("restores all selected learned demos, which are valid training-only predictions", async () => {
    // Validate every serialized demo/seed against the original training packet and fixed gold.
    const artifact = restoreArtifact(await json("evidence/optimized.v2.ax.json"), "gpt-5.6-sol-fast");
    expect(artifact.contract_hash).toBe(contractHash());
    const cases = await loadCases(file("fixtures/inputs.jsonl")), gold = await loadGold(file("fixtures/gold.json"));
    const demos = artifact.optimized.demos?.flatMap(d => d.traces) ?? [];
    expect(demos).toHaveLength(3);
    const seeded = z.object({ examples: z.array(z.unknown()) }).passthrough().parse(artifact.optimized).examples;
    expect(seeded).toHaveLength(5);
    const sessionIds: string[] = [];
    for (const [index, value] of [...demos, ...seeded].entries()) {
      const demo = z.object({ evidence: z.string(), observation: skippedResultSchema }).passthrough().parse(value);
      const input = z.object({ schema_version: z.literal(SCHEMA_VERSION), atif: atifSchema, context: contextSchema }).strict().parse(JSON.parse(demo.evidence) as unknown);
      const row = cases.find(c => c.input.atif.session_id === input.atif.session_id);
      expect(row?.split).toBe("train");
      if (!row) throw new Error("Demo not in training packet");
      expect(validateResult("beh-skipped-invocation", demo.observation, prepareInput({ atif: input.atif, context: input.context }))).toEqual(demo.observation);
      expect(assertObservation(demo.observation, gold[row.id]["beh-skipped-invocation"]!)).toEqual([]);
      if (index < demos.length) sessionIds.push(input.atif.session_id);
    }
    // Render one held-out query to prove applyOptimization reattaches every selected learned demo.
    const row = cases.find(c => c.id === "held-cli")!;
    let restoredPrompt = "";
    const executor = skippedExecutor(
      copilotAI({
        complete: async (_system, user) => {
          restoredPrompt = user;
          return { content: 'Observation: {"state":"completed","observed":false}' };
        },
        close: async () => { },
      }),
      artifact.optimized
    );
    await executor.evaluate("beh-skipped-invocation", row.input);
    for (const id of sessionIds) expect(restoredPrompt).toContain(id);
    await expect(json("evidence/optimized.v1.ax.json").then(a => restoreArtifact(a, "gpt-5.6-sol-fast"))).rejects.toThrow("contract mismatch");
  });
  it("keeps the final packet disjoint and unused by the optimizer metric trace", async () => {
    // Final families/origins must not appear in development data or optimizer scoring.
    const development = await loadCases(file("fixtures/inputs.jsonl")), final = await loadCases(file("fixtures/final-inputs.jsonl"));
    const artifact = restoreArtifact(await json("evidence/optimized.v2.ax.json"), "gpt-5.6-sol-fast");
    expect(final.every(f => development.every(d => f.family !== d.family && f.originating_run !== d.originating_run))).toBe(true);
    expect(artifact.metric_trace.every(m => final.every(f => f.id !== m.case_id))).toBe(true);
    expect(artifact.metric_trace.every(m => [...artifact.train_ids, ...artifact.validation_ids].includes(m.case_id))).toBe(true);
    expect(artifact.metric_trace.length).toBeLessThanOrEqual(48);
  });
  it("rebuilds the actual-result preview with distinct-run and occurrence counts", async () => {
    // The deterministic consumer must reproduce the committed JSON exactly from its committed input.
    const rebuilt = buildReadout(await json("evidence/readout-input.json"));
    expect(rebuilt).toEqual(await json("evidence/readout-preview.json"));
    const timeout = rebuilt.groups[0].behaviors.find(b => b.element_id === "beh-timeout")!;
    expect(timeout.distinct_runs).toBe(2);
    expect(timeout.occurrences).toBe(4);
    expect(timeout.sources.find(s => s.source?.id === "account")).toMatchObject({ distinct_runs: 2, occurrences: 3 });
  });
  it("verifies the frozen ledger, artifact hashes and case packet fingerprints", async () => {
    // Content hashes protect historical model evidence while source-only revisions continue separately.
    const manifest = z.object({
      budget: z.object({ cap: z.literal(500), used: z.literal(256), remaining: z.literal(244), finished: z.literal(256) }).passthrough(),
      artifact_sha256: z.record(z.string()),
      case_packet_sha256: z.record(z.string()),
    }).passthrough().parse(await json("evidence/manifest.json"));
    for (const [name, expected] of Object.entries(manifest.artifact_sha256)) {
      expect(name).toMatch(/^[\w.-]+\.(json|jsonl|md)$/);
      expect(createHash("sha256").update(await readFile(file(`evidence/${name}`))).digest("hex")).toBe(expected);
    }
    for (const [name, expected] of Object.entries(manifest.case_packet_sha256)) {
      expect(name).toMatch(/^[\w.-]+\.(json|jsonl)$/);
      expect(createHash("sha256").update(await readFile(file(`fixtures/${name}`))).digest("hex")).toBe(expected);
    }
    const events: unknown[] = (await readFile(file("evidence/call-ledger.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as unknown);
    const reservations = events.filter(e => typeof e === "object" && e !== null && "type" in e && e.type === "reserved");
    const finished = events.filter(e => typeof e === "object" && e !== null && "type" in e && e.type === "finished");
    expect(reservations).toHaveLength(256);
    expect(finished).toHaveLength(256);
  });

  it("keeps the YAML prompt demo evidence separate from the frozen 256-call snapshot", async () => {
    const manifest = z.object({
      historical_snapshot: z.object({
        calls: z.literal(256),
        cap: z.literal(500),
        ledger_sha256: z.string(),
        preserved_unchanged: z.literal(true),
      }),
      fresh_cumulative_budget: z.object({
        cap: z.literal(500),
        used: z.literal(267),
        remaining: z.literal(233),
        new_calls: z.literal(11),
      }),
      results: z.object({
        heldout_baseline: z.object({
          passed: z.literal(2),
          total: z.literal(2),
          pass_rate: z.literal(1),
        }),
        heldout_replay: z.object({
          passed: z.literal(2),
          total: z.literal(2),
          pass_rate: z.literal(1),
          accuracy_gain: z.literal(false),
        }),
      }).passthrough(),
      artifact_sha256: z.record(z.string()),
    }).passthrough().parse(
      await json("evidence/yaml-prompt-demo/manifest.json"),
    );

    expect(manifest.historical_snapshot.ledger_sha256).toBe(
      createHash("sha256")
        .update(await readFile(file("evidence/call-ledger.jsonl")))
        .digest("hex"),
    );
    for (const [name, expected] of Object.entries(manifest.artifact_sha256)) {
      expect(createHash("sha256")
        .update(await readFile(file(`evidence/yaml-prompt-demo/${name}`)))
        .digest("hex")).toBe(expected);
    }

    const events = (await readFile(
      file("evidence/yaml-prompt-demo/call-ledger-delta.jsonl"),
      "utf8",
    )).trim().split("\n").map(line => JSON.parse(line) as {
      type: string;
      id: number;
      ok?: boolean;
    });
    const reservations = events.filter(event => event.type === "reserved");
    const finished = events.filter(event => event.type === "finished");
    expect(reservations.map(event => event.id)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 257),
    );
    expect(finished).toHaveLength(11);
    expect(finished.every(event => event.ok === true)).toBe(true);
  });

  it("records the opaque-ID control without rewriting the confounded demo", async () => {
    const manifest = z.object({
      supersedes_quality_claim_from: z.literal(
        "packages/taxonomy-evaluation/evidence/yaml-prompt-demo",
      ),
      historical_evidence_preserved: z.object({
        original_snapshot_calls: z.literal(256),
        first_yaml_demo_calls: z.literal(11),
        files_rewritten: z.literal(false),
      }),
      neutral_control_budget: z.object({
        cap: z.literal(500),
        starting_used: z.literal(267),
        new_calls: z.literal(11),
        cumulative_used: z.literal(278),
        remaining: z.literal(222),
      }),
      identity_control: z.object({
        case_metadata_forwarded_by_production_projection: z.literal(false),
        outcome_coded_identifiers: z.literal(false),
        semantic_gold_changed: z.literal(false),
      }).passthrough(),
      results: z.object({
        heldout_baseline: z.object({
          passed: z.literal(2),
          total: z.literal(2),
          pass_rate: z.literal(1),
        }).passthrough(),
        optimization: z.object({
          learned_traces: z.literal(3),
          instruction_proposals: z.literal(0),
        }).passthrough(),
        heldout_replay: z.object({
          passed: z.literal(2),
          total: z.literal(2),
          pass_rate: z.literal(1),
          accuracy_gain: z.literal(false),
        }).passthrough(),
      }).passthrough(),
      artifact_sha256: z.record(z.string()),
    }).passthrough().parse(
      await json("evidence/yaml-prompt-neutral-control/manifest.json"),
    );

    for (const [name, expected] of Object.entries(manifest.artifact_sha256)) {
      expect(createHash("sha256")
        .update(await readFile(
          file(`evidence/yaml-prompt-neutral-control/${name}`),
        ))
        .digest("hex")).toBe(expected);
    }

    const events = (await readFile(
      file("evidence/yaml-prompt-neutral-control/call-ledger-delta.jsonl"),
      "utf8",
    )).trim().split("\n").map(line => JSON.parse(line) as {
      type: string;
      id: number;
      ok?: boolean;
    });
    expect(events.filter(event => event.type === "reserved").map(event => event.id))
      .toEqual(Array.from({ length: 11 }, (_, index) => index + 268));
    expect(events.filter(event => event.type === "finished"))
      .toHaveLength(11);
    expect(events.filter(event => event.type === "finished")
      .every(event => event.ok === true)).toBe(true);
  });

  it("records clear current paths and separate code-versus-prompt testing", async () => {
    const manifest = z.object({
      capture: z.object({
        head: z.literal("dec7cc8f6d0e26b8f99197c29fa9e200107dcf05"),
        first_reserved_at: z.literal("2026-10-22T22:16:38.337Z"),
        last_reserved_at: z.literal("2026-10-22T22:17:59.537Z"),
      }).passthrough(),
      post_capture_validation: z.object({
        timeout_organization_commit: z.literal(
          "1788683d7ea1715c462f1f6444b550e8c26f49e9",
        ),
        model_visible_inputs_changed: z.literal(false),
        handler_behavior_changed: z.literal(false),
        additional_model_calls: z.literal(0),
      }).passthrough(),
      previous_cumulative_used: z.literal(278),
      new_calls: z.literal(11),
      cumulative_used: z.literal(289),
      cap: z.literal(500),
      remaining: z.literal(211),
      clear_current_paths: z.object({
        trajectory_dataset: z.literal(
          "datasets/repeated-request/trajectory-cases.jsonl",
        ),
        expected_judgments: z.literal(
          "datasets/repeated-request/expected-judgments.json",
        ),
        original_prompt_results: z.literal(
          "results/repeated-request/held-out/original-prompt-results.json",
        ),
        optimized_prompt_artifact: z.literal(
          "artifacts/repeated-request/optimized-prompt.ax.json",
        ),
        optimized_prompt_results: z.literal(
          "results/repeated-request/held-out/optimized-prompt-results.json",
        ),
      }).passthrough(),
      code_handler_tests: z.object({
        custom_retry_loop: z.object({
          passed: z.literal(2),
          total: z.literal(2),
          model_calls: z.literal(0),
        }).passthrough(),
        built_in_timeout: z.object({
          folder: z.literal(
            "packages/taxonomy-evaluation/src/handlers/timeout",
          ),
          passed: z.literal(15),
          total: z.literal(15),
          model_calls: z.literal(0),
        }).passthrough(),
      }),
      evaluation_semantics: z.object({
        false_or_indeterminate_can_pass: z.literal(true),
        passed_total_unit: z.literal("case executions including samples"),
        fresh_calls_when_model_invoked: z.literal(true),
        authoritative_preflight_can_avoid_call: z.literal(true),
        artifact_restore_caches_answers: z.literal(false),
      }).passthrough(),
      results: z.object({
        heldout_original_prompt: z.object({
          passed: z.literal(2),
          total: z.literal(2),
        }).passthrough(),
        heldout_optimized_prompt: z.object({
          passed: z.literal(2),
          total: z.literal(2),
          accuracy_gain: z.literal(false),
        }).passthrough(),
      }).passthrough(),
      historical_packets_rewritten: z.literal(false),
      artifact_sha256: z.record(z.string()),
    }).passthrough().parse(
      await json("evidence/yaml-prompt-readable-paths-control/manifest.json"),
    );

    for (const [name, expected] of Object.entries(manifest.artifact_sha256)) {
      expect(createHash("sha256")
        .update(await readFile(
          file(`evidence/yaml-prompt-readable-paths-control/${name}`),
        ))
        .digest("hex")).toBe(expected);
    }
    const events = (await readFile(
      file("evidence/yaml-prompt-readable-paths-control/call-ledger-delta.jsonl"),
      "utf8",
    )).trim().split("\n").map(line => JSON.parse(line) as {
      type: string;
      id: number;
      ok?: boolean;
    });
    expect(events.filter(event => event.type === "reserved").map(event => event.id))
      .toEqual(Array.from({ length: 11 }, (_, index) => index + 279));
    expect(events.filter(event => event.type === "finished"))
      .toHaveLength(11);
    expect(events.filter(event => event.type === "finished")
      .every(event => event.ok === true)).toBe(true);
  });
});
