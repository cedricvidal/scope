// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { apiRoute } from "../../openapi/api-route.js";
import type { RouteContext } from "../../route-context.js";
import { resolveRunForRequest } from "./resolve-run.js";

const TaxonomyEvaluationReferenceSchema = z
  .object({
    url: z.string(),
    schemaVersion: z.string(),
    contentSha256: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .openapi("TaxonomyEvaluationReference");

async function enabled(ctx: RouteContext): Promise<boolean> {
  return Boolean(
    await ctx.featureFlagCollection.findOne({
      key: "taxonome",
      enabled: true,
    }),
  );
}

/** Registers exact-run Taxonome result metadata and stable blob proxy routes. */
export function registerRequestsTaxonomyEvaluationRoutes(
  ctx: RouteContext,
): void {
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/requests/:id/runs/:runId/taxonomy-evaluation",
    tags: ["Requests"],
    summary: "Get the exact-run Taxonome result reference",
    response: TaxonomyEvaluationReferenceSchema,
    handler: async (req, res, next) => {
      try {
        if (!(await enabled(ctx))) {
          res.status(404).json({ error: "Taxonome is not enabled" });
          return;
        }
        const resolved = await resolveRunForRequest(
          ctx,
          req.params.id,
          req.params.runId,
        );
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        if (!resolved.run.taxonomyEvaluation) {
          res.status(404).json({ error: "Taxonomy evaluation not available" });
          return;
        }
        res.json(resolved.run.taxonomyEvaluation);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/requests/:id/runs/:runId/taxonomy-evaluation/content",
    tags: ["Requests"],
    summary: "Download the exact-run compressed Taxonome result",
    response: z.any(),
    rawResponse: true,
    handler: async (req, res, next) => {
      try {
        if (!(await enabled(ctx))) {
          res.status(404).json({ error: "Taxonome is not enabled" });
          return;
        }
        const resolved = await resolveRunForRequest(
          ctx,
          req.params.id,
          req.params.runId,
        );
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const reference = resolved.run.taxonomyEvaluation;
        if (!reference) {
          res.status(404).json({ error: "Taxonomy evaluation not available" });
          return;
        }
        const body = await ctx.blobStorage.downloadBuffer(reference.url);
        res
          .type("application/json")
          .set("Content-Encoding", "gzip")
          .set(
            "Content-Disposition",
            `attachment; filename="taxonomy-${req.params.runId}.json.gz"`,
          )
          .send(body);
      } catch (error) {
        next(error);
      }
    },
  });
}
