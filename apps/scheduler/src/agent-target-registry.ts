// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { QueueClient } from "@azure/storage-queue";
import type { Collection } from "mongodb";
import {
  resolveAgentTarget,
  type CodingAgentDocument,
} from "shared";

export interface WorkerRoute {
  workerType: string;
  agentVersion: string;
}

export interface WorkerTarget {
  routes: WorkerRoute[];
  queueName: string;
  queueClient: QueueClient;
  targetQueueDepth: number;
}

export interface WorkerTargetProvider {
  getTargets(): Promise<readonly WorkerTarget[]>;
}

export type QueueClientFactory = (queueName: string) => QueueClient;

/**
 * Refreshable physical-queue view of routable targets in the agent registry.
 * Each queue has one depth budget and one set of exact worker/version routes.
 */
export class AgentTargetRegistry implements WorkerTargetProvider {
  private targets: WorkerTarget[] = [];
  private nextRefreshAt = 0;
  private readonly queueClients = new Map<string, QueueClient>();

  constructor(
    private readonly agents: Collection<CodingAgentDocument>,
    private readonly createQueueClient: QueueClientFactory,
    private readonly targetQueueDepth: number,
    private readonly refreshIntervalMs: number,
  ) {}

  async getTargets(): Promise<readonly WorkerTarget[]> {
    if (Date.now() >= this.nextRefreshAt) {
      await this.refresh();
    }
    return this.targets;
  }

  async refresh(): Promise<void> {
    try {
      const agents = await this.agents.find({}).toArray();
      const grouped = new Map<string, WorkerRoute[]>();

      for (const agent of agents) {
        for (const version of agent.versions ?? []) {
          if (version.status !== "active") continue;
          const resolved = resolveAgentTarget(agent, agent._id, {
            requestedVersion: version.agentVersion,
          });
          if ("error" in resolved) continue;

          const routes = grouped.get(resolved.queueName) ?? [];
          if (!routes.some(
            (route) =>
              route.workerType === agent._id &&
              route.agentVersion === resolved.agentVersion,
          )) {
            routes.push({
              workerType: agent._id,
              agentVersion: resolved.agentVersion,
            });
          }
          grouped.set(resolved.queueName, routes);
        }
      }

      const refreshed: WorkerTarget[] = [];
      for (const [queueName, routes] of grouped) {
        try {
          let queueClient = this.queueClients.get(queueName);
          if (!queueClient) {
            queueClient = this.createQueueClient(queueName);
            await queueClient.createIfNotExists();
            this.queueClients.set(queueName, queueClient);
            console.log(`[Scheduler] Ensured discovered queue exists: ${queueName}`);
          }
          routes.sort((a, b) =>
            a.workerType.localeCompare(b.workerType) ||
            a.agentVersion.localeCompare(b.agentVersion),
          );
          refreshed.push({
            routes,
            queueName,
            queueClient,
            targetQueueDepth: this.targetQueueDepth,
          });
        } catch (error) {
          console.error(
            `[Scheduler] Cannot initialize queue=${queueName}; matching requests will remain pending:`,
            error,
          );
        }
      }

      refreshed.sort((a, b) => a.queueName.localeCompare(b.queueName));
      this.targets = refreshed;
      this.nextRefreshAt = Date.now() + this.refreshIntervalMs;
      console.log(
        `[Scheduler] Refreshed ${refreshed.length} physical queue target(s) from ${agents.length} registered agent(s)`,
      );
    } catch (error) {
      this.targets = [];
      this.nextRefreshAt = 0;
      throw error;
    }
  }
}
