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

## Run lifecycle and ordering

A run references resources by spec (`slug`, `slug@rN`, or a revision id). The API
**pins each to a concrete revision id at submit time** and stores those on the
request, so a finished run stays explainable after the resource gains new
revisions. Resolution happens once, before the profile-variation loop, so every
variation in a grouped submission provisions an identical environment.

The worker then runs the lifecycle in a fixed order. **Each of these orderings is
load-bearing — moving one reintroduces a specific bug:**

```
docker socket available
  → purge orphan containers from a previous run
  → create workspace
  → resource setup, in reference order
  → MCP registration (with interpolation)
  → skills, AGENTS.md
  → agent turns
  → resource teardown, in reverse order
  → purge leftover containers
```

**Resource setup precedes MCP registration.** Registering a server opens a live
connection to it and throws when it is unreachable. A server backed by something
the run provisions itself could otherwise never be registered — setup failed
before the agent's first turn.

**Interpolation happens immediately before registration, after secret
hydration.** The queue processor hydrates MCP configs with plaintext secrets from
Token Manager, and that hydration *replaces* the whole `env`/`headers` object
rather than merging into it. Substituting `${VAR}` any earlier is silently
undone, which presents as "interpolation doesn't work" with nothing in the logs
to explain it.

**Teardown precedes the container purge.** The purge would otherwise destroy the
containers a teardown script is about to remove, leaving it to fail or silently
no-op.

**The orphan purge stays first.** A resource that publishes a fixed port cannot
start if a container from an earlier run is still holding it.

## Publishing connection details

A setup phase publishes values by appending `KEY=VALUE` lines to the file at
`$SCOPE_SETUP_ENV`. A file is used rather than stdout so that ordinary script
logging — `docker` progress, `curl` retries — cannot corrupt the contract. The
parser splits on the first `=` only (connection strings contain more), tolerates
CRLF, and rejects malformed lines rather than skipping them, since a dropped line
resurfaces much later as an unresolved `${VAR}` far from its cause.

Published values are used in two places:

1. **Interpolated into MCP server config** — `${VAR}` in `url`, `args`, `env`
   values and `headers[].value`. Which field carries them depends on transport:
   `command`/`args`/`env` for stdio, `url`/`headers` for http and sse. An
   unresolved placeholder fails the run and names every offender, because passing
   `${MCP_URL}` through literally fails much later inside the gateway as an
   opaque transport error.
2. **Merged into the agent's subprocess environment** — `buildSubprocessEnv`
   constructs a fixed object and never spreads `process.env`, so this is the only
   way an agent-facing tool can learn where the run's resources are.

### Choose published names carefully

Published values land in the agent's own process environment, so a name that a
tool already interprets will change that tool's behaviour.

This is not hypothetical. Publishing `GH_TOKEN` for a GitHub simulator broke the
Copilot CLI outright: the CLI reads `GH_TOKEN` in preference to `GITHUB_TOKEN`
for its *own* authentication, so it tried to authenticate against real GitHub
with the simulator's token and failed with `Authentication required` before the
first turn. A global `HTTP_PROXY` is the same class of hazard.

Prefer neutral, resource-specific names (`SIMULATOR_URL`, `SIM_TOKEN`) and let
the task prompt set tool variables inline on the commands that need them, so they
are scoped to the invocation rather than the whole agent:

```sh
GH_HOST=github.localhost GH_TOKEN="$SIM_TOKEN" HTTP_PROXY="$SIMULATOR_URL" \
  gh issue view 11 -R owner/repo
```

Resource values are spread *before* the fixed keys in `buildSubprocessEnv`, so a
resource cannot shadow `GITHUB_TOKEN` or the proxy settings that route model
traffic for capture — but it can still introduce a name the agent's tooling reads.

## Failure behaviour

- A setup phase exiting non-zero **fails the run**, and resources already
  provisioned are torn down in reverse. A partially provisioned environment must
  not leak into the next run.
- A resource that does not publish everything its revision declared in `exports`
  fails the run, naming the missing variables.
- Teardown is **best-effort**: failures are logged but do not change the run's
  outcome, because losing cleanup should not mask the result the run produced.
- Scripts run under `sh -e`, so a failing command aborts the phase instead of
  continuing into a half-provisioned state that still reports success.
- Before the first setup phase the worker checks the Docker socket and fails with
  an explicit message. Without it, a container-backed resource fails inside its
  own script with a raw `permission denied ... /var/run/docker.sock`, which reads
  like a group-ownership problem even when it is an SELinux label denial.

## Platforms

Script bodies are keyed by interpreter. Only `sh` is executed today; the shape
exists so PowerShell support for the Windows worker is additive rather than
breaking. A resource referenced by a run on a platform it has no body for fails
the run loudly — silently skipping setup would produce a run that looks valid but
has no resource.
