// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  AgentCapabilities,
  CodingAgentDocument,
} from "./types/types.js";
import {
  resolveAgentVersion,
  type ResolvedVersion,
} from "./resolve-agent-version.js";

export type AgentCapability = keyof AgentCapabilities;

export interface ResolvedAgentTarget extends ResolvedVersion {
  agent: CodingAgentDocument;
  warnings: string[];
}

export interface AgentTargetResolutionError {
  error: string;
  code:
    | "agent_not_found"
    | "agent_deleted"
    | "agent_unavailable"
    | "agent_version_invalid"
    | "agent_capability_mismatch";
  activeVersions?: string[];
  missingCapabilities?: AgentCapability[];
}

export interface ResolveAgentTargetOptions {
  requestedVersion?: string;
  requiredCapabilities?: AgentCapability[];
  strictCapabilities?: boolean;
}

const CAPABILITY_LABELS: Record<AgentCapability, string> = {
  supportsReasoningEffort: "reasoning effort",
  supportsMcpServers: "MCP servers",
  supportsSkills: "skills",
  supportsExtensions: "extensions",
};

export function resolveAgentTarget(
  agent: CodingAgentDocument | null | undefined,
  workerType: string,
  options: ResolveAgentTargetOptions = {},
): ResolvedAgentTarget | AgentTargetResolutionError {
  if (!agent) {
    return {
      error: `Agent not found: ${workerType}`,
      code: "agent_not_found",
    };
  }
  if (agent.deletedAt) {
    return {
      error: `Agent "${workerType}" is deleted`,
      code: "agent_deleted",
    };
  }
  if (agent.available !== true) {
    return {
      error: `Agent "${workerType}" is not available for new submissions`,
      code: "agent_unavailable",
    };
  }

  const versionResult = resolveAgentVersion(
    agent.versions,
    options.requestedVersion,
  );
  if ("error" in versionResult) {
    return {
      error: `${versionResult.error} for agent "${workerType}"`,
      code: "agent_version_invalid",
      activeVersions: versionResult.activeVersions,
    };
  }

  const missingCapabilities = [...new Set(options.requiredCapabilities ?? [])]
    .filter((capability) => agent.capabilities?.[capability] !== true);
  const warnings = missingCapabilities.map(
    (capability) =>
      `Agent "${workerType}" does not declare support for ${CAPABILITY_LABELS[capability]}.`,
  );

  if (options.strictCapabilities && missingCapabilities.length > 0) {
    return {
      error: `Agent "${workerType}" does not support required capabilities: ${missingCapabilities.join(", ")}`,
      code: "agent_capability_mismatch",
      missingCapabilities,
    };
  }

  return {
    agent,
    agentVersion: versionResult.agentVersion,
    queueName: versionResult.queueName,
    warnings,
  };
}

export interface AgentCapabilityInputs {
  reasoningEffort?: string | null;
  mcpServers?: readonly string[] | null;
  skills?: readonly string[] | null;
  extensions?: readonly string[] | null;
}

export function requiredAgentCapabilities(
  inputs: AgentCapabilityInputs,
): AgentCapability[] {
  const capabilities: AgentCapability[] = [];
  if (inputs.reasoningEffort) capabilities.push("supportsReasoningEffort");
  if (inputs.mcpServers?.length) capabilities.push("supportsMcpServers");
  if (inputs.skills?.length) capabilities.push("supportsSkills");
  if (inputs.extensions?.length) capabilities.push("supportsExtensions");
  return capabilities;
}
