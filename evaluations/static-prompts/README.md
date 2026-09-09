# Static Prompt Evaluations

This workspace evaluates Scope's AI instruction surfaces. It has two independent
tracks:

- **quality** runs Scope-owned static prompt families through production
  TypeScript adapters and grades the generated JSONL with the Azure AI
  Evaluation SDK;
- **red-team** inserts cloud-generated adversarial text into reviewed
  user-controlled instruction surfaces and scans the actual composed request.

Read [the architecture and maintenance guide](../../docs/architecture/prompt-evaluations.md)
before changing adapters, datasets, rubrics, profiles, or thresholds.

## Setup

From the repository root:

```bash
pnpm install
pnpm --filter static-prompt-evals setup:python
az login
```

The setup and evaluation commands check for `uv` first. If it is unavailable,
they stop before execution and print platform-specific installation guidance
linked to Astral's official instructions.

Set the prompt-evaluation environment variables described in
[`ENV_VARIABLES.md`](../../ENV_VARIABLES.md#prompt-evaluation-configuration).
Do not put credentials or project/model endpoints in committed files.

Quality generation uses `PROMPT_EVAL_MODEL` plus the existing inference
credentials. Quality grading requires
`SCOPE_EVAL_AZURE_OPENAI_ENDPOINT` and
`SCOPE_EVAL_AZURE_OPENAI_DEPLOYMENT` (or their `AZURE_OPENAI_*` fallbacks);
an API key is optional because `DefaultAzureCredential` is supported. Red
teaming requires `AZURE_AI_PROJECT_ENDPOINT` and
`AZURE_AI_MODEL_DEPLOYMENT_NAME` and uses only `DefaultAzureCredential`.
The signed-in principal must have the **Foundry User** role (or a broader
Foundry data-plane role) at the project or account scope. Taxonomy creation
specifically requires
`Microsoft.CognitiveServices/accounts/AIServices/evaluations/write`.

## Commands

```bash
# Run one or both independent tracks
pnpm eval:prompts -- --mode quality
pnpm eval:prompts -- --mode red-team
pnpm eval:prompts -- --mode both

# Convenience commands
pnpm eval:static-prompts
pnpm eval:static-prompts:smoke
pnpm eval:red-team

# Refresh and validate committed inputs
pnpm eval:static-prompts:harvest -- --project-name "Default Project"
pnpm eval:static-prompts:validate-data

# Package tests and type checking
pnpm --filter static-prompt-evals test
pnpm --filter static-prompt-evals typecheck

# Render an ignored Markdown report for an existing run
pnpm --filter static-prompt-evals report -- \
  results/<run-id>
```

Quality generation defaults to three samples per nondeterministic case. Pass
additional runner arguments after `--`, for example:

```bash
pnpm eval:prompts -- --mode quality --samples 5
```

The command returns nonzero for policy/threshold failures and infrastructure
failures. Inspect the run manifest to distinguish them. The offline smoke
command records deterministic prompt-policy failures in `policyStatus` but
returns success when the framework itself completes.

The Azure AI Evaluation SDK does not provide a native Markdown report
exporter. The package report command renders `REPORT.md` from the persisted
manifest, summary, aggregate, and finding artifacts. Reports remain inside the
ignored run directory unless `--output` explicitly selects another path.

The unified runner accepts `--samples N`, `--smoke`, `--results-dir PATH`,
`--dataset PATH`, `--surface-profiles PATH`, and `--red-team-config PATH`.
Surface selection and remote-resource preservation use the environment
variables documented below rather than CLI flags.

The harvester defaults to the integration base URL, `Default Project`, dataset
version `v1`, seed `scope-static-prompts-v1`, and this package's `datasets/`
directory. Available overrides are `--base-url`, `--project-id` or
`--project-name`, `--dataset-version`, `--seed`, `--output-dir`, and
`--token-env` (the last names an environment variable; it is not the token
itself). Use `--harvested-at <ISO timestamp>` for byte-for-byte reproducible
regeneration. Validation accepts `--dataset-root`.

Equivalent package-local commands are:

```bash
pnpm --dir evaluations/static-prompts harvest -- \
  --project-name "Default Project" \
  --dataset-version v1 \
  --seed scope-static-prompts-v1
pnpm --dir evaluations/static-prompts validate-data

# Protected integration environments, after securely exporting SCOPE_API_TOKEN
pnpm --dir evaluations/static-prompts harvest -- \
  --token-env SCOPE_API_TOKEN
```

The validator reads `evaluation-manifest.yaml`, `evaluators/rubrics.yaml`,
`datasets/manifest.json`, and the versioned JSONL files. Run its focused tests
with:

```bash
pnpm --dir evaluations/static-prompts exec vitest run \
  scripts/harvest.test.ts \
  scripts/validate-dataset.test.ts \
  scripts/dataset-adapter-contract.test.ts
```

The CLI retains `datasets/quality-cases.jsonl` as its legacy default argument.
When that file is absent, the quality loader follows the ordered file list in
`datasets/manifest.json` and verifies every SHA-256 and row count. It does not
discover inputs by globbing `datasets/v1/`.

## Authoring quality cases

Curated JSONL is input, not generated output. Each reviewed row must include:

- a stable case ID, `family`, and `variant`;
- JSON-serializable adapter input;
- deterministic and AI-assisted evaluator names;
- reviewed expectations or labels;
- a source category and human-approved state; and
- provenance: source endpoint, project ID, source entity IDs, harvest time,
  code revision, selection seed, and content hashes.

`task-prompt-variation` rows use `input.existingPrompt`,
`input.existingPrompts`, and `input.description`; their reviewed reference is
`expected.referenceTaskPrompt`. There is no separate `guidance` field.

Use the harvester for candidates, then minimize, redact, deduplicate, balance,
and review them. Integration is never contacted by normal tests or evaluation
runs. Do not hand-edit generated output into the curated dataset.

When adding or changing a static family:

1. register it in `evaluation-manifest.yaml`;
2. add or update the production TypeScript adapter;
3. add approved curated cases;
4. add deterministic assertions and rubric mappings; and
5. run data validation, tests, the fake-model smoke path, and the relevant real
   quality command.

Adapters must call production prompt composition and parsing. Do not copy
production prompt text into this package.

## Authoring red-team profiles

A surface profile identifies:

- the source field and downstream AI consumer;
- the production adapter and trusted wrapper;
- the exact untrusted insertion point and role;
- expected security boundary and prohibited outcomes; and
- supported single-turn/multi-turn behavior.

Profiles do not contain a handwritten copy of the trusted wrapper. Add a benign
contract fixture that proves roles, ordering, delimiters, static instructions,
tool descriptions/schemas, and insertion point match runtime composition.

Attack strategies, multi-turn depth, evaluators, and temporary-resource naming
belong in the reviewed red-team configuration. The preview API controls the
generated-objective count; record the returned item count rather than claiming
that a local objective-count setting was applied. Review prohibited-action
taxonomies before applicable runs.

The initial `red-team/red-team.yaml` uses multi-turn depth five, `Flip`,
`Base64`, and `IndirectJailbreak`, and the prohibited-actions,
task-adherence, and sensitive-data-leakage evaluators. It polls every five
seconds for up to one hour and uses bounded transient retries.

Task, gate, and `AGENTS.md` cloud scans are prompt-ingestion canaries because a
Foundry model target cannot reproduce coding-agent hidden instructions, tools,
permissions, or execution loops. Preserve that limitation in reports.

## Results and version control

Every invocation creates:

```text
results/<run-id>/
  manifest.json
  quality/
    selected-cases.jsonl
    production-rows.jsonl
    normalized-rows.jsonl
    deterministic-row-results.jsonl
    azure-row-results.jsonl
    azure-native/
      index.json
      <family>/
        <evaluator>-input.jsonl
        <evaluator>.json
    findings.json
    summary.json
  red-team/
    summary.json
    <surface-id>/
      taxonomy.json
      output-items.json
      summary.json
```

The runner updates `manifest.json` even on partial or infrastructure failure.
In `both` mode it attempts and records both tracks independently.
Cloud-native output may be retained as JSONL or CSV instead of
`output-items.json` when that is the format returned by the SDK.

For focused quality-engine validation:

```bash
cd evaluations/static-prompts
uv run pytest tests/quality -q
uv run python -m static_prompt_evals.cli --mode quality
```

The default generation subprocess runs from this package as:

```bash
pnpm generate -- \
  --input <selected-cases.jsonl> \
  --output <production-rows.jsonl> \
  --samples <N>
```

`results/` is ignored. Never commit generated responses, SDK/cloud output, run
manifests, summaries, findings, or portal URLs. Commit only curated inputs and
their provenance, schemas, rubrics, reviewed threshold policy, surface
profiles, and attack/evaluator configuration.

After red teaming, download results and delete only temporary targets created by
that run unless `SCOPE_RED_TEAM_KEEP_REMOTE=true` was explicitly set. Never
delete the shared Foundry project or deployment. Set
`SCOPE_RED_TEAM_SURFACES` to a comma-separated subset of profile IDs for a
targeted scan; leave it unset to scan every reviewed profile.
