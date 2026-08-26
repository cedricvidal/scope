// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueClient } from "@azure/storage-queue";
import type { Collection } from "mongodb";
import type { CodingAgentDocument, RequestDocument } from "shared";
import { RequestScheduler } from "./request-scheduler.js";

function makeQueueClient(approximateMessagesCount = 0) {
  return {
    createIfNotExists: vi.fn().mockResolvedValue({}),
    getProperties: vi.fn().mockResolvedValue({ approximateMessagesCount }),
    sendMessage: vi.fn().mockResolvedValue({}),
  };
}

function makeAgent(
  id: string,
  options: {
    version?: string;
    queueName?: string;
    status?: "active" | "retired";
    available?: boolean;
    deletedAt?: Date;
  } = {},
): CodingAgentDocument {
  const version = options.version ?? `${id}-1.0.0`;
  return {
    _id: id,
    name: id,
    supportedModels: [],
    available: options.available ?? true,
    versions: [{
      agentVersion: version,
      workerVersion: `${version}-build`,
      components: {},
      gitCommit: "abc1234",
      buildTime: "20260825T000000Z",
      imageTag: `${version}-build`,
      queueName:
        options.queueName === undefined
          ? `custom-${id}-queue`
          : options.queueName,
      status: options.status ?? "active",
      createdAt: new Date(),
    }],
    createdAt: new Date(),
    ...(options.deletedAt ? { deletedAt: options.deletedAt } : {}),
  };
}

function makeRequest(
  id: string,
  workerType = "agent-a",
  agentVersion = "agent-a-1.0.0",
): RequestDocument {
  return {
    _id: id,
    projectId: "project",
    scenario: { task: "test", criteria: ["c1"] },
    workerType,
    agentVersion,
    createdAt: new Date(),
    priority: 0,
    run: { _id: `run-${id}`, attemptNumber: 1, status: "pending" },
  };
}

function makeRequestCollection(
  pending: RequestDocument[],
  claimed: RequestDocument[] = pending,
) {
  const remaining = [...claimed];
  const cursor = {
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(pending),
  };
  return {
    find: vi.fn().mockReturnValue(cursor),
    findOneAndUpdate: vi.fn().mockImplementation(async (filter: {
      workerType: string | { $in: string[] };
      agentVersion: string;
    }) => {
      const workerTypes =
        typeof filter.workerType === "string"
          ? [filter.workerType]
          : filter.workerType.$in;
      const index = remaining.findIndex(
        (request) =>
          workerTypes.includes(request.workerType) &&
          request.agentVersion === filter.agentVersion,
      );
      if (index === -1) return null;
      return remaining.splice(index, 1)[0];
    }),
  } as unknown as Collection<RequestDocument>;
}

function makeAgentCollection(getAgents: () => CodingAgentDocument[]) {
  return {
    find: vi.fn().mockImplementation(() => ({
      toArray: vi.fn().mockImplementation(async () => getAgents()),
    })),
  } as unknown as Collection<CodingAgentDocument>;
}

function schedulerHarness(
  requests: RequestDocument[],
  getAgents: () => CodingAgentDocument[],
  queueDepth = 0,
) {
  const collection = makeRequestCollection(requests);
  const queues = new Map<string, ReturnType<typeof makeQueueClient>>();
  const factory = vi.fn((queueName: string) => {
    const queue = makeQueueClient(queueDepth);
    queues.set(queueName, queue);
    return queue as unknown as QueueClient;
  });
  const scheduler = new RequestScheduler(
    collection,
    makeAgentCollection(getAgents),
    factory,
    {
      registryRefreshIntervalMs: 1_000,
      targetQueueDepth: 3,
    },
  );
  return { scheduler, collection, queues, factory };
}

async function dispatch(scheduler: RequestScheduler): Promise<void> {
  await (
    scheduler as unknown as { dispatch(): Promise<void> }
  ).dispatch();
}

describe("RequestScheduler registry discovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes by the registered queue name and exact agent version", async () => {
    const request = makeRequest("r1");
    const { scheduler, collection, queues, factory } = schedulerHarness(
      [request],
      () => [makeAgent("agent-a", { queueName: "not-derived-from-id" })],
    );

    await dispatch(scheduler);

    expect(factory).toHaveBeenCalledWith("not-derived-from-id");
    expect(queues.get("not-derived-from-id")?.sendMessage).toHaveBeenCalledOnce();
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      {
        "run.status": "pending",
        workerType: "agent-a",
        agentVersion: "agent-a-1.0.0",
        deletedAt: { $exists: false },
      },
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("discovers newly registered targets without restart", async () => {
    let agents = [makeAgent("agent-a")];
    const requests = [
      makeRequest("r1"),
      makeRequest("r2", "agent-b", "agent-b-1.0.0"),
    ];
    const { scheduler, factory } = schedulerHarness(requests, () => agents);

    await dispatch(scheduler);
    agents = [...agents, makeAgent("agent-b", { queueName: "queue-b" })];
    await new Promise((resolve) => setTimeout(resolve, 1_010));
    await dispatch(scheduler);

    expect(factory).toHaveBeenCalledWith("queue-b");
  });

  it("fails closed when a registry refresh fails", async () => {
    let failRefresh = false;
    const getAgents = () => {
      if (failRefresh) throw new Error("registry unavailable");
      return [makeAgent("agent-a")];
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { scheduler, queues } = schedulerHarness(
      [makeRequest("r1")],
      getAgents,
    );

    await (
      scheduler as unknown as { refreshRegistry(): Promise<void> }
    ).refreshRegistry();
    failRefresh = true;
    (
      scheduler as unknown as { lastRegistryRefreshAt: number }
    ).lastRegistryRefreshAt = 0;
    await dispatch(scheduler);

    expect(queues.get("custom-agent-a-queue")?.sendMessage).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("dispatch is paused"),
      expect.any(Error),
    );
  });

  it("deduplicates agents sharing the same queue and version", async () => {
    const agents = [
      makeAgent("agent-a", { version: "shared-1", queueName: "shared-queue" }),
      makeAgent("agent-b", { version: "shared-1", queueName: "shared-queue" }),
    ];
    const request = makeRequest("r1", "agent-a", "shared-1");
    const { scheduler, collection, factory } = schedulerHarness(
      [request],
      () => agents,
    );

    await dispatch(scheduler);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        workerType: { $in: ["agent-a", "agent-b"] },
        agentVersion: "shared-1",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it.each([
    ["missing agent", [], makeRequest("r1")],
    [
      "unavailable agent",
      [makeAgent("agent-a", { available: false })],
      makeRequest("r1"),
    ],
    [
      "deleted agent",
      [makeAgent("agent-a", { deletedAt: new Date() })],
      makeRequest("r1"),
    ],
    [
      "retired version",
      [makeAgent("agent-a", { status: "retired" })],
      makeRequest("r1"),
    ],
    [
      "empty queue",
      [makeAgent("agent-a", { queueName: " " })],
      makeRequest("r1"),
    ],
  ])("keeps pending requests with %s and logs why", async (
    _name,
    agents,
    request,
  ) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { scheduler, collection, factory } = schedulerHarness(
      [request],
      () => agents as CodingAgentDocument[],
    );

    await dispatch(scheduler);

    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot be routed"),
    );
  });

  it("does not claim a pending request without agentVersion", async () => {
    const request = makeRequest("r1", "agent-a");
    delete request.agentVersion;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { scheduler, collection, queues } = schedulerHarness(
      [request],
      () => [makeAgent("agent-a")],
    );

    await dispatch(scheduler);

    expect(collection.findOneAndUpdate).toHaveBeenCalled();
    expect(
      [...queues.values()].some(
        (queue) => queue.sendMessage.mock.calls.length > 0,
      ),
    ).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("does not specify agentVersion"),
    );
  });

  it("respects the configured target queue depth", async () => {
    const { scheduler, collection } = schedulerHarness(
      [makeRequest("r1")],
      () => [makeAgent("agent-a")],
      3,
    );

    await dispatch(scheduler);

    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
