// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { TaxonomyHandler } from "./taxonomy-handler.js";

describe("TaxonomyHandler", () => {
  it("does not initialize a prompt executor for runs without a taxonomy", async () => {
    const executorFactory = vi.fn();
    const log = vi.fn(async () => undefined);
    const handler = new TaxonomyHandler(executorFactory);

    await handler.process(
      { type: "taxonomy", requestId: "request-1", runId: "run-1" },
      {
        blobStorage: {} as never,
        collection: {
          findOne: vi.fn(async () => ({
            _id: "request-1",
            projectId: "project-1",
            scenario: { task: "Test task" },
            run: { _id: "run-1", attemptNumber: 1, status: "done" },
          })),
        } as never,
        criteriaCollection: {} as never,
        log,
      },
    );

    expect(executorFactory).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "info",
      "Run is not attached to an Experiment; skipping Taxonome",
    );
  });
});
