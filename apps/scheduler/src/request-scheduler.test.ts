// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueClient } from "@azure/storage-queue";
import type { Collection } from "mongodb";
import type { CodingAgentDocument, RequestDocument } from "shared";
import { AgentTargetRegistry } from "./agent-target-registry.js";
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
        options.queueName === undefined ? "shared-queue" : options.queueName,
      status: options.status ?? "active",
      createdAt: new Date(),
    }],
    createdAt: new Date(),
    ...(options.deletedAt ? { deletedAt: options.deletedAt } : {}),
  };
}

function makeRequest(
  id: string,
  workerType: string,
  agentVersion: string,
  priority = 0,
  createdAt = new Date(),
): RequestDocument {
  return {
    _id: id,
    projectId: "project",
    scenario: { task: "test", criteria: ["c1"] },
    workerType,
    agentVersion,
    createdAt,
    priority,
    run: { _id: `run-${id}`, attemptNumber: 1, status: "pending" },
  };
}

function matchesRoute(
  request: RequestDocument,
  route: Record<string, unknown>,
): boolean {
  return request.workerType === route.workerType &&
    request.agentVersion === route.agentVersion;
}

function applyUpdate(
  request: RequestDocument,
  update: {
    $set?: Record<string, unknown>;
    $unset?: Record<string, unknown>;
  },
): void {
  for (const [path, value] of Object.entries(update.$set ?? {})) {
    if (path.startsWith("run.")) {
      (request.run as unknown as Record<string, unknown>)[path.slice(4)] = value;
    } else {
      (request as unknown as Record<string, unknown>)[path] = value;
    }
  }
  for (const path of Object.keys(update.$unset ?? {})) {
    if (path.startsWith("run.")) {
      delete (request.run as unknown as Record<string, unknown>)[path.slice(4)];
    } else {
      delete (request as unknown as Record<string, unknown>)[path];
    }
  }
}

function makeRequestCollection(requests: RequestDocument[]) {
  const findCursor = {
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockImplementation(async () =>
      requests.filter((request) => request.run?.status === "pending")
    ),
  };
  const collection = {
    find: vi.fn().mockReturnValue(findCursor),
    findOne: vi.fn().mockImplementation(async (
      filter: Record<string, unknown>,
      options?: { sort?: Record<string, number> },
    ) => {
      if (typeof filter._id === "string") {
        return requests.find((request) =>
          request._id === filter._id &&
          request.run?.status === filter["run.status"] &&
          (request.run as unknown as Record<string, unknown>)?.dispatchToken ===
            filter["run.dispatchToken"]
        ) ?? null;
      }
      const routes = (filter.$or as Record<string, unknown>[] | undefined) ?? [];
      const candidates = requests.filter((request) =>
        request.run?.status === "pending" &&
        routes.some((route) => matchesRoute(request, route))
      );
      if (options?.sort?.priority === -1) {
        candidates.sort((a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) ||
          a.createdAt.getTime() - b.createdAt.getTime()
        );
      }
      return candidates[0] ?? null;
    }),
    findOneAndUpdate: vi.fn().mockImplementation(async (
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> },
    ) => {
      const request = requests
        .filter((candidate) =>
          candidate.run?.status === "pending" &&
          matchesRoute(candidate, filter) &&
          (
            typeof filter.priority === "number"
              ? candidate.priority === filter.priority
              : candidate.priority === undefined
          )
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      if (!request) return null;
      const before = structuredClone(request);
      applyUpdate(request, update);
      return before;
    }),
    updateOne: vi.fn().mockImplementation(async (
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> },
    ) => {
      const request = requests.find((candidate) =>
        candidate._id === filter._id &&
        candidate.run?._id === filter["run._id"] &&
        (
          filter["run.status"] === undefined ||
          candidate.run?.status === filter["run.status"]
        ) &&
        (
          filter["run.dispatchToken"] === undefined ||
          (candidate.run as unknown as Record<string, unknown>)?.dispatchToken ===
            filter["run.dispatchToken"]
        )
      );
      if (!request) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(request, update);
      return { matchedCount: 1, modifiedCount: 1 };
    }),
  };
  return collection as unknown as Collection<RequestDocument>;
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
  targetDepth = 3,
) {
  const collection = makeRequestCollection(requests);
  const queues = new Map<string, ReturnType<typeof makeQueueClient>>();
  const factory = vi.fn((queueName: string) => {
    const queue = makeQueueClient(queueDepth);
    queues.set(queueName, queue);
    return queue as unknown as QueueClient;
  });
  const registry = new AgentTargetRegistry(
    makeAgentCollection(getAgents),
    factory,
    targetDepth,
    0,
  );
  const scheduler = new RequestScheduler(collection, registry);
  return { scheduler, collection, queues, factory, registry };
}

async function dispatch(scheduler: RequestScheduler): Promise<void> {
  await (
    scheduler as unknown as { dispatch(): Promise<void> }
  ).dispatch();
}

function decodeMessages(queue: ReturnType<typeof makeQueueClient>) {
  return queue.sendMessage.mock.calls.map(([message]) =>
    JSON.parse(Buffer.from(message, "base64").toString("utf8")) as {
      requestId: string;
      runId: string;
      workerType: string;
      agentVersion: string;
    }
  );
}

describe("RequestScheduler dynamic routing", () => {
  afterEach(() => {
    delete process.env.SCOPE_DISPATCH_ROLLBACK_DELAY_MS;
    vi.restoreAllMocks();
  });

  it("uses the authoritative queue and emits exact target affinity", async () => {
    const request = makeRequest("r1", "agent-a", "agent-a-1.0.0");
    const { scheduler, queues, factory } = schedulerHarness(
      [request],
      () => [makeAgent("agent-a", { queueName: "not-derived" })],
    );

    await dispatch(scheduler);

    expect(factory).toHaveBeenCalledWith("not-derived");
    expect(decodeMessages(queues.get("not-derived")!)).toEqual([{
      requestId: "r1",
      runId: "run-r1",
      workerType: "agent-a",
      agentVersion: "agent-a-1.0.0",
    }]);
  });

  it("budgets and fills a shared physical queue only once", async () => {
    const requests = [
      makeRequest("r1", "agent-a", "v1"),
      makeRequest("r2", "agent-b", "v2"),
    ];
    const { scheduler, queues, factory } = schedulerHarness(
      requests,
      () => [
        makeAgent("agent-a", { version: "v1" }),
        makeAgent("agent-b", { version: "v2" }),
      ],
      2,
      3,
    );

    await dispatch(scheduler);

    const queue = queues.get("shared-queue")!;
    expect(factory).toHaveBeenCalledTimes(1);
    expect(queue.getProperties).toHaveBeenCalledTimes(1);
    expect(queue.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("claims the highest priority globally across routes", async () => {
    const requests = [
      makeRequest("low", "agent-a", "v1", 1, new Date("2026-01-01")),
      makeRequest("high", "agent-b", "v2", 10, new Date("2026-01-02")),
    ];
    const { scheduler, queues } = schedulerHarness(
      requests,
      () => [
        makeAgent("agent-a", { version: "v1" }),
        makeAgent("agent-b", { version: "v2" }),
      ],
      0,
      1,
    );

    await dispatch(scheduler);

    expect(decodeMessages(queues.get("shared-queue")!)[0].requestId).toBe("high");
  });

  it("round-robins routes within equal priority", async () => {
    const requests = [
      makeRequest("a1", "agent-a", "v1", 5),
      makeRequest("a2", "agent-a", "v1", 5),
      makeRequest("b1", "agent-b", "v2", 5),
      makeRequest("b2", "agent-b", "v2", 5),
    ];
    const { scheduler, queues } = schedulerHarness(
      requests,
      () => [
        makeAgent("agent-a", { version: "v1" }),
        makeAgent("agent-b", { version: "v2" }),
      ],
      0,
      4,
    );

    await dispatch(scheduler);

    expect(
      decodeMessages(queues.get("shared-queue")!).map(
        (message) => message.workerType,
      ),
    ).toEqual(["agent-a", "agent-b", "agent-a", "agent-b"]);
  });

  it("discovers new registry routes without restarting", async () => {
    let agents = [makeAgent("agent-a", { queueName: "queue-a" })];
    const requests = [
      makeRequest("r1", "agent-a", "agent-a-1.0.0"),
      makeRequest("r2", "agent-b", "agent-b-1.0.0"),
    ];
    const { scheduler, factory } = schedulerHarness(requests, () => agents);

    await dispatch(scheduler);
    agents = [...agents, makeAgent("agent-b", { queueName: "queue-b" })];
    await dispatch(scheduler);

    expect(factory).toHaveBeenCalledWith("queue-b");
  });

  it("fails closed when registry refresh fails", async () => {
    let failRefresh = false;
    const getAgents = () => {
      if (failRefresh) throw new Error("registry unavailable");
      return [makeAgent("agent-a")];
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const requests = [makeRequest("r1", "agent-a", "agent-a-1.0.0")];
    const { scheduler, queues } = schedulerHarness(requests, getAgents);

    await dispatch(scheduler);
    requests.push(makeRequest("r2", "agent-a", "agent-a-1.0.0"));
    failRefresh = true;
    await dispatch(scheduler);

    expect(queues.get("shared-queue")?.sendMessage).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("dispatch is paused"),
      expect.any(Error),
    );
  });

  it("keeps an unversioned request pending with an actionable warning", async () => {
    const request = makeRequest("r1", "agent-a", "agent-a-1.0.0");
    delete request.agentVersion;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { scheduler, queues } = schedulerHarness(
      [request],
      () => [makeAgent("agent-a")],
    );

    await dispatch(scheduler);

    expect(queues.get("shared-queue")?.sendMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("does not specify agentVersion"),
    );
  });

  it.each([
    ["unavailable", makeAgent("agent-a", { available: false })],
    ["deleted", makeAgent("agent-a", { deletedAt: new Date() })],
    ["retired", makeAgent("agent-a", { status: "retired" })],
    ["blank queue", makeAgent("agent-a", { queueName: " " })],
  ])("does not route an %s registry target", async (_name, agent) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { scheduler, factory } = schedulerHarness(
      [makeRequest("r1", "agent-a", "agent-a-1.0.0")],
      () => [agent],
    );

    await dispatch(scheduler);

    expect(factory).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot be routed"),
    );
  });

  it("does not retry send failure and conditionally rolls the claim back", async () => {
    process.env.SCOPE_DISPATCH_ROLLBACK_DELAY_MS = "0";
    const request = makeRequest("r1", "agent-a", "agent-a-1.0.0");
    const { scheduler, queues } = schedulerHarness(
      [request],
      () => [makeAgent("agent-a")],
      0,
      1,
    );
    const registryTargets = await (
      scheduler as unknown as { targets: AgentTargetRegistry }
    ).targets.getTargets();
    const sendMessage = queues.get("shared-queue")!.sendMessage;
    sendMessage.mockRejectedValue(new Error("queue unavailable"));

    await dispatch(scheduler);

    expect(registryTargets).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(request.run?.status).toBe("pending");
    expect(
      (request.run as unknown as Record<string, unknown>).dispatchToken,
    ).toBeUndefined();
  });
});
