// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { CodingAgentDocument } from "./types/types.js";
import {
  requiredAgentCapabilities,
  resolveAgentTarget,
} from "./resolve-agent-target.js";

function makeAgent(
  overrides: Partial<CodingAgentDocument> = {},
): CodingAgentDocument {
  return {
    _id: "coder-test",
    name: "Test",
    supportedModels: ["model"],
    available: true,
    capabilities: {
      supportsReasoningEffort: true,
      supportsMcpServers: true,
    },
    versions: [{
      agentVersion: "test-1.0.0",
      workerVersion: "test-1.0.0-build",
      components: {},
      gitCommit: "abc1234",
      buildTime: "20260825T000000Z",
      imageTag: "test-1.0.0-build",
      queueName: "queue-test",
      status: "active",
      createdAt: new Date("2026-08-25T00:00:00Z"),
    }],
    createdAt: new Date(),
    ...overrides,
  };
}

describe("resolveAgentTarget", () => {
  it("resolves an available registered target", () => {
    const result = resolveAgentTarget(makeAgent(), "coder-test");
    expect(result).toMatchObject({
      agentVersion: "test-1.0.0",
      queueName: "queue-test",
      warnings: [],
    });
  });

  it.each([
    [undefined, "agent_not_found"],
    [makeAgent({ deletedAt: new Date() }), "agent_deleted"],
    [makeAgent({ available: false }), "agent_unavailable"],
    [makeAgent({ available: undefined }), "agent_unavailable"],
    [makeAgent({ versions: [] }), "agent_version_invalid"],
  ] as const)("rejects invalid registry target %#", (agent, code) => {
    const result = resolveAgentTarget(agent, "coder-test");
    expect("code" in result && result.code).toBe(code);
  });

  it("warns for undeclared capabilities by default", () => {
    const result = resolveAgentTarget(makeAgent(), "coder-test", {
      requiredCapabilities: ["supportsSkills"],
    });
    expect("warnings" in result && result.warnings).toEqual([
      'Agent "coder-test" does not declare support for skills.',
    ]);
  });

  it("rejects undeclared capabilities in strict mode", () => {
    const result = resolveAgentTarget(makeAgent(), "coder-test", {
      requiredCapabilities: ["supportsSkills", "supportsExtensions"],
      strictCapabilities: true,
    });
    expect(result).toMatchObject({
      code: "agent_capability_mismatch",
      missingCapabilities: ["supportsSkills", "supportsExtensions"],
    });
  });
});

describe("requiredAgentCapabilities", () => {
  it("maps only non-empty requested features", () => {
    expect(requiredAgentCapabilities({
      reasoningEffort: "high",
      mcpServers: ["docs"],
      skills: [],
      extensions: ["publisher.extension"],
    })).toEqual([
      "supportsReasoningEffort",
      "supportsMcpServers",
      "supportsExtensions",
    ]);
  });
});
