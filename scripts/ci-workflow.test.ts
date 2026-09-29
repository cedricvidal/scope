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
  needs?: string[];
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
  it("selects integration checks for workflow changes through a dedicated filter", () => {
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
      expect(worker.images).toContain("--load");
      expect(worker.images).not.toContain("--push");
      expect(spawnSync("bash", ["-n"], { input: worker.images }).status).toBe(0);
      expect(readdirSync(join(worker.test_pattern, "src")).some((file) => file.endsWith(".integration.test.ts"))).toBe(true);
    }
    expect(step("integration-test", "Pre-build Docker test images").run).toContain("${{ matrix.worker.images }}");
  });

  it("parses the remaining inline shell scripts", () => {
    for (const job of Object.values(jobs)) {
      for (const command of job.steps.filter((candidate) => candidate.run)) {
        const script = command.run!.replace(/\$\{\{.*?\}\}/g, "placeholder");
        const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
        expect(result.stderr, command.name).toBe("");
        expect(result.status, command.name).toBe(0);
      }
    }
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
  it.each([
    { repository: "microsoft/scope", integration: true },
    { repository: "growth-ecosystems/scope-core", integration: false },
    { repository: "cedricvidal/scope", integration: false },
  ])("selects public integration checks only in their owning repository: $repository", ({ repository, integration }) => {
    for (const name of ["integration-test", "integration-test-queue"]) {
      const gate = jobs[name].if!.match(/github\.repository == '([^']+)' &&/);
      expect(gate, `${name} must retain a mandatory repository gate`).not.toBeNull();
      expect(gate![1] === repository, name).toBe(integration);
    }
  });

  it("does not run fork code through pull_request_target", () => {
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

  it("has no cloud publishers or OIDC in OSS CI, while preserving reporting and CLI bundles", () => {
    expect(workflow.permissions).not.toHaveProperty("id-token");
    expect(workflow.permissions["pull-requests"]).toBe("write");
    expect(workflow.permissions.issues).toBe("write");
    expect(jobs).not.toHaveProperty("build-images");
    expect(jobs).not.toHaveProperty("build-windows-image");
    expect(workflow.on.workflow_dispatch).toBeNull();
    for (const job of Object.values(jobs)) {
      expect(job.permissions?.["id-token"]).toBeUndefined();
      expect(JSON.stringify(job)).not.toMatch(/azure\/login|az acr|ACR_NAME|scope-core/);
      for (const dependency of job.needs ?? []) expect(jobs).toHaveProperty(dependency);
    }
    expect(jobs["llm-evals"].if).toContain(trusted);
    for (const name of ["test", "gateway"]) {
      expect(step(name, "Post test results to Pull Request").run).toContain("github-actions-ctrf pull-request");
    }
    expect(step("cli-bundle-test", "Build CLI bundle").run).toBe("pnpm build:cli");
    expect(step("cli-bundle-test", "Upload CLI bundle").with?.path).toBe("apps/cli/dist/scope.mjs");
  });

  it("removes internal-only automation without removing public Pages or repository maintenance", () => {
    for (const file of ["build-windows-base.yml", "daily-repo-status.md", "daily-repo-status.lock.yml", "publish-cli.yml"]) {
      expect(existsSync(join(".github/workflows", file)), file).toBe(false);
    }
    for (const file of ["static.yml", "gitleaks.yml", "check-worker-versions.yml", "daily-test-improver.md", "daily-test-improver.lock.yml", "worker-version-upgrade.md", "worker-version-upgrade.lock.yml"]) {
      expect(existsSync(join(".github/workflows", file)), file).toBe(true);
    }
    for (const file of readdirSync(".github/workflows").filter((file) => /\.ya?ml$/.test(file))) {
      const source = readFileSync(join(".github/workflows", file), "utf8");
      expect(source, file).not.toMatch(/github\.repository == 'growth-ecosystems\/scope-core'|vars\.ACR_NAME/);
    }
  });
});
