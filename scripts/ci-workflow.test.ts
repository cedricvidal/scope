// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Job {
  if?: string;
  needs?: string[];
  "runs-on": string;
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
  strategy?: {
    matrix: {
      worker: { dockerfile: string; versions_env: string; test_pattern: string; images: string }[];
    };
  };
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflow: Workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const repositoryGated = ["integration-test", "integration-test-queue", "build-images", "build-windows-image"];
const allChanges = {
  shared: "true",
  typescript: "true",
  evals: "true",
  gateway: "true",
  scheduler: "true",
  "coder-acp-copilot": "true",
  "coder-acp-claude-code": "true",
  "coder-acp-copilot-windows": "true",
};

function context(options: {
  event?: string;
  ref?: string;
  repository?: string;
  headRepository?: string;
  changes?: Record<string, string>;
  results?: Record<string, string>;
  images?: string;
} = {}) {
  return {
    github: {
      event_name: options.event ?? "push",
      ref: options.ref ?? "refs/heads/main",
      repository: options.repository ?? "microsoft/scope",
      event: {
        inputs: { images: options.images ?? "all" },
        pull_request: { head: { repo: { full_name: options.headRepository ?? options.repository ?? "microsoft/scope" } } },
      },
    },
    needs: Object.fromEntries(Object.keys(workflow.jobs).map((name) => [name, {
      result: options.results?.[name] ?? "success",
      outputs: name === "detect-changes" ? options.changes ?? allChanges : {},
    }])),
  };
}

function evaluate(expression: string, values: ReturnType<typeof context>, cancelled = false): data.ExpressionData {
  const functions = new Map([
    ["always", { name: "always", minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(true) }],
    ["cancelled", { name: "cancelled", minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(cancelled) }],
  ]);
  const { tokens } = new Lexer(expression.replace(/^\$\{\{|\}\}$/g, "").trim()).lex();
  const parsed = new Parser(tokens, Object.keys(values), [...functions.values()]).parse();
  const converted: unknown = JSON.parse(JSON.stringify(values), data.reviver);
  if (!(converted instanceof data.Dictionary)) throw new Error("Expected an Actions context dictionary");
  return new Evaluator(parsed, converted, functions).evaluate();
}

function enabled(job: Job, values: ReturnType<typeof context>, cancelled = false): boolean {
  if (!job.if) throw new Error("Expected an explicit job gate");
  return evaluate(job.if, values, cancelled).coerceString() === "true";
}

describe("canonical repository CI gates", () => {
  for (const name of repositoryGated) {
    const job = workflow.jobs[name];

    it(`${name} runs only in microsoft/scope, never in fork repositories or the retired repository`, () => {
      for (const repository of ["microsoft/scope", "growth-ecosystems/scope-core", "maintainer/scope"]) {
        for (const event of ["push", "pull_request", "workflow_dispatch"]) {
          expect(enabled(job, context({ repository, event }))).toBe(repository === "microsoft/scope");
        }
      }
    });

    it(`${name} distinguishes upstream fork PRs from workflows executing in forks`, () => {
      const upstreamForkPR = context({
        event: "pull_request", ref: "refs/pull/42/merge", headRepository: "contributor/fork",
      });
      expect(enabled(job, upstreamForkPR)).toBe(name === "integration-test-queue");
      expect(enabled(job, context({
        event: "pull_request", ref: "refs/pull/42/merge", headRepository: "microsoft/scope",
      }))).toBe(true);
    });

    it(`${name} preserves path and manual image selection gates`, () => {
      expect(enabled(job, context({ changes: {} }))).toBe(false);
      const publishing = name.startsWith("build-");
      expect(enabled(job, context({ event: "workflow_dispatch", changes: {}, images: "" }))).toBe(!publishing);
    });
  }

  it("runs queue recovery on upstream fork PRs without credentials", () => {
    const job = workflow.jobs["integration-test-queue"];
    for (const event of ["push", "pull_request", "workflow_dispatch"]) {
      expect(enabled(job, context({ event, headRepository: "contributor/fork" }))).toBe(true);
    }
    for (const changed of ["shared", "scheduler"]) {
      expect(enabled(job, context({ event: "pull_request", headRepository: "contributor/fork", changes: { [changed]: "true" } }))).toBe(true);
    }
    expect(enabled(job, context({ event: "pull_request", changes: {} }))).toBe(false);
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|docker\/login-action|azure\/login/);
  });

  it("grants OIDC only to publishers and no write token to public PR validation", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on).not.toHaveProperty("pull_request_target");
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job["runs-on"]).toBe("ubuntu-latest");
      const publishing = ["build-images", "build-windows-image"].includes(name);
      if (publishing) {
        expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
        expect(job.environment).toBe("integration");
      } else {
        expect(Object.values(job.permissions ?? {})).not.toContain("write");
      }
      if (JSON.stringify(job).includes("secrets.") || publishing) {
        expect(enabled(job, context({ event: "pull_request", headRepository: "contributor/fork" }))).toBe(false);
      }
    }
    expect(workflow.jobs["detect-changes"].permissions).toEqual({ contents: "read", "pull-requests": "read" });
  });

  it("preserves prerequisite failure and cancellation gates for publishing", () => {
    for (const name of ["build-images", "build-windows-image"]) {
      const job = workflow.jobs[name];
      for (const prerequisite of job.needs!.filter((dependency) => dependency !== "detect-changes")) {
        for (const result of ["failure", "cancelled"]) {
          expect(enabled(job, context({ results: { [prerequisite]: result } }))).toBe(false);
        }
        expect(enabled(job, context({ results: { [prerequisite]: "skipped" } }))).toBe(true);
      }
      expect(enabled(job, context(), true)).toBe(false);
    }
  });

  it("has only current worker matrix entries with explicit test selection", () => {
    const workers = workflow.jobs["integration-test"].strategy!.matrix.worker;
    expect(workers).toHaveLength(2);
    for (const worker of workers) {
      expect(existsSync(worker.dockerfile)).toBe(true);
      expect(existsSync(worker.versions_env)).toBe(true);
      expect(existsSync(worker.test_pattern)).toBe(true);
      expect(worker.images).toContain(`-f ${worker.dockerfile}`);
    }
  });

  it("runs regression tests and queue tests when their CI configuration changes", () => {
    const filterStep = workflow.jobs["detect-changes"].steps.find((step) => step.uses?.startsWith("dorny/paths-filter@"));
    const filters: Record<string, string[]> = parse(filterStep!.with!.filters);
    expect(filters.typescript).toContain("scripts/ci-workflow.test.ts");
    expect(filters.typescript).toContain(".github/workflows/ci.yml");
    expect(filters.shared).toContain(".github/workflows/ci.yml");
  });
});

describe("CI status aggregation", () => {
  const summary = workflow.jobs["ci-summary"];
  const step = summary.steps[0];

  function runSummary(values: ReturnType<typeof context>): number | null {
    const script = step.run!.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) =>
      evaluate(expression, values).coerceString());
    const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([name, expression]) =>
      [name, evaluate(expression, values).coerceString()]));
    return spawnSync("bash", ["-e", "-c", script], { env, encoding: "utf8" }).status;
  }

  it("accepts successful checks and intentionally disabled privileged checks", () => {
    expect(summary.if).toBe("always()");
    expect(runSummary(context())).toBe(0);
    expect(runSummary(context({
      event: "pull_request",
      results: { "integration-test": "skipped", "llm-evals": "skipped" },
    }))).toBe(0);
  });

  for (const name of summary.needs!) {
    it(`fails when ${name} fails or is cancelled`, () => {
      for (const result of ["failure", "cancelled"]) {
        expect(runSummary(context({ results: { [name]: result } }))).toBe(1);
      }
    });
  }

  it("does not relax required unit, lint, build, or license checks", () => {
    for (const name of ["test", "lint", "build", "license-headers"]) {
      expect(runSummary(context({ results: { [name]: "skipped" } }))).toBe(1);
    }
  });
});

it("keeps all inline Bash scripts syntactically valid", () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (!step.run) continue;
      const script = step.run.replace(/\$\{\{.*?\}\}/g, "placeholder");
      const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      expect(result.stderr, step.name).toBe("");
      expect(result.status, step.name).toBe(0);
    }
  }
});
