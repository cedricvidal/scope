// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Reuse shared's existing YAML dependency, as the worker Dockerfiles do.
const { parse }: { parse: (source: string) => unknown } =
  createRequire(resolve("packages/shared/package.json"))("yaml");

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
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
  strategy?: { matrix: { worker: { name: string; dockerfile: string; versions_env: string; test_pattern: string; images: string }[] } };
}

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const jobs = workflow.jobs;
const directories: string[] = [];
const trusted = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";

function step(job: string, name: string): Step {
  const result = jobs[job].steps.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing step ${job}: ${name}`);
  return result;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CI execution prerequisites", () => {
  it("selects integration checks for workflow changes without marking every image changed", () => {
    const filtersStep = jobs["detect-changes"].steps.find((candidate) => candidate.uses?.startsWith("dorny/paths-filter@"));
    const filters = parse(filtersStep!.with!.filters) as Record<string, string[]>;
    expect(filters.ci).toContain(".github/workflows/ci.yml");
    expect(filters.ci).toContain("scripts/ci-workflow.test.ts");
    expect(filters.typescript).toContain("scripts/ci-workflow.test.ts");
    expect(filters.shared).not.toContain(".github/workflows/ci.yml");
    expect(jobs["detect-changes"].outputs?.ci).toBe("${{ steps.changes.outputs.ci }}");
    for (const name of ["integration-test", "integration-test-queue"]) {
      expect(jobs[name].if).toContain("needs.detect-changes.outputs.ci == 'true'");
    }
  });

  it("targets each existing ACP worker explicitly instead of a missing root Dockerfile", () => {
    const workers = jobs["integration-test"].strategy!.matrix.worker;
    expect(workers.map((worker) => worker.name)).toEqual(["copilot-acp", "claude-code-acp"]);
    for (const worker of workers) {
      for (const path of [worker.dockerfile, worker.versions_env, worker.test_pattern]) {
        expect(path).toBeTruthy();
        expect(existsSync(path), path).toBe(true);
      }
      expect(worker.images).toContain(`-f ${worker.dockerfile}`);
      expect(readdirSync(join(worker.test_pattern, "src")).some((file) => file.endsWith(".integration.test.ts"))).toBe(true);
    }
  });

  it("parses the inline shell scripts, including every image-tag case arm", () => {
    for (const job of Object.values(jobs)) {
      for (const command of job.steps.filter((candidate) => candidate.run)) {
        const script = command.run!.replace(/\$\{\{.*?\}\}/g, "placeholder");
        const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
        expect(result.stderr, command.name).toBe("");
        expect(result.status, command.name).toBe(0);
      }
    }
  });

  it("hashes the same existing Copilot versions file that Windows loads for its build", () => {
    const load = step("build-windows-image", "Load pinned versions").run!;
    const versionFile = load.match(/VERSION_FILE="([^"]+)"/)![1];
    expect(existsSync(versionFile)).toBe(true);
    const hash = step("build-windows-image", "Resolve deps image tag").run!;
    expect(hash).toContain(`Dockerfile.deps ${versionFile} \${WORKER_DIR}/Dockerfile.base`);
    expect(hash).not.toContain("${WORKER_DIR}/versions.env");
  });

  for (const recordings of [false, true]) {
    it(`collects videos successfully ${recordings ? "with nested recordings and spaces in paths" : "without any test-output directories"}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "scope-ci-video-"));
      directories.push(directory);
      mkdirSync(join(directory, "apps/workers"), { recursive: true });
      if (recordings) {
        const output = join(directory, "apps/workers/example/test-output/nested folder");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "first clip.webm"), "first");
        writeFileSync(join(output, "second.webm"), "second");
      }
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step("integration-test", "Collect test videos").run!], {
        cwd: directory, encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const files = readdirSync(join(directory, "test-videos"));
      expect(files).toHaveLength(recordings ? 2 : 0);
      if (recordings) expect(files.map((file) => readFileSync(join(directory, "test-videos", file), "utf8")).sort()).toEqual(["first", "second"]);
      expect(step("integration-test", "Upload test videos").with?.["if-no-files-found"]).toBe("ignore");
    });
  }
});

describe("CI repository and credential boundaries", () => {
  it("retains all four canonical repository gates", () => {
    for (const name of ["integration-test", "integration-test-queue", "build-images", "build-windows-image"]) {
      expect(jobs[name].if).toContain("github.repository == 'microsoft/scope' &&");
    }
    expect(workflow.on).not.toHaveProperty("pull_request_target");
  });

  it("keeps ACP tool checks and queue tests available to upstream fork PRs with read-only tokens", () => {
    for (const name of ["integration-test", "integration-test-queue"]) {
      expect(jobs[name].permissions).toEqual({ contents: "read" });
      expect(jobs[name].if).not.toContain("head.repo");
      expect(jobs[name].env?.DOCKERHUB_LOGIN_ENABLED).toBe("${{ secrets.DOCKERHUB_USERNAME != '' && secrets.DOCKERHUB_TOKEN != '' }}");
      expect(step(name, "Log in to Docker Hub").if).toContain("env.DOCKERHUB_LOGIN_ENABLED == 'true'");
    }
    expect(step("integration-test-queue", "Log in to Docker Hub").if).toContain(trusted);
    expect(jobs["integration-test"].env?.TRUSTED_CODE).toBe(`\${{ ${trusted} }}`);
    expect(step("integration-test", "Log in to Docker Hub").if).toContain("env.TRUSTED_CODE == 'true'");
    for (const value of Object.values(step("integration-test", "Run integration tests").env!)) {
      expect(value).toMatch(/^\$\{\{ env\.TRUSTED_CODE == 'true' && secrets\.\w+ \|\| '' \}\}$/);
    }
  });

  it("reserves OIDC for trusted publishers while preserving PR reporting permissions and steps", () => {
    expect(workflow.permissions).not.toHaveProperty("id-token");
    expect(workflow.permissions["pull-requests"]).toBe("write");
    expect(workflow.permissions.issues).toBe("write");
    for (const name of ["build-images", "build-windows-image"]) {
      expect(jobs[name].if).toContain(trusted);
      expect(jobs[name].permissions).toEqual({ contents: "read", "id-token": "write" });
    }
    expect(jobs["llm-evals"].if).toContain(trusted);
    for (const name of ["test", "gateway"]) {
      expect(step(name, "Post test results to Pull Request").run).toContain("github-actions-ctrf pull-request");
    }
  });
});
