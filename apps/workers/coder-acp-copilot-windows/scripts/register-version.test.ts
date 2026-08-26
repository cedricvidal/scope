// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Check if pwsh is available
function hasPwsh(): boolean {
  try {
    execSync("pwsh -NoProfile -Command exit", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SCRIPT_PATH = join(
  import.meta.dirname,
  "..",
  "register-version.ps1",
);

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function runScript(
  apiUrl: string,
  env: Record<string, string>,
  cwd: string,
  extraArgs: string[] = [],
  childProcesses?: ChildProcess[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "pwsh",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH, "-ApiUrl", apiUrl, ...extraArgs],
      {
        env: { ...process.env, ...env },
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    childProcesses?.push(child);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe.runIf(hasPwsh())("register-version.ps1", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let requests: RecordedRequest[];
  let responseOverrides: Map<string, { status: number; body: string }>;
  let tmpDir: string;
  let childProcesses: ChildProcess[];

  beforeAll(async () => {
    // Create mock HTTP server
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        body,
        headers: req.headers as Record<string, string | string[] | undefined>,
      });

      const override = responseOverrides.get(req.url ?? "");
      if (override) {
        res.writeHead(override.status, { "Content-Type": "application/json" });
        res.end(override.body);
        return;
      }

      // Default: return 200 with empty JSON
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(() => {
    server?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests = [];
    responseOverrides = new Map();
    childProcesses = [];

    // Create temp dir with agent.json fixture
    tmpDir = mkdtempSync(join(tmpdir(), "reg-test-"));
    const agentData = {
      _id: "coder-acp-copilot-windows",
      name: "GitHub Copilot CLI (Windows)",
      description: "Test agent",
      modelProvider: "github-copilot",
      available: true,
    };
    writeFileSync(join(tmpDir, "agent.json"), JSON.stringify(agentData));
  });

  afterEach(() => {
    // Kill any spawned child processes that haven't exited to prevent leaks
    for (const child of childProcesses) {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    }
    childProcesses = [];
  });

  it("registers agent and version with correct payloads", async () => {
    const env = {
      QUEUE_NAME: "custom-windows-queue",
      COPILOT_CLI_VERSION: "1.2.3",
      BUILD_TIME: "20260601T120000Z",
      GIT_COMMIT: "abc1234",
    };

    // Copy script to tmpDir so PSScriptRoot resolves agent.json
    const { code, stdout, stderr } = await runScript(
      `http://127.0.0.1:${port}`,
      env,
      tmpDir,
      [],
      childProcesses,
    );

    expect(code, `Script failed.\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
    expect(requests.length).toBe(3); // health + agent upsert + version

    // Health check
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe("/health");

    // Agent upsert
    const agentReq = requests[1];
    expect(agentReq.method).toBe("POST");
    expect(agentReq.url).toBe("/api/v1/agents");
    expect(agentReq.headers["content-type"]).toContain("application/json");
    const agentBody = JSON.parse(agentReq.body);
    expect(agentBody._id).toBe("coder-acp-copilot-windows");
    expect(agentBody.name).toBe("GitHub Copilot CLI (Windows)");
    expect(agentBody.modelProvider).toBe("github-copilot");

    // Version registration
    const versionReq = requests[2];
    expect(versionReq.method).toBe("POST");
    expect(versionReq.url).toBe("/api/v1/agents/coder-acp-copilot-windows/versions");
    const versionBody = JSON.parse(versionReq.body);
    expect(versionBody.agentVersion).toBe("copilot-1.2.3");
    expect(versionBody.workerVersion).toBe("copilot-1.2.3-20260601T120000Z-abc1234");
    expect(versionBody.components.COPILOT_CLI_VERSION).toBe("1.2.3");
    expect(versionBody.gitCommit).toBe("abc1234");
    expect(versionBody.buildTime).toBe("20260601T120000Z");
    expect(versionBody.queueName).toBe("custom-windows-queue");
  }, 30000);

  it("uses 'unknown' fallbacks when env vars are missing", async () => {
    const { code, stdout, stderr } = await runScript(
      `http://127.0.0.1:${port}`,
      { QUEUE_NAME: "custom-windows-queue", COPILOT_CLI_VERSION: "", BUILD_TIME: "", GIT_COMMIT: "" },
      tmpDir,
      [],
      childProcesses,
    );

    expect(code, `Script failed.\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(0);

    const versionReq = requests[2];
    const versionBody = JSON.parse(versionReq.body);
    expect(versionBody.agentVersion).toBe("copilot-unknown");
    expect(versionBody.workerVersion).toBe("copilot-unknown-unknown-unknown");
    expect(versionBody.components.COPILOT_CLI_VERSION).toBe("unknown");
  }, 30000);

  it("exits with non-zero code when version registration fails after retries", async () => {
    responseOverrides.set("/api/v1/agents/coder-acp-copilot-windows/versions", {
      status: 500,
      body: JSON.stringify({ error: "Internal Server Error" }),
    });

    const env = {
      QUEUE_NAME: "custom-windows-queue",
      COPILOT_CLI_VERSION: "1.0.0",
      BUILD_TIME: "20260101T000000Z",
      GIT_COMMIT: "deadbeef",
    };

    const { code, stdout } = await runScript(
      `http://127.0.0.1:${port}`,
      env,
      tmpDir,
      ["-VersionRetries", "2"],
      childProcesses,
    );
    expect(code).not.toBe(0);

    // Verify it attempted retries
    const versionRequests = requests.filter((r) => r.url?.includes("/versions"));
    expect(versionRequests.length).toBe(2);
  }, 30000);

  it("succeeds when version registration fails transiently then succeeds", async () => {
    let versionCallCount = 0;
    // Replace the default handler: fail first 2 attempts, succeed on 3rd
    server.removeAllListeners("request");
    server.on("request", async (req: IncomingMessage, res: ServerResponse) => {
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        body,
        headers: req.headers as Record<string, string | string[] | undefined>,
      });

      if (req.url?.includes("/versions")) {
        versionCallCount++;
        if (versionCallCount < 3) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Transient failure" }));
          return;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });

    const env = {
      QUEUE_NAME: "custom-windows-queue",
      COPILOT_CLI_VERSION: "1.0.0",
      BUILD_TIME: "20260101T000000Z",
      GIT_COMMIT: "deadbeef",
    };

    const { code, stdout, stderr } = await runScript(
      `http://127.0.0.1:${port}`,
      env,
      tmpDir,
      ["-VersionRetries", "3"],
      childProcesses,
    );
    expect(code, `Script failed.\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(0);

    const versionRequests = requests.filter((r) => r.url?.includes("/versions"));
    expect(versionRequests.length).toBe(3); // 2 failures + 1 success
  }, 45000);

  it("exits with non-zero when health check exceeds max retries", async () => {
    // Start a server that never returns healthy
    const unhealthyServer = createServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Service Unavailable");
    });

    await new Promise<void>((resolve) => {
      unhealthyServer.listen(0, "127.0.0.1", () => resolve());
    });
    const unhealthyPort = (unhealthyServer.address() as { port: number }).port;

    const env = {
      QUEUE_NAME: "custom-windows-queue",
      COPILOT_CLI_VERSION: "1.0.0",
      BUILD_TIME: "20260101T000000Z",
      GIT_COMMIT: "deadbeef",
    };

    const { code, stdout } = await runScript(
      `http://127.0.0.1:${unhealthyPort}`,
      env,
      tmpDir,
      ["-MaxHealthRetries", "2", "-MaxDnsRetries", "2"],
      childProcesses,
    );

    unhealthyServer.close();
    expect(code).not.toBe(0);
    expect(stdout).toContain("API not ready");
  }, 30000);

  it("continues when agent upsert fails but version registration succeeds", async () => {
    responseOverrides.set("/api/v1/agents", {
      status: 500,
      body: JSON.stringify({ error: "DB error" }),
    });

    const env = {
      QUEUE_NAME: "custom-windows-queue",
      COPILOT_CLI_VERSION: "1.0.0",
      BUILD_TIME: "20260101T000000Z",
      GIT_COMMIT: "deadbeef",
    };

    const { code, stdout, stderr } = await runScript(`http://127.0.0.1:${port}`, env, tmpDir, [], childProcesses);

    // Script should still succeed (agent upsert failure is a warning)
    expect(code, `Script failed.\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
    // Version registration still attempted
    expect(requests.some((r) => r.url?.includes("/versions"))).toBe(true);
  }, 30000);

  it("fails before registration when QUEUE_NAME is missing", async () => {
    const { code, stderr } = await runScript(
      `http://127.0.0.1:${port}`,
      {
        QUEUE_NAME: "",
        COPILOT_CLI_VERSION: "1.0.0",
        BUILD_TIME: "20260101T000000Z",
        GIT_COMMIT: "deadbeef",
      },
      tmpDir,
      [],
      childProcesses,
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain("QUEUE_NAME environment variable is required");
    expect(requests).toHaveLength(0);
  }, 30000);
});
