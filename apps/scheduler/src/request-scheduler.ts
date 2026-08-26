// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import {
  withRetry,
  type QueueMessagePayload,
  type RequestDocument,
} from "shared";
import { trackMetric } from "telemetry";
import type {
  WorkerRoute,
  WorkerTarget,
  WorkerTargetProvider,
} from "./agent-target-registry.js";

/**
 * Dispatches pending requests in global priority order while enforcing one
 * depth budget per physical queue.
 */
export class RequestScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private dispatching = false;
  private readonly nextRouteIndex = new Map<string, number>();
  private readonly invalidTargetReasons = new Map<string, string>();

  constructor(
    private readonly collection: Collection<RequestDocument>,
    private readonly targets: WorkerTargetProvider,
    private readonly pollIntervalMs: number = 2_000,
    private readonly invalidTargetScanLimit: number = 200,
  ) {}

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
      let targets: readonly WorkerTarget[];
      try {
        targets = await this.targets.getTargets();
      } catch (error) {
        console.error(
          "[Scheduler] Failed to refresh agent registry; dispatch is paused until a successful refresh:",
          error,
        );
        return;
      }

      await this.logInvalidPendingTargets(targets);
      for (const target of targets) {
        try {
          totalDispatched += await this.dispatchForQueue(target);
        } catch (error) {
          console.error(
            `[Scheduler] Error dispatching queue=${target.queueName}:`,
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

  private async logInvalidPendingTargets(
    targets: readonly WorkerTarget[],
  ): Promise<void> {
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
    const validRoutes = new Set(
      targets.flatMap((target) =>
        target.routes.map(
          (route) => `${route.workerType}\u0000${route.agentVersion}`,
        ),
      ),
    );

    const seen = new Set<string>();
    for (const request of pending) {
      const version = request.agentVersion;
      const key = `${request.workerType}\u0000${version ?? "<missing>"}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const reason = !version
        ? "request does not specify agentVersion; re-submit it against an active registered version"
        : validRoutes.has(key)
          ? undefined
          : "no available, non-deleted agent exposes that active version with an explicit queueName";
      if (!reason) {
        this.invalidTargetReasons.delete(key);
        continue;
      }
      if (this.invalidTargetReasons.get(key) !== reason) {
        console.warn(
          `[Scheduler] Pending requests for worker="${request.workerType}" agentVersion="${version ?? "<missing>"}" cannot be routed: ${reason}.`,
        );
        this.invalidTargetReasons.set(key, reason);
      }
    }

    for (const key of this.invalidTargetReasons.keys()) {
      if (!seen.has(key)) this.invalidTargetReasons.delete(key);
    }
  }

  private async dispatchForQueue(target: WorkerTarget): Promise<number> {
    const properties = await target.queueClient.getProperties();
    const currentDepth = properties.approximateMessagesCount ?? 0;
    const slots = target.targetQueueDepth - currentDepth;
    if (slots <= 0) return 0;

    let dispatched = 0;
    for (let i = 0; i < slots; i++) {
      const claimed = await this.claimNext(target);
      if (!claimed) break;

      const payload: QueueMessagePayload = {
        requestId: claimed.document._id,
        runId: claimed.document.run?._id,
        workerType: claimed.route.workerType,
        agentVersion: claimed.route.agentVersion,
      };
      const message = Buffer.from(JSON.stringify(payload)).toString("base64");

      try {
        // Azure Queue sends are not idempotent. Never retry an ambiguous send:
        // the worker's atomic queued→processing claim protects against a
        // response-loss duplicate, while the short delay gives a delivered
        // message a chance to claim before token-guarded rollback.
        await target.queueClient.sendMessage(message);
      } catch (error) {
        const configuredDelayMs = Number(
          process.env.SCOPE_DISPATCH_ROLLBACK_DELAY_MS,
        );
        const rollbackDelayMs =
          Number.isInteger(configuredDelayMs) &&
          configuredDelayMs >= 0 &&
          configuredDelayMs <= 10_000
            ? configuredDelayMs
            : 500;
        await new Promise((resolve) => setTimeout(resolve, rollbackDelayMs));
        await this.rollbackClaim(claimed.document, claimed.dispatchToken);
        throw error;
      }

      try {
        await withRetry(
          () => this.collection.updateOne(
            {
              _id: claimed.document._id,
              "run._id": claimed.document.run?._id,
              "run.dispatchToken": claimed.dispatchToken,
            },
            {
              $unset: {
                "run.dispatchState": "",
                "run.dispatchToken": "",
                "run.dispatchClaimedAt": "",
              },
            },
          ),
          { isRetryable: () => true },
        );
      } catch (error) {
        console.error(
          `[Scheduler] Sent ${claimed.document._id} but failed to clear its dispatch marker; the queued request remains processable:`,
          error,
        );
      }

      dispatched++;
      console.log(
        `[Scheduler] queue=${target.queueName} worker=${claimed.route.workerType} version=${claimed.route.agentVersion}: dispatched ${claimed.document._id} (priority=${claimed.document.priority}, depth=${currentDepth + dispatched}/${target.targetQueueDepth})`,
      );
    }
    return dispatched;
  }

  private routeFilter(route: WorkerRoute): Record<string, unknown> {
    return {
      workerType: route.workerType,
      agentVersion: route.agentVersion,
    };
  }

  private pendingFilter(target: WorkerTarget): Record<string, unknown> {
    return {
      "run.status": "pending",
      $or: target.routes.map((route) => this.routeFilter(route)),
      deletedAt: { $exists: false },
    };
  }

  /**
   * Select the highest priority globally, then round-robin exact routes within
   * that priority so one busy version cannot starve another.
   */
  private async claimNext(
    target: WorkerTarget,
  ): Promise<{
    document: RequestDocument;
    route: WorkerRoute;
    dispatchToken: string;
  } | null> {
    const next = await this.collection.findOne(
      this.pendingFilter(target),
      { sort: { priority: -1, createdAt: 1 }, projection: { priority: 1 } },
    );
    if (!next) return null;

    const priorityFilter = next.priority === undefined
      ? { priority: { $exists: false } }
      : { priority: next.priority };
    const start = this.nextRouteIndex.get(target.queueName) ?? 0;

    for (let offset = 0; offset < target.routes.length; offset++) {
      const routeIndex = (start + offset) % target.routes.length;
      const route = target.routes[routeIndex];
      const dispatchToken = randomUUID();
      const now = new Date();
      const claimed = await this.collection.findOneAndUpdate(
        {
          "run.status": "pending",
          deletedAt: { $exists: false },
          ...priorityFilter,
          ...this.routeFilter(route),
        },
        {
          $set: {
            "run.status": "queued",
            "run.updatedAt": now,
            "run.dispatchState": "sending",
            "run.dispatchToken": dispatchToken,
            "run.dispatchClaimedAt": now,
          },
        },
        {
          sort: { createdAt: 1 },
          returnDocument: "before",
        },
      );
      if (claimed) {
        this.nextRouteIndex.set(
          target.queueName,
          (routeIndex + 1) % target.routes.length,
        );
        return { document: claimed, route, dispatchToken };
      }
    }
    return null;
  }

  private async rollbackClaim(
    document: RequestDocument,
    dispatchToken: string,
  ): Promise<void> {
    await withRetry(
      async () => {
        await this.collection.updateOne(
          {
            _id: document._id,
            "run._id": document.run?._id,
            "run.status": "queued",
            "run.dispatchToken": dispatchToken,
          },
          {
            $set: {
              "run.status": "pending",
              "run.updatedAt": new Date(),
            },
            $unset: {
              "run.dispatchState": "",
              "run.dispatchToken": "",
              "run.dispatchClaimedAt": "",
            },
          },
        );
        const stranded = await this.collection.findOne({
          _id: document._id,
          "run._id": document.run?._id,
          "run.status": "queued",
          "run.dispatchToken": dispatchToken,
        });
        if (stranded) {
          throw new Error(
            `Dispatch rollback verification failed for ${document._id}`,
          );
        }
      },
      {
        maxRetries: 5,
        baseDelayMs: 100,
        maxDelayMs: 2_000,
        isRetryable: () => true,
      },
    );
  }
}
