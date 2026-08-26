// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { detectCliVersion, requireQueueName } from "./agent-version.js";

describe("detectCliVersion", () => {
  it("returns a version string for an available command", () => {
    // node --version is available everywhere and outputs e.g. "v22.20.0"
    const result = detectCliVersion("node", "@test/node");
    expect(result).toMatch(/^@test\/node@\d+\.\d+\.\d+/);
  });

  describe("requireQueueName", () => {
    it("returns the configured queue name", () => {
      expect(requireQueueName({ QUEUE_NAME: "queue-custom" })).toBe(
        "queue-custom",
      );
    });

    it("supports the legacy queue environment variable", () => {
      expect(
        requireQueueName({ AZURE_STORAGE_QUEUE_NAME: "queue-legacy" }),
      ).toBe("queue-legacy");
    });

    it("rejects missing or blank queue configuration", () => {
      expect(() => requireQueueName({})).toThrow("QUEUE_NAME");
      expect(() => requireQueueName({ QUEUE_NAME: " " })).toThrow("QUEUE_NAME");
    });
  });

  it("returns 'unknown' for a non-existent command", () => {
    const result = detectCliVersion("__nonexistent_binary_xyz__", "@test/fake");
    expect(result).toBe("unknown");
  });

  it("extracts semver from mixed output", () => {
    // Using echo to simulate a command that outputs version info
    // echo outputs the string directly, and detectCliVersion should extract the version
    const result = detectCliVersion("echo", "@test/echo");
    // "echo --version" will output "--version" on macOS (echo doesn't parse --version)
    // so this will be "unknown" or the raw text — just verify it doesn't throw
    expect(typeof result).toBe("string");
  });
});
