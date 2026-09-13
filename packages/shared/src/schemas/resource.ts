// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/**
 * Interpreter a resource's lifecycle scripts are written for.
 *
 * Only "sh" is executed today. Keyed by interpreter rather than assumed so that
 * adding "powershell" for the Windows worker is additive, not breaking.
 */
export const ResourceInterpreterSchema = z.enum(["sh"]);

/**
 * One lifecycle phase body, keyed by interpreter. At least one entry required —
 * an empty phase would silently do nothing.
 */
export const ResourceScriptSchema = z
  .object({
    sh: z.string().min(1).optional(),
  })
  .refine((v) => Object.values(v).some((body) => typeof body === "string" && body.length > 0), {
    message: "at least one interpreter body must be provided",
  })
  .openapi("ResourceScript");

/**
 * Exported names must be valid shell environment variable names, because they
 * are published as `KEY=VALUE` lines and merged into the agent's environment.
 */
const ExportNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
  message: "must be a valid environment variable name",
});

/**
 * Create a resource. The first revision is created atomically with it, so a
 * resource can never exist without a lifecycle to run.
 */
export const CreateResourceInputSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
    description: z.string().optional(),
    setup: ResourceScriptSchema,
    teardown: ResourceScriptSchema.optional(),
    exports: z.array(ExportNameSchema).optional(),
    creator: z.string().optional(),
  })
  .openapi("CreateResourceInput");

/**
 * Update the resource's mutable identity only.
 *
 * Script bodies and exports are deliberately absent: they live on immutable
 * revisions, and changing them means creating a new revision.
 */
export const UpdateResourceInputSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .openapi("UpdateResourceInput");

/**
 * Create a new revision of an existing resource.
 *
 * Deduplicates against the resource's *latest* revision only: a body identical
 * to the current latest reuses it rather than inflating the revision number.
 * This mirrors the codebase resolver, which compares against `getLatest()`
 * rather than doing a global content-addressed lookup.
 */
export const CreateResourceRevisionInputSchema = z
  .object({
    setup: ResourceScriptSchema,
    teardown: ResourceScriptSchema.optional(),
    exports: z.array(ExportNameSchema).optional(),
    creator: z.string().optional(),
  })
  .openapi("CreateResourceRevisionInput");

export const ResourceResponseSchema = z
  .object({
    _id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string().optional(),
    revisionCounter: z.number(),
    latestRevisionId: z.string().optional(),
    latestRevisionNumber: z.number().optional(),
    creator: z.string().optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
    projectId: z.string(),
  })
  .openapi("ResourceResponse");

/**
 * A revision on the wire.
 *
 * There is no `updatedAt` because revisions are never edited, and no
 * `deletedAt` because the cascade flag is an internal housekeeping detail —
 * id/ref lookups resolve soft-deleted revisions so historical runs stay
 * explainable.
 */
export const ResourceRevisionResponseSchema = z
  .object({
    _id: z.string(),
    resourceId: z.string(),
    slug: z.string(),
    revisionNumber: z.number(),
    ref: z.string(),
    setup: ResourceScriptSchema,
    teardown: ResourceScriptSchema.optional(),
    exports: z.array(z.string()),
    contentSha256: z.string(),
    creator: z.string().optional(),
    createdAt: z.coerce.date(),
    /**
     * True when this revision was reused (deduplicated) because the submitted
     * bodies matched the current latest, rather than newly created. Only set on
     * create responses; absent when listing/fetching revisions.
     */
    deduplicated: z.boolean().optional(),
    projectId: z.string(),
  })
  .openapi("ResourceRevisionResponse");
