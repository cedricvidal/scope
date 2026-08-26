// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingAgentDocument, RequestDocument } from "shared";
import { RequestScheduler } from "./request-scheduler.js";

function makeQueueClient(depth = 0) {
  return {
    createIfNotExists: vi.fn().mockResolvedValue({}),
    getProperties: vi.fn().mockResolvedValue({
      approximateMessagesCount: depth,
    }),
    sendMessage: vi.fn().mockResolvedValue({}),
  } as any;
}

function makeAgent(
  id: string,
  versions: Array<{
    agentVersion: string;
    queueName: string;
    status?: "active" | "retired";
  }>,
  overrides: Partial<CodingAgentDocument> = {},
): CodingAgentDocument {
  return {
    _id: id,
    name: id,
    available: true,
    supportedModels: [],
    versions: versions.map((version, index) => ({
      agentVersion: version.agentVersion,
      workerVersion: `${version.agentVersion}-build`,
      components: {},
      gitCommit: "abcdef0",
      buildTime: "20260101T000000Z",
      imageTag: `${version.agentVersion}-build`,
      queueName: version.queueName,
      status: version.status ?? "active",
      createdAt: new Date(index),
    })),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeRequest(
  id: string,
  workerType: string,
  agentVersion: string | undefined,
  priority = 0,
): RequestDocument {
  return {
    _id: id,
    projectId: "project",
    scenario: { task: "test", criteria: ["criterion"] },
    workerType,
    ...(agentVersion ? { agentVersion } : {}),
    createdAt: new Date(),
    priority,
    run: {
      _id: `run-${id}`,
      attemptNumber: 1,
      status: "pending",
    },
  } as RequestDocument;
}

function makeCollections(
  requests: RequestDocument[],
  agents: CodingAgentDocument[],
) {
  const mutableAgents = [...agents];
  const requestCollection = {
    aggregate: vi.fn().mockImplementation(() => ({
      toArray: async () => {
        const grouped = new Map<
          string,
          {
            _id: { workerType?: string; agentVersion?: string };
            count: number;
          }
        >();
        for (const request of requests.filter(
          (candidate) =>
            candidate.run?.status === "pending" && !candidate.deletedAt,
        )) {
          const key = `${request.workerType}\0${request.agentVersion ?? ""}`;
          const current = grouped.get(key);
          if (current) current.count++;
          else {
            grouped.set(key, {
              _id: {
                workerType: request.workerType,
                ...(request.agentVersion
                  ? { agentVersion: request.agentVersion }
                  : {}),
              },
              count: 1,
            });
          }
        }
        return [...grouped.values()];
      },
    })),
    findOneAndUpdate: vi.fn().mockImplementation(
      async (
        filter: {
          workerType: string;
          agentVersion: string;
        },
      ) => {
        const request = requests
          .filter((candidate) => candidate.run?.status === "pending")
          .filter(
            (candidate) =>
              filter.workerType === candidate.workerType &&
              filter.agentVersion === candidate.agentVersion,
          )
          .sort(
            (left, right) =>
              (right.priority ?? 0) - (left.priority ?? 0) ||
              left.createdAt.getTime() - right.createdAt.getTime(),
          )[0];
        if (!request?.run) return null;
        request.run.status = "queued";
        return request;
      },
    ),
    updateOne: vi.fn().mockImplementation(
      async (
        filter: { _id: string },
        update: { $set: { "run.status": string } },
      ) => {
        const request = requests.find((candidate) => candidate._id === filter._id);
        if (request?.run) {
          request.run.status = update.$set["run.status"] as "pending";
        }
        return { matchedCount: request ? 1 : 0 };
      },
    ),
  } as any;
  const agentCollection = {
    find: vi.fn().mockImplementation(() => ({
      toArray: async () => [...mutableAgents],
    })),
  } as any;

  return { requestCollection, agentCollection, mutableAgents };
}

describe("RequestScheduler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes a synthetic dynamically named worker to its advertised queue", async () => {
    const request = makeRequest(
      "request-1",
      "synthetic-worker-7f3",
      "synthetic-v9",
      50,
    );
    const { requestCollection, agentCollection } = makeCollections(
      [request],
      [
        makeAgent("synthetic-worker-7f3", [
          {
            agentVersion: "synthetic-v9",
            queueName: "custom-synthetic-queue",
          },
        ]),
      ],
    );
    const queue = makeQueueClient();
    const factory = vi.fn(() => queue);
    const scheduler = new RequestScheduler(
      requestCollection,
      agentCollection,
      factory,
      { targetQueueDepth: 3 },
    );

    await (scheduler as any).dispatch();

    expect(factory).toHaveBeenCalledWith("custom-synthetic-queue");
    expect(queue.sendMessage).toHaveBeenCalledTimes(1);
    const message = JSON.parse(
      Buffer.from(queue.sendMessage.mock.calls[0][0], "base64").toString(),
    );
    expect(message).toEqual({
      requestId: "request-1",
      runId: "run-request-1",
      workerType: "synthetic-worker-7f3",
      agentVersion: "synthetic-v9",
    });
  });

  it("refreshes registry targets without restart", async () => {
    const request = makeRequest("request-1", "late-worker", "v1");
    const { requestCollection, agentCollection, mutableAgents } =
      makeCollections([request], []);
    const queue = makeQueueClient();
    const factory = vi.fn(() => queue);
    const scheduler = new RequestScheduler(
      requestCollection,
      agentCollection,
      factory,
    );

    await (scheduler as any).dispatch();
    expect(factory).not.toHaveBeenCalled();
    expect(request.run?.status).toBe("pending");

    mutableAgents.push(
      makeAgent("late-worker", [
        { agentVersion: "v1", queueName: "late-queue" },
      ]),
    );
    await (scheduler as any).dispatch();

    expect(factory).toHaveBeenCalledWith("late-queue");
    expect(queue.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates a shared queue across workers and versions", async () => {
    const requests = [
      makeRequest("one", "worker-a", "v1", 10),
      makeRequest("two", "worker-a", "v2", 5),
      makeRequest("three", "worker-b", "v7", 1),
    ];
    const { requestCollection, agentCollection } = makeCollections(requests, [
      makeAgent("worker-a", [
        { agentVersion: "v1", queueName: "shared-queue" },
        { agentVersion: "v2", queueName: "shared-queue" },
      ]),
      makeAgent("worker-b", [
        { agentVersion: "v7", queueName: "shared-queue" },
      ]),
    ]);
    const queue = makeQueueClient();
    const factory = vi.fn(() => queue);
    const scheduler = new RequestScheduler(
      requestCollection,
      agentCollection,
      factory,
      { targetQueueDepth: 5 },
    );

    await (scheduler as any).dispatch();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(queue.getProperties).toHaveBeenCalledTimes(1);
    expect(queue.sendMessage).toHaveBeenCalledTimes(3);
    const claimCalls = requestCollection.findOneAndUpdate.mock.calls as Array<
      [
        { workerType?: string; agentVersion?: string },
        unknown,
        { returnDocument?: string },
      ]
    >;
    expect(
      claimCalls
        .filter((call) => call[2]?.returnDocument === "after")
        .slice(0, 3)
        .map((call) => ({
          workerType: call[0].workerType,
          agentVersion: call[0].agentVersion,
        })),
    ).toEqual([
      { workerType: "worker-a", agentVersion: "v1" },
      { workerType: "worker-a", agentVersion: "v2" },
      { workerType: "worker-b", agentVersion: "v7" },
    ]);
  });

  it("rotates a shared queue budget across active targets", async () => {
    const requests = [
      makeRequest("a-1", "worker-a", "v1", 100),
      makeRequest("a-2", "worker-a", "v1", 90),
      makeRequest("b-1", "worker-b", "v2", 1),
    ];
    const { requestCollection, agentCollection } = makeCollections(requests, [
      makeAgent("worker-a", [{ agentVersion: "v1", queueName: "shared" }]),
      makeAgent("worker-b", [{ agentVersion: "v2", queueName: "shared" }]),
    ]);
    const queue = makeQueueClient();
    const scheduler = new RequestScheduler(
      requestCollection,
      agentCollection,
      () => queue,
      { targetQueueDepth: 1 },
    );

    await (scheduler as any).dispatch();
    requestCollection.updateOne.mockClear();
    requests[0].run!.status = "done";
    queue.getProperties.mockResolvedValueOnce({ approximateMessagesCount: 0 });
    await (scheduler as any).dispatch();

    expect(requests[0].run?.status).toBe("done");
    expect(requests[1].run?.status).toBe("pending");
    expect(requests[2].run?.status).toBe("queued");
  });

  it("leaves a target pending when duplicate version records advertise conflicting queues", async () => {
    const request = makeRequest("conflict", "worker", "v1");
    const { requestCollection, agentCollection } = makeCollections(
      [request],
      [
        makeAgent("worker", [
          { agentVersion: "v1", queueName: "queue-a" },
          { agentVersion: "v1", queueName: "queue-b" },
        ]),
      ],
    );
    const factory = vi.fn(() => makeQueueClient());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduler = new RequestScheduler(
      requestCollection,
      agentCollection,
      factory,
    );

    await (scheduler as any).dispatch();

    expect(factory).not.toHaveBeenCalled();
    expect(request.run?.status).toBe("pending");
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "agent_queue_conflict",
    );
  });

  it("leaves invalid targets pending and emits actionable telemetry", async () => {
    const requests = [
      makeRequest("unknown", "missing-worker", "v1"),
      makeRequest("versionless", "known-worker", undefined),
      makeRequest("inactive", "known-worker", "retired"),
    ];
    const { requestCollection, agentCollection } = makeCollections(requests, [
      makeAgent("known-worker", [
        { agentVersion: "active", queueName: "known-queue" },
        {
          agentVersion: "retired",
          queueName: "known-queue",
          status: "retired",
        },
      ]),
    ]);
    const queue = makeQueueClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduler = new RequestScheduler(
      requestCollection,
      agentCollection,
      () => queue,
    );

    await (scheduler as any).dispatch();

    expect(queue.sendMessage).not.toHaveBeenCalled();
    expect(requests.every((request) => request.run?.status === "pending")).toBe(
      true,
    );
    expect(warn.mock.calls.flat().join("\n")).toContain("agent_not_found");
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "agent_version_missing",
    );
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "agent_version_unavailable",
    );
  });

  it("does not route unavailable, deleted, or queue-less registry targets", async () => {
    const requests = [
      makeRequest("unavailable", "worker-unavailable", "v1"),
      makeRequest("deleted", "worker-deleted", "v1"),
      makeRequest("queue-less", "worker-queue-less", "v1"),
    ];
    const { requestCollection, agentCollection } = makeCollections(requests, [
      makeAgent(
        "worker-unavailable",
        [{ agentVersion: "v1", queueName: "queue-a" }],
        { available: false },
      ),
      makeAgent(
        "worker-deleted",
        [{ agentVersion: "v1", queueName: "queue-b" }],
        { deletedAt: new Date() },
      ),
      makeAgent("worker-queue-less", [
        { agentVersion: "v1", queueName: "" },
      ]),
    ]);
    const factory = vi.fn(() => makeQueueClient());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduler = new RequestScheduler(
      requestCollection,
      agentCollection,
      factory,
    );

    await (scheduler as any).dispatch();

    expect(factory).not.toHaveBeenCalled();
    expect(requests.every((request) => request.run?.status === "pending")).toBe(
      true,
    );
  });

  it("returns a claim to pending when queue send fails", async () => {
    const request = makeRequest("request-1", "worker", "v1");
    const { requestCollection, agentCollection } = makeCollections(
      [request],
      [makeAgent("worker", [{ agentVersion: "v1", queueName: "queue" }])],
    );
    const queue = makeQueueClient();
    queue.sendMessage.mockRejectedValueOnce(new Error("queue unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduler = new RequestScheduler(
      requestCollection,
      agentCollection,
      () => queue,
    );

    await (scheduler as any).dispatch();

    expect(requestCollection.updateOne).toHaveBeenCalled();
    expect(request.run?.status).toBe("pending");
  });

  it("retries a transient claim rollback after queue send fails", async () => {
    const request = makeRequest("request-1", "worker", "v1");
    const { requestCollection, agentCollection } = makeCollections(
      [request],
      [makeAgent("worker", [{ agentVersion: "v1", queueName: "queue" }])],
    );
    const rollbackImplementation =
      requestCollection.updateOne.getMockImplementation();
    requestCollection.updateOne
      .mockRejectedValueOnce(new Error("transient rollback failure"))
      .mockRejectedValueOnce(new Error("transient rollback failure"))
      .mockImplementation(rollbackImplementation);
    const queue = makeQueueClient();
    queue.sendMessage.mockRejectedValueOnce(new Error("queue unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduler = new RequestScheduler(
      requestCollection,
      agentCollection,
      () => queue,
    );

    await (scheduler as any).dispatch();

    expect(requestCollection.updateOne).toHaveBeenCalledTimes(3);
    expect(request.run?.status).toBe("pending");
  });

  it("dispatches valid work when invalid-target diagnostics fail", async () => {
    const request = makeRequest("request-1", "worker", "v1");
    const { requestCollection, agentCollection } = makeCollections(
      [request],
      [makeAgent("worker", [{ agentVersion: "v1", queueName: "queue" }])],
    );
    requestCollection.aggregate.mockImplementationOnce(() => ({
      toArray: vi.fn().mockRejectedValue(new Error("diagnostics unavailable")),
    }));
    const queue = makeQueueClient();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduler = new RequestScheduler(
      requestCollection,
      agentCollection,
      () => queue,
    );

    await (scheduler as any).dispatch();

    expect(queue.sendMessage).toHaveBeenCalledTimes(1);
    expect(request.run?.status).toBe("queued");
  });

  it("respects queue depth for all targets sharing a queue", async () => {
    const requests = [
      makeRequest("one", "worker", "v1"),
      makeRequest("two", "worker", "v1"),
    ];
    const { requestCollection, agentCollection } = makeCollections(
      requests,
      [makeAgent("worker", [{ agentVersion: "v1", queueName: "queue" }])],
    );
    const queue = makeQueueClient(4);
    const scheduler = new RequestScheduler(
      requestCollection,
      agentCollection,
      () => queue,
      { targetQueueDepth: 5 },
    );

    await (scheduler as any).dispatch();

    expect(queue.sendMessage).toHaveBeenCalledTimes(1);
  });
});
