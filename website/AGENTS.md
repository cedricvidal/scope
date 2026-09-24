# AGENTS.md

Project context for AI coding agents working on **scope-doc**, the
Starlight-based documentation site for **Scope**.

## What this repo is

A static documentation site published to GitHub Pages.

- Framework: **Astro 6.x** + **@astrojs/starlight**
- Package manager: **pnpm** (pinned via `packageManager` in `package.json`)
- TypeScript strict
- Lives under the `website/` directory of the repo (all site sources,
  config, and `package.json` are rooted here; run every command from
  `website/`)
- Deployed by `.github/workflows/static.yml` (build + deploy jobs),
  which builds from `website/` via a `working-directory` default and
  `website/**` path filters; both PR and production builds explicitly use
  `SITE=https://microsoft.github.io` and `BASE_PATH=/scope`.
  Do not derive these from `actions/configure-pages` outputs, which can
  report an isolated hostname instead of the public project URL.
  Local development keeps localhost and `/` defaults.

## Where things live

- `src/content/docs/` — all user-facing pages (`.md` and `.mdx`)
  - `introduction/`, `getting-started/`, `guides/`, `reference/`, `resources/`
  - Sidebar order is defined in `astro.config.mjs`, not by directory order
- `src/openapi/scope-openapi.json` — committed artifact generated from
  the Scope API's OpenAPI registry; drives the auto-generated REST
  API reference
- `src/plugins/remark-http-snippets.mjs` — custom remark plugin that
  expands fenced ` ```http ` blocks into multi-language Starlight
  `<Tabs>` (curl, JS fetch, Python, Go, Java, C#)
- `src/plugins/remark-base-path.mjs`: prefixes internal Markdown URLs and
  literal MDX `href`/`src`/`poster` attributes with the configured
  deployment base
- `public/demo/scope-demo-poster.jpg`: poster frame for the front-page
  demo video (see [Front-page demo video](#front-page-demo-video))
- `astro.config.mjs` — sidebar, plugins, `markdown.remarkPlugins`,
  `starlight-openapi` config
- `dist/` — build output (gitignored)

## The source of truth: scope-core

The product itself lives in the
[scope-core](https://github.com/growth-ecosystems/scope-core)
repository. When writing docs, **read scope-core before writing any
factual claim**. Everything in the documentation \u2014 endpoints, field
names, statuses, worker IDs, behaviors, defaults, error messages,
anything \u2014 MUST be grounded in the source code. Do not invent. If
the source doesn't say it, it doesn't go in the docs; ask the user
or leave it out.

## Where to look in scope-core

Anything that comes from the source — endpoints, field names,
status enums, defaults, validation rules — must be read from
scope-core at the time you write it, not copied from this file.
Use this map as a starting point; do not treat it as a substitute
for opening the file.

| Topic | File(s) in scope-core |
| --- | --- |
| Workers (allowed IDs, validation) | `packages/shared/src/schemas/request.ts` (`VALID_WORKERS`) |
| Worker display names / labels | the `"name"` field in each worker's agent registration (upsert) payload (e.g. "GitHub Copilot CLI", "Claude Code CLI", "VS Code Copilot") |
| Worker software stacks (pre-installed tools) | `apps/workers/*/src/test-worker.ts` — the `checkTools([...])` array lists every runtime and build tool baked into the container image |
| Request payload, scenario shape | `packages/shared/src/schemas/request.ts` (`CreateRequestInputSchema`, `ScenarioSchema`) |
| Request status / outcome enums | `packages/shared/src/schemas/request.ts` (`RequestStatusSchema`, `RequestOutcomeSchema`) |
| Request lifecycle / scheduler | `apps/api/src/index.ts`, `docs/architecture/queue-scheduler.md` |
| Profile + version schemas | `packages/shared/src/schemas/profile.ts` |
| Criterion schema, DAG rules | `packages/shared/src/schemas/criteria.ts` |
| Route handlers, validation, error codes | `apps/api/src/routes/*.ts` |
| VS Code worker behavior | `docs/architecture/vscode-electron-worker.md`, `vscode-web-worker.md`, `worker-requirements.md` |
| OpenAPI source | `apps/api/src/openapi/registry.ts`; generated snapshot at `src/openapi/scope-openapi.json` |
| Swagger UI | served by the API; check `apps/api/src/index.ts` for the route |

When in doubt, `grep` scope-core for the symbol or string before
writing anything in the docs.

## Standing user rulings

These are decisions the user has made that override what the
source code might suggest. Honor them until the user says
otherwise.

### Workers we document

- `coder-acp-copilot` — GitHub Copilot via ACP
- `coder-acp-claude-code` — Anthropic Claude Code via ACP
  custom driver extension. **This is the VS Code worker we
  document.**

Copilot Chat) worker is **deprecated** — do not list it in
user-facing docs even if it still appears in `VALID_WORKERS`.

### Criteria

Criteria are **DAG-only**. There is no "flat checklist" mode in
the product. A criterion with no `dependsOn` is just a root of
the graph. Reflect this framing in every doc that mentions
criteria.

## Documentation conventions

### File extensions

- `.md` for plain Markdown.
- `.mdx` whenever the page contains JSX (e.g. uses Starlight `<Tabs>`).
- Files with ` ```http ` blocks **must** be `.mdx` because the remark
  plugin expands them into JSX.

### HTTP examples

Write a single fenced ` ```http ` block containing a raw HTTP
request. The plugin auto-generates synced curl / JS fetch / Python /
Go / Java / C# tabs at build time.

````
```http
POST /api/v1/requests
Content-Type: application/json

{ "scenario": { "task": "...", "criteria": ["..."] } }
```
````

To add languages: edit the `TARGETS` array in
`src/plugins/remark-http-snippets.mjs`.

Plain JSON examples (response shapes, profile config) stay as
` ```json ` — they're not requests.

### REST API reference page

- Link to `/reference/api/` for the generated reference landing page.
  `/reference/api/operations/` is not a page.
- **Auto-generated** per-endpoint pages live under
  `/reference/api/...` (built from
  `src/openapi/scope-openapi.json` by `starlight-openapi`).
- The hand-written `reference/rest-api.md` is a narrative overview
  with cross-links to the auto-generated pages and the live Swagger.
  Don't duplicate the per-endpoint detail there.

### Internal links

Use site-root paths such as `/getting-started/access/` in Markdown links
and literal MDX `href`/`src` attributes. The base-path remark plugin adds
`/scope` in the public build while keeping local root deployments working.
Do not hard-code the deployment prefix in content or code examples.

### Front-page demo video

The hero of `src/content/docs/index.mdx` embeds a narrated, captioned
74-second demo (1920×1080). Only the poster is committed. The video
files are **assets on the `website-demo-video-v1` GitHub release** of
`microsoft/scope`, so git history carries no large binaries:

- `scope-demo.mp4` (H.264/AAC, fast-start; listed first for Safari)
- `scope-demo.webm` (VP9/Opus)

The player is click-to-play (`preload="none"`), so page loads don't
fetch the video. Release assets are served as
`application/octet-stream` with `Content-Disposition: attachment`.
Safari, Chrome, and Edge still play and seek them in a `<video>`
element, but re-check Safari whenever the hosting changes.

The release tag must **not** start with `cli/v`. The CLI update check
and `install-cli.sh` pick the first `cli/v*` release. Always create
the release with `--latest=false` so it never becomes the repo's
"latest" release.

To preview with local copies (e.g. before the release exists), serve
the two files over HTTP with Range support and point the build at
them. Leave `PUBLIC_DEMO_VIDEO_BASE` unset in CI:

```sh
PUBLIC_DEMO_VIDEO_BASE=http://127.0.0.1:18766 pnpm run dev
```

To replace the video, re-render it (the HyperFrames source project is
not in this repo), then publish a new tag and update the
`demoVideoBase` default in `index.mdx`. Replace the poster in `public/demo/` if the opening frame
changed:

```sh
gh release create website-demo-video-v2 --repo microsoft/scope \
  --latest=false --title "Website demo video v2" \
  --notes "Front-page demo video for the documentation site." \
  scope-demo.mp4 scope-demo.webm
```

### Sidebar

Sidebar order is set in `astro.config.mjs`. Adding a new page
requires updating the sidebar array. The auto-generated REST API
groups are spread via `...openAPISidebarGroups`.

### Style

- Hard-wrap prose at ~70–80 columns for readable diffs.
- Backtick code identifiers (`workerType`, `coder-acp-copilot`,
  `POST /api/v1/requests`).
- Don't surround filenames with backticks in the rendered text — use
  a markdown link to the file when it exists in the repo.
- Terminology: **request** (what you submit), **run** (one execution
  attempt of a request), **task prompt** (de-duplicated text),
  **criterion** (single record in the criteria DAG), **profile**
  (versioned agent runtime config).

## Build, lint, test

```sh
pnpm install
pnpm test                # plugin regressions, using Node's built-in test runner
pnpm run build           # writes dist/
pnpm run dev             # local preview at http://localhost:4321
pnpm run refresh:openapi # generate the OpenAPI snapshot from scope-core
```

Both `pnpm test` and `pnpm run build` must pass. The public build uses
`SITE=https://microsoft.github.io BASE_PATH=/scope pnpm run build`;
exercise that configuration when changing links or deployment settings,
not just the local `/` default. The current snapshot produces **200
pages**, including the generated API reference. An unexpected drop in
page count can indicate a content collection file failed to parse.

## Workflow

- Each logical change is its own commit. Push to refresh the PR; CI
  rebuilds and redeploys to GH Pages.
- `main` is protected — open a PR, don't push directly.

## When in doubt

1. Read the relevant file in scope-core (schemas first, then route
   handlers).
2. Generate the OpenAPI snapshot with `pnpm run refresh:openapi` and
   inspect `src/openapi/scope-openapi.json`.
3. If the answer is still ambiguous, ask the user. The user is the
   product owner and will know intent.
4. Never invent endpoints, statuses, or field names to fill a gap —
   silence is better than a confident lie that ships.
