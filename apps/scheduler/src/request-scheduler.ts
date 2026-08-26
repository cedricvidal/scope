// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { QueueClient } from "@azure/storage-queue";
import type { Collection } from "mongodb";
import { withRetry, type CodingAgentDocument, type RequestDocument } from "shared";
import { trackEvent, trackMetric } from "telemetry";

export type QueueClientFactory = (queueName: string) => QueueClient;

export interface RequestSchedulerOptions {
  pollIntervalMs?: number;
  targetQueueDepth?: number;
  invalidTargetReportIntervalMs?: number;
}

interface RegistryTarget {
  workerType: string;
  agentVersion: string;
  queueName: string;
}

interface QueueTarget {
  queueName: string;
  targets: RegistryTarget[];
}

/**
 * Dispatch pending requests exclusively through active targets advertised by
 * the agent registry. The registry is refreshed every cycle, so registrations,
 * availability changes, version changes, and queue changes take effect without
 * restarting the scheduler.
 */
export class RequestScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private dispatching = false;
  private readonly queueClients = new Map<string, Promise<QueueClient>>();
  private readonly nextTargetIndexByQueue = new Map<string, number>();
  private readonly pollIntervalMs: number;
  private readonly targetQueueDepth: number;
  private readonly invalidTargetReportIntervalMs: number;
  private invalidTargetSignature = "";
  private lastInvalidTargetReportAt = 0;
  private conflictingTargetKeys = new Set<string>();

  constructor(
    private readonly requestCollection: Collection<RequestDocument>,
    private readonly agentCollection: Collection<CodingAgentDocument>,
    private readonly createQueueClient: QueueClientFactory,
    options: RequestSchedulerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.targetQueueDepth = options.targetQueueDepth ?? 5;
    this.invalidTargetReportIntervalMs =
      options.invalidTargetReportIntervalMs ?? 30_000;
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
      const agents = await this.agentCollection.find({}).toArray();
      const queueTargets = this.buildQueueTargets(agents);

      for (const queueTarget of queueTargets) {
        try {
          totalDispatched += await this.dispatchForQueue(queueTarget);
        } catch (error) {
          console.error(
            `[Scheduler] Error dispatching queue "${queueTarget.queueName}":`,
            error,
          );
        }
      }

      await this.maybeReportInvalidPendingTargets(agents, queueTargets);
    } catch (error) {
      console.error("[Scheduler] Failed to refresh agent registry:", error);
      trackEvent({
        name: "scheduler.registry_refresh_failed",
        properties: { error: error instanceof Error ? error.message : String(error) },
      });
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

  private buildQueueTargets(agents: CodingAgentDocument[]): QueueTarget[] {
    const targetsByKey = new Map<string, RegistryTarget>();
    const conflictingTargetKeys = new Set<string>();

    for (const agent of agents) {
      if (agent.deletedAt || agent.available !== true) continue;

      for (const version of agent.versions ?? []) {
        const queueName = version.queueName?.trim();
        if (version.status !== "active" || !queueName) continue;

        const target: RegistryTarget = {
          workerType: agent._id,
          agentVersion: version.agentVersion,
          queueName,
        };
        const targetKey = this.targetKey(target.workerType, target.agentVersion);
        if (conflictingTargetKeys.has(targetKey)) continue;

        const existing = targetsByKey.get(targetKey);
        if (existing && existing.queueName !== queueName) {
          targetsByKey.delete(targetKey);
          conflictingTargetKeys.add(targetKey);
          continue;
        }
        targetsByKey.set(targetKey, target);
      }
    }

    this.conflictingTargetKeys = conflictingTargetKeys;
    const targetsByQueue = new Map<string, Map<string, RegistryTarget>>();

    for (const [targetKey, target] of targetsByKey) {
      const queueTargets =
        targetsByQueue.get(target.queueName) ?? new Map<string, RegistryTarget>();
      queueTargets.set(targetKey, target);
      targetsByQueue.set(target.queueName, queueTargets);
    }

    return [...targetsByQueue.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([queueName, targets]) => ({
        queueName,
        targets: [...targets.values()].sort(
          (left, right) =>
            left.workerType.localeCompare(right.workerType) ||
            left.agentVersion.localeCompare(right.agentVersion),
        ),
      }));
  }

  private async maybeReportInvalidPendingTargets(
    agents: CodingAgentDocument[],
    queueTargets: QueueTarget[],
  ): Promise<void> {
    const now = Date.now();
    if (
      now - this.lastInvalidTargetReportAt <
      this.invalidTargetReportIntervalMs
    ) {
      return;
    }
    this.lastInvalidTargetReportAt = now;

    try {
      await this.reportInvalidPendingTargets(agents, queueTargets);
    } catch (error) {
      console.error("[Scheduler] Failed to inspect invalid pending targets:", error);
      trackEvent({
        name: "scheduler.invalid_target_inspection_failed",
        properties: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async dispatchForQueue(queueTarget: QueueTarget): Promise<number> {
    const queueClient = await this.getQueueClient(queueTarget.queueName);
    const properties = await queueClient.getProperties();
    const currentDepth = properties.approximateMessagesCount ?? 0;
    const slots = this.targetQueueDepth - currentDepth;
    if (slots <= 0) return 0;

    let dispatched = 0;
    let nextTargetIndex =
      (this.nextTargetIndexByQueue.get(queueTarget.queueName) ?? 0) %
      queueTarget.targets.length;
    for (let index = 0; index < slots; index++) {
      let claimed: RequestDocument | null = null;
      for (
        let targetOffset = 0;
        targetOffset < queueTarget.targets.length;
        targetOffset++
      ) {
        const targetIndex =
          (nextTargetIndex + targetOffset) % queueTarget.targets.length;
        const target = queueTarget.targets[targetIndex];
        claimed = await this.requestCollection.findOneAndUpdate(
          {
            "run.status": "pending",
            deletedAt: { $exists: false },
            workerType: target.workerType,
            agentVersion: target.agentVersion,
          } as never,
          {
            $set: {
              "run.status": "queued",
              "run.updatedAt": new Date(),
            },
          } as never,
          {
            sort: { priority: -1, createdAt: 1 },
            returnDocument: "after",
          },
        );
        if (claimed) {
          nextTargetIndex = (targetIndex + 1) % queueTarget.targets.length;
          break;
        }
      }
      if (!claimed) break;

      const message = Buffer.from(
        JSON.stringify({
          requestId: claimed._id,
          runId: claimed.run?._id,
          workerType: claimed.workerType,
          agentVersion: claimed.agentVersion,
        }),
      ).toString("base64");

      try {
        await queueClient.sendMessage(message);
      } catch (error) {
        try {
          await withRetry(
            () =>
              this.requestCollection.updateOne(
                {
                  _id: claimed._id,
                  "run._id": claimed.run?._id,
                  "run.status": "queued",
                } as never,
                {
                  $set: {
                    "run.status": "pending",
                    "run.updatedAt": new Date(),
                  },
                } as never,
              ),
            {
              maxRetries: 5,
              baseDelayMs: 100,
              maxDelayMs: 2_000,
              isRetryable: () => true,
              onRetry: (rollbackError, attempt) => {
                console.warn(
                  `[Scheduler] Claim rollback retry ${attempt} for ${claimed?._id}:`,
                  rollbackError,
                );
              },
            },
          );
        } catch (rollbackError) {
          console.error(
            `[Scheduler] Failed to return claim ${claimed._id} to pending after queue send failure:`,
            rollbackError,
          );
          trackEvent({
            name: "scheduler.claim_rollback_failed",
            properties: {
              requestId: claimed._id,
              runId: claimed.run?._id ?? "",
              queueName: queueTarget.queueName,
              error:
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError),
            },
          });
          throw new AggregateError(
            [error, rollbackError],
            `Queue send and claim rollback both failed for ${claimed._id}`,
          );
        }
        throw error;
      }

      dispatched++;
      console.log(
        `[Scheduler] queue=${queueTarget.queueName}: dispatched ${claimed._id} ` +
          `(worker=${claimed.workerType}, version=${claimed.agentVersion}, ` +
          `priority=${claimed.priority}, depth=${currentDepth + dispatched}/${this.targetQueueDepth})`,
      );
    }

    this.nextTargetIndexByQueue.set(queueTarget.queueName, nextTargetIndex);
    return dispatched;
  }

  private async getQueueClient(queueName: string): Promise<QueueClient> {
    const existing = this.queueClients.get(queueName);
    if (existing) return existing;

    const initializing = (async () => {
      const client = this.createQueueClient(queueName);
      await client.createIfNotExists();
      console.log(`[Scheduler] Discovered queue "${queueName}" from agent registry`);
      return client;
    })();
    this.queueClients.set(queueName, initializing);

    try {
      return await initializing;
    } catch (error) {
      this.queueClients.delete(queueName);
      throw error;
    }
  }

  private async reportInvalidPendingTargets(
    agents: CodingAgentDocument[],
    queueTargets: QueueTarget[],
  ): Promise<void> {
    const validTargets = new Set(
      queueTargets.flatMap((queue) =>
        queue.targets.map((target) =>
          this.targetKey(target.workerType, target.agentVersion),
        ),
      ),
    );
    const pendingTargets = await this.requestCollection
      .aggregate<{
        _id: { workerType?: string; agentVersion?: string };
        count: number;
      }>([
        {
          $match: {
            "run.status": "pending",
            deletedAt: { $exists: false },
          },
        },
        {
          $group: {
            _id: {
              workerType: "$workerType",
              agentVersion: "$agentVersion",
            },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const agentsById = new Map(agents.map((agent) => [agent._id, agent]));
    const invalid = pendingTargets
      .filter(
        ({ _id }) =>
          !validTargets.has(
            this.targetKey(_id.workerType ?? "", _id.agentVersion ?? ""),
          ),
      )
      .map(({ _id, count }) => {
        const workerType = _id.workerType ?? "(missing)";
        const agentVersion = _id.agentVersion ?? "(missing)";
        const agent = agentsById.get(_id.workerType ?? "");
        let reason = "agent_not_found";
        if (
          this.conflictingTargetKeys.has(
            this.targetKey(_id.workerType ?? "", _id.agentVersion ?? ""),
          )
        ) {
          reason = "agent_queue_conflict";
        } else if (agent?.deletedAt) reason = "agent_deleted";
        else if (agent && agent.available !== true) reason = "agent_unavailable";
        else if (agent && !_id.agentVersion) reason = "agent_version_missing";
        else if (agent) {
          const version = (agent.versions ?? []).find(
            (candidate) => candidate.agentVersion === _id.agentVersion,
          );
          if (!version || version.status !== "active") {
            reason = "agent_version_unavailable";
          } else if (!version.queueName?.trim()) {
            reason = "agent_queue_missing";
          }
        }
        return { workerType, agentVersion, count, reason };
      })
      .sort(
        (left, right) =>
          left.workerType.localeCompare(right.workerType) ||
          left.agentVersion.localeCompare(right.agentVersion),
      );

    const signature = JSON.stringify(
      invalid.map(({ workerType, agentVersion, reason }) => ({
        workerType,
        agentVersion,
        reason,
      })),
    );
    if (signature === this.invalidTargetSignature) return;
    this.invalidTargetSignature = signature;

    for (const target of invalid) {
      console.warn(
        `[Scheduler] Leaving ${target.count} request(s) pending for invalid target ` +
          `worker=${target.workerType}, version=${target.agentVersion}: ${target.reason}`,
      );
      trackEvent({
        name: "scheduler.invalid_pending_target",
        properties: {
          workerType: target.workerType,
          agentVersion: target.agentVersion,
          reason: target.reason,
          pendingCount: String(target.count),
        },
      });
      trackMetric({
        name: "scheduler.invalid_pending_requests",
        value: target.count,
        properties: { reason: target.reason },
      });
    }
  }

  private targetKey(workerType: string, agentVersion: string): string {
    return `${workerType}\0${agentVersion}`;
  }
}
