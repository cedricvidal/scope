# Resources Architecture

Resources are first-class lifecycle definitions that make external dependencies available to a run (for example, a simulator container). They mirror codebases: a mutable `resources` identity document owns an immutable, sequential `resource-revisions` history. Runtime execution is pinned to revision ids so historical runs remain explainable after the resource changes.

## Data model

- **Resource** — `_id` UUID, immutable `projectId`, project-scoped `slug`, display `name`, optional `description`, `revisionCounter`, `latestRevisionId` / `latestRevisionNumber`, creator/timestamps, and optional `deletedAt`.
- **ResourceRevision** — `_id` UUID, `resourceId`, `projectId`, denormalized `slug`, incremental `revisionNumber`, canonical `ref` (`{slug}@r{revisionNumber}`), normalized `setup` / `teardown` scripts, exported environment names, `contentSha256`, creator, `createdAt`, and optional `deletedAt`.

Revision numbers are allocated by atomically `$inc`-ing `resources.revisionCounter`; the latest pointer update is guarded by `latestRevisionNumber` so a slower concurrent writer cannot regress it. The authoritative latest lookup still sorts revisions by `revisionNumber`.

## Deduplication and immutability

A create/update of lifecycle content never edits an existing revision. `ResourceResolver` normalizes setup, teardown, and exports, hashes them into `contentSha256`, and deduplicates against the **latest revision only**. If the submitted lifecycle matches the current latest, the API returns that revision with `deduplicated: true`; if it matches an older revision but not the latest, a new revision is created. The check is best-effort rather than transactional, matching codebases: rare concurrent duplicate revisions are accepted instead of adding a content-unique index.

Deletion is soft and cascading. `DELETE /api/v1/resources/:id` sets `deletedAt` on the resource and its revisions. Listings exclude soft-deleted documents, but direct revision id/ref/number lookups still resolve them so run history remains explainable.

## REST API and CLI

Routes live in `apps/api/src/routes/resources.ts`:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/resources` | List non-deleted resources for `?projectId=` |
| `POST` | `/api/v1/resources` | Create a resource and its first revision atomically (rollback on revision failure) |
| `GET` | `/api/v1/resources/:id` | Fetch by resource id or project-scoped slug |
| `PATCH` | `/api/v1/resources/:id` | Update mutable metadata only |
| `DELETE` | `/api/v1/resources/:id` | Soft-delete resource and cascade to revisions |
| `GET` | `/api/v1/resources/:id/revisions` | List non-deleted revisions for a resource |
| `POST` | `/api/v1/resources/:id/revisions` | Create a new immutable revision or deduplicate against latest |
| `GET` | `/api/v1/resources/:id/revisions/latest` | Fetch latest non-deleted revision |
| `GET` | `/api/v1/resources/:id/revisions/:revisionNumber` | Fetch a revision number under a resource |
| `GET` | `/api/v1/resources/revisions/:id` | Fetch a revision by UUID |

No PATCH, PUT, or DELETE route exists for revisions. The CLI exposes `scope resource list|get|create|update|delete|revisions` and forwards `projectId` on every API call.

## Indexes

Migration `029-create-resource-indexes.ts` creates:

| Collection | Index | Purpose |
|------------|-------|---------|
| `resources` | `{ projectId: 1, slug: 1 }` unique-or-Cosmos-fallback | Scoped slug lookup and duplicate guard |
| `resources` | `{ projectId: 1 }`, `{ createdAt: -1 }`, `{ deletedAt: 1 }` | Project listings and active filters |
| `resource-revisions` | `{ projectId: 1, ref: 1 }` unique-or-Cosmos-fallback | Scoped ref lookup and duplicate guard |
| `resource-revisions` | `{ resourceId: 1 }`, `{ resourceId: 1, revisionNumber: -1 }` | Revision listing/latest lookups |

On Cosmos DB the unique indexes may degrade to non-unique lookup indexes, so the API performs explicit same-project duplicate checks for both resource slugs and revision refs.
