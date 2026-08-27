// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RouteContext } from "../route-context.js";
import { registerAgentsRoutes } from "./agents.js";

extendZodWithOpenApi(z);

const activeAgent = {
  _id: "active-agent",
  name: "Active agent",
  supportedModels: [],
  createdAt: new Date("2025-01-01T00:00:00Z"),
};

const deletedAgent = {
  _id: "deleted-agent",
  name: "Deleted agent",
  supportedModels: [],
  createdAt: new Date("2025-01-01T00:00:00Z"),
  deletedAt: new Date("2025-02-01T00:00:00Z"),
};

function matches(
  document: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (
      condition &&
      typeof condition === "object" &&
      "$exists" in condition
    ) {
      return (
        Object.hasOwn(document, key) ===
        (condition as { $exists: boolean }).$exists
      );
    }
    return document[key] === condition;
  });
}

function buildApp() {
  const documents = [activeAgent, deletedAgent];
  const agentCollection = {
    find: vi.fn((filter: Record<string, unknown>) => ({
      toArray: vi.fn(async () =>
        documents.filter((document) => matches(document, filter)),
      ),
    })),
    findOne: vi.fn(async (filter: Record<string, unknown>) =>
      documents.find((document) => matches(document, filter)) ?? null,
    ),
  } as unknown as RouteContext["agentCollection"];

  const app = express();
  app.use(express.json());
  registerAgentsRoutes({
    app,
    registry: new OpenAPIRegistry(),
    agentCollection,
  } as unknown as RouteContext);
  return app;
}

describe("agent historical lookup", () => {
  it("excludes deleted agents from the list by default", async () => {
    const response = await request(buildApp()).get("/api/v1/agents");

    expect(response.status).toBe(200);
    expect(response.body.map((agent: { id: string }) => agent.id)).toEqual([
      activeAgent._id,
    ]);
  });

  it("includes deleted agents in the list when requested", async () => {
    const response = await request(buildApp()).get(
      "/api/v1/agents?includeDeleted=true",
    );

    expect(response.status).toBe(200);
    expect(response.body.map((agent: { id: string }) => agent.id)).toEqual([
      activeAgent._id,
      deletedAgent._id,
    ]);
  });

  it("retrieves a deleted agent only when requested", async () => {
    const hidden = await request(buildApp()).get(
      `/api/v1/agents/${deletedAgent._id}`,
    );
    const included = await request(buildApp()).get(
      `/api/v1/agents/${deletedAgent._id}?includeDeleted=true`,
    );

    expect(hidden.status).toBe(404);
    expect(included.status).toBe(200);
    expect(included.body).toMatchObject({
      id: deletedAgent._id,
      name: deletedAgent.name,
    });
  });

  it("returns 404 for an unknown agent when deleted agents are included", async () => {
    const response = await request(buildApp()).get(
      "/api/v1/agents/missing?includeDeleted=true",
    );

    expect(response.status).toBe(404);
  });
});
