// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// --- Resource types ---

/**
 * Interpreter a resource's lifecycle scripts are written for.
 *
 * Only "sh" is executed today. The field is an enum rather than an implicit
 * default so that adding "powershell" for the Windows worker later is an
 * additive change instead of a breaking one.
 */
export type ResourceInterpreter = "sh";

/**
 * The body of one lifecycle phase, keyed by interpreter.
 *
 * A worker picks the entry matching its platform. A resource that is referenced
 * by a run on a platform it has no body for fails the run loudly — silently
 * skipping setup would produce a run that looks valid but has no resource.
 */
export type ResourceScript = Partial<Record<ResourceInterpreter, string>>;

/**
 * Resource reference document stored in MongoDB (`resources` collection).
 *
 * A **mutable** pointer/metadata record for a first-class resource entity: a
 * thing that must be made available for a run, together with the lifecycle that
 * provisions and releases it. A resource may be backed by a container started
 * through the Docker socket, or by something external such as a cloud database
 * — only the script bodies differ, everything downstream is identical.
 *
 * Each resource owns an immutable, incremental revision history
 * (`resource-revisions` collection). The `_id` is a fresh UUID; the human
 * `slug` is used in CLI/URLs/refs and is unique per project.
 */
export interface ResourceDocument {
  _id: string;                    // Fresh UUID
  projectId: string;              // FK → ProjectDocument._id (immutable scope)
  slug: string;                   // Unique per project, URL-safe (derived from name)
  name: string;                   // Human-readable display name
  description?: string;
  /**
   * Monotonically increasing counter used to assign each new revision's
   * `revisionNumber`. Atomically `$inc`-ed via `findOneAndUpdate` so concurrent
   * revision creates receive distinct, gap-free numbers.
   */
  revisionCounter: number;
  latestRevisionId?: string;      // Convenience pointer to the newest revision
  latestRevisionNumber?: number;  // revisionNumber of latestRevisionId; guards the pointer against stale concurrent writes
  creator?: string;               // Who created it (provenance)
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;               // Soft-delete timestamp
}

/**
 * Resource revision document stored in MongoDB (`resource-revisions` collection).
 *
 * An **immutable** snapshot of a resource's lifecycle. Everything that affects
 * execution — the script bodies and the exported names — lives here rather than
 * on the mutable parent, so a run pinned to a revision stays reproducible after
 * the resource is edited.
 *
 * There is deliberately no `updatedAt`: revisions are created and read, never
 * edited. Editing a resource creates a new revision.
 *
 * The canonical ref is `"{slug}@r{revisionNumber}"`.
 */
export interface ResourceRevisionDocument {
  _id: string;                    // Fresh UUID (one per revision)
  resourceId: string;             // FK → ResourceDocument._id
  projectId: string;              // FK → ProjectDocument._id (denormalized from resource)
  slug: string;                   // Denormalized parent slug (for ref building/lookup)
  revisionNumber: number;         // Sequential per resource (1,2,3…)
  ref: string;                    // Canonical display ref: "{slug}@r{revisionNumber}"

  /** Provisions the resource and publishes its connection details. Required. */
  setup: ResourceScript;
  /** Releases the resource. Optional, but omitting it leaks whatever setup created. */
  teardown?: ResourceScript;
  /**
   * Names this revision's setup phase promises to publish (e.g. "SIMULATOR_URL").
   *
   * Declaring them lets the API reject an MCP server referencing `${MCP_URL}`
   * when no referenced resource provides it, and lets the worker fail with the
   * missing name rather than registering a server with an unsubstituted
   * placeholder.
   */
  exports: string[];

  /**
   * SHA-256 over the normalized script bodies and exports. Provenance, and the
   * key used to detect that a save is identical to the current latest revision.
   * Not part of the ref or `_id`.
   */
  contentSha256: string;

  // Housekeeping
  creator?: string;               // Who created the revision (provenance)
  createdAt: Date;
  /**
   * Soft-delete timestamp. Set when the parent resource is soft-deleted
   * (cascade). Revisions are never hard-deleted in normal operation so that
   * runs referencing this revision keep resolving; lookups by id/ref/number
   * intentionally ignore this flag, while listings exclude soft-deleted.
   */
  deletedAt?: Date;
}

/**
 * Resolved resource configuration passed to workers at runtime.
 *
 * Contains the minimal information needed to run the lifecycle phases and to
 * validate what the setup phase published.
 */
export interface ResourceConfig {
  ref: string;                    // Revision ref ("{slug}@r{revisionNumber}")
  resourceId: string;
  revisionId: string;             // ResourceRevisionDocument._id
  slug: string;
  name: string;
  setup: ResourceScript;
  teardown?: ResourceScript;
  exports: string[];
}

/**
 * Outcome of one resource's lifecycle within a run.
 *
 * Persisted on the run so that a run which ended up without the environment it
 * asked for is distinguishable after the fact, not only in the live log.
 */
export interface ResourceRunOutcome {
  /** Revision ref the run was pinned to, e.g. "github-simulator@r2". */
  ref: string;
  slug: string;
  revisionId: string;
  /** Whether the setup phase completed and published its declared exports. */
  setupSucceeded: boolean;
  /** Names actually published. Empty when setup failed before publishing. */
  published: string[];
  setupDurationMs?: number;
  /** Present when setup failed; the message the run failed with. */
  error?: string;
  /** Whether a teardown phase ran. Teardown is best-effort, so a false here
   *  with a teardown body defined means cleanup did not complete. */
  teardownRan?: boolean;
}
