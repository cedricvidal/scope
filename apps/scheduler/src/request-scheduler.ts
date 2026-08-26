// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { QueueClient } from "@azure/storage-queue";
import type { Collection } from "mongodb";
import {
  resolveAgentTarget,
  type CodingAgentDocument,
  type RequestDocument,
} from "shared";
import { trackMetric } from "telemetry";

export interface RegistryTarget {
  agentVersion: string;
  queueName: string;
  workerTypes: string[];
  queueClient: QueueClient;
  targetQueueDepth: number;
}

export interface RequestSchedulerOptions {
  pollIntervalMs?: number;
  registryRefreshIntervalMs?: number;
  targetQueueDepth?: number;
  invalidTargetScanLimit?: number;
}

export type QueueClientFactory = (queueName: string) => QueueClient;

/**
 * Dispatches pending requests to queues discovered from the agent registry.
 *
 * AgentVersion.queueName is the sole queue-routing source. Active targets are
 * refreshed while the process is running and deduplicated by queue/version.
 */
export class RequestScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private dispatching = false;
  private lastRegistryRefreshAt = 0;
  private targets: RegistryTarget[] = [];
  private agents = new Map<string, CodingAgentDocument>();
  private readonly queueClients = new Map<string, QueueClient>();
  private readonly invalidTargetReasons = new Map<string, string>();
  private readonly pollIntervalMs: number;
  private readonly registryRefreshIntervalMs: number;
  private readonly targetQueueDepth: number;
  private readonly invalidTargetScanLimit: number;

  constructor(
    private readonly collection: Collection<RequestDocument>,
    private readonly agentCollection: Collection<CodingAgentDocument>,
    private readonly createQueueClient: QueueClientFactory,
    options: RequestSchedulerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.registryRefreshIntervalMs =
      options.registryRefreshIntervalMs ?? 30_000;
    this.targetQueueDepth = options.targetQueueDepth ?? 5;
    this.invalidTargetScanLimit = options.invalidTargetScanLimit ?? 200;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.dispatch(), this.pollIntervalMs);
    void this.dispatch();
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const deadline = Date.now() + 5_000;
    while (this.dispatching && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    const cycleStart = Date.now();
    let totalDispatched = 0;

    try {
      if (
        this.targets.length === 0 ||
        Date.now() - this.lastRegistryRefreshAt >=
          this.registryRefreshIntervalMs
      ) {
        try {
          await this.refreshRegistry();
        } catch (error) {
          this.agents = new Map();
          this.targets = [];
          console.error(
            "[Scheduler] Failed to refresh agent registry; dispatch is paused until a successful refresh:",
            error,
          );
          return;
        }
      }

      await this.logInvalidPendingTargets();

      for (const target of this.targets) {
        try {
          totalDispatched += await this.dispatchForTarget(target);
        } catch (error) {
          console.error(
            `[Scheduler] Error dispatching queue=${target.queueName} version=${target.agentVersion}:`,
            error,
          );
        }
      }
    } finally {
      this.dispatching = false;
      trackMetric({
        name: "scheduler.dispatch_cycle_ms",
        value: Date.now() - cycleStart,
        properties: { service: "scheduler" },
      });
      if (totalDispatched > 0) {
        trackMetric({
          name: "scheduler.requests_dispatched",
          value: totalDispatched,
          properties: { service: "scheduler" },
        });
      }
    }
  }

  private async refreshRegistry(): Promise<void> {
    const agents = await this.agentCollection.find({}).toArray();
    const nextAgents = new Map(agents.map((agent) => [agent._id, agent]));
    const grouped = new Map<
      string,
      { agentVersion: string; queueName: string; workerTypes: Set<string> }
    >();

    for (const agent of agents) {
      for (const version of agent.versions ?? []) {
        if (version.status !== "active") continue;
        const resolved = resolveAgentTarget(agent, agent._id, {
          requestedVersion: version.agentVersion,
        });
        if ("error" in resolved) continue;

        const key = `${resolved.queueName}\u0000${resolved.agentVersion}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.workerTypes.add(agent._id);
        } else {
          grouped.set(key, {
            agentVersion: resolved.agentVersion,
            queueName: resolved.queueName,
            workerTypes: new Set([agent._id]),
          });
        }
      }
    }

    const nextTargets: RegistryTarget[] = [];
    for (const target of grouped.values()) {
      try {
        let queueClient = this.queueClients.get(target.queueName);
        if (!queueClient) {
          queueClient = this.createQueueClient(target.queueName);
          await queueClient.createIfNotExists();
          this.queueClients.set(target.queueName, queueClient);
          console.log(`[Scheduler] Ensured discovered queue exists: ${target.queueName}`);
        }
        nextTargets.push({
          agentVersion: target.agentVersion,
          queueName: target.queueName,
          workerTypes: [...target.workerTypes].sort(),
          queueClient,
          targetQueueDepth: this.targetQueueDepth,
        });
      } catch (error) {
        console.error(
          `[Scheduler] Cannot initialize queue=${target.queueName} version=${target.agentVersion}; matching requests will remain pending:`,
          error,
        );
      }
    }

    nextTargets.sort((a, b) =>
      `${a.queueName}\u0000${a.agentVersion}`.localeCompare(
        `${b.queueName}\u0000${b.agentVersion}`,
      ),
    );
    this.agents = nextAgents;
    this.targets = nextTargets;
    this.lastRegistryRefreshAt = Date.now();
    console.log(
      `[Scheduler] Refreshed agent registry: ${agents.length} agents, ${nextTargets.length} routable queue/version targets`,
    );
  }

  private async logInvalidPendingTargets(): Promise<void> {
    const pending = await this.collection
      .find(
        {
          "run.status": "pending",
          deletedAt: { $exists: false },
        },
        { projection: { workerType: 1, agentVersion: 1 } },
      )
      .limit(this.invalidTargetScanLimit)
      .toArray();

    const seen = new Set<string>();
    for (const request of pending) {
      const version = request.agentVersion;
      const key = `${request.workerType}\u0000${version ?? "<missing>"}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let reason: string | undefined;
      if (!version) {
        reason =
          "request does not specify agentVersion; re-submit it against an active registered version";
      } else {
        const resolved = resolveAgentTarget(
          this.agents.get(request.workerType),
          request.workerType,
          { requestedVersion: version },
        );
        if ("error" in resolved) {
          reason = resolved.error;
        }
      }

      if (!reason) {
        this.invalidTargetReasons.delete(key);
        continue;
      }
      if (this.invalidTargetReasons.get(key) !== reason) {
        console.warn(
          `[Scheduler] Pending requests for worker="${request.workerType}" agentVersion="${version ?? "<missing>"}" cannot be routed: ${reason}. Register an available, non-deleted agent with an active version and explicit queueName.`,
        );
        this.invalidTargetReasons.set(key, reason);
      }
    }

    for (const key of this.invalidTargetReasons.keys()) {
      if (!seen.has(key)) this.invalidTargetReasons.delete(key);
    }
  }

  private async dispatchForTarget(target: RegistryTarget): Promise<number> {
    const properties = await target.queueClient.getProperties();
    const currentDepth = properties.approximateMessagesCount ?? 0;
    const slots = target.targetQueueDepth - currentDepth;
    if (slots <= 0) return 0;

    let dispatched = 0;
    for (let i = 0; i < slots; i++) {
      const workerFilter =
        target.workerTypes.length === 1
          ? target.workerTypes[0]
          : { $in: target.workerTypes };
      const claimed = await this.collection.findOneAndUpdate(
        {
          "run.status": "pending",
          workerType: workerFilter,
          agentVersion: target.agentVersion,
          deletedAt: { $exists: false },
        },
        {
          $set: {
            "run.status": "queued",
            "run.updatedAt": new Date(),
          },
        },
        {
          sort: { priority: -1, createdAt: 1 },
          returnDocument: "after",
        },
      );

      if (!claimed) break;
      dispatched++;
      console.log(
        `[Scheduler] queue=${target.queueName} version=${target.agentVersion}: dispatched ${claimed._id} (priority=${claimed.priority}, depth=${currentDepth + i + 1}/${target.targetQueueDepth})`,
      );

      const message = Buffer.from(
        JSON.stringify({
          requestId: claimed._id,
          runId: claimed.run?._id,
        }),
      ).toString("base64");
      await target.queueClient.sendMessage(message);
    }
    return dispatched;
  }
}
