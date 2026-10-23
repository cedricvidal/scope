// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerRunCommands } from "./run.js";

function makeProgram(): Command {
  const program = new Command();
  registerRunCommands(program);
  return program;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.SCOPE_MT_DOWNLOAD_OUTPUT_DIR;
});

describe("run download-batch", () => {
  it("preserves explicit --ids behavior and archive request order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-batch-"));
    process.env.SCOPE_MT_DOWNLOAD_OUTPUT_DIR = directory;
    let archiveBody: unknown;
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      archiveBody = JSON.parse(await request.text()) as unknown;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await makeProgram().parseAsync([
        "run",
        "download-batch",
        "--ids",
        "run-2",
        "run-1",
        "run-2",
        "-u",
        "http://localhost:3100",
      ], { from: "user" });

      expect(archiveBody).toEqual({ ids: ["run-2", "run-1"] });
      const files = await import("node:fs/promises").then(fs =>
        fs.readdir(directory)
      );
      expect(files).toHaveLength(1);
      expect(await readFile(join(directory, files[0]))).toEqual(
        Buffer.from([1, 2, 3]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves a submission through cursor pages before posting exact stable IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-submission-batch-"));
    process.env.SCOPE_MT_DOWNLOAD_OUTPUT_DIR = directory;
    const submissionId = "01234567-89ab-4cde-8fab-0123456789ab";
    const requests: Array<{ url: URL; method: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const captured = {
        url: new URL(request.url),
        method: request.method,
        body: await request.text(),
      };
      requests.push(captured);

      if (captured.url.pathname.endsWith("/requests/archive")) {
        return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
      }
      if (!captured.url.searchParams.has("after")) {
        return new Response(JSON.stringify({
          data: [
            { id: "run-exact-1", submissionId },
            { id: "run-prefix-only", submissionId: `${submissionId}-suffix` },
          ],
          cursors: { next: "cursor / next?" },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        data: [
          { id: "run-exact-1", submissionId },
          { id: "run-exact-2", submissionId },
        ],
        cursors: { next: null },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await makeProgram().parseAsync([
        "run",
        "download-batch",
        "--submission-id",
        submissionId,
        "--project",
        "project-1",
        "-u",
        "http://localhost:3100",
      ], { from: "user" });

      expect(requests).toHaveLength(3);
      for (const request of requests.slice(0, 2)) {
        expect(request.method).toBe("GET");
        expect(request.url.searchParams.get("submissionId"))
          .toBe(submissionId);
        expect(request.url.searchParams.get("projectId")).toBe("project-1");
        expect(request.url.searchParams.get("limit")).toBe("100");
      }
      expect(requests[0].url.searchParams.get("after")).toBeNull();
      expect(requests[1].url.searchParams.get("after"))
        .toBe("cursor / next?");
      expect(requests[2].url.pathname).toMatch(/\/requests\/archive$/);
      expect(requests[2].method).toBe("POST");
      expect(JSON.parse(requests[2].body)).toEqual({
        ids: ["run-exact-1", "run-exact-2"],
      });

      const files = await import("node:fs/promises").then(fs =>
        fs.readdir(directory)
      );
      expect(files).toHaveLength(1);
      expect(await readFile(join(directory, files[0]))).toEqual(
        Buffer.from([4, 5, 6]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects multiple ID sources before network I/O", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(
      (code?: string | number | null): never => {
        throw new Error(`process.exit(${String(code)})`);
      },
    );

    await expect(makeProgram().parseAsync([
      "run",
      "download-batch",
      "--ids",
      "run-1",
      "--submission-id",
      "submission-1",
      "-u",
      "http://localhost:3100",
    ], { from: "user" })).rejects.toThrow("process.exit(1)");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
