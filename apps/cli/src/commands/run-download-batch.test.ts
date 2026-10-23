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
});
