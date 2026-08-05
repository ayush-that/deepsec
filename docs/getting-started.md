---
title: "Getting started"
description: "Create, connect, model, scan, and process a resumable deepsec workspace with one command."
---

## Run the one-shot initializer

Requires Node.js 22+. From the root of the repository you want to scan:

```bash
npx deepsec init
```

This is the normal first-run path. It:

1. creates an isolated `.deepsec/` workspace and registers the repository;
2. runs pnpm or npm install inside that workspace;
3. asks for a benchmark-backed model/reasoning combination;
4. links the exact workspace to a Vercel project and verifies model and Sandbox access;
5. uses a read-only setup agent to write `data/<id>/INFO.md` and a structured attack-surface inventory;
6. runs the built-in matcher scan and evaluates coverage;
7. generates and validates narrow declarative matchers when real coverage gaps remain;
8. scans again as needed; and
9. runs the AI processor once coverage passes.

The Vercel link is always established, even if you plan to process locally.
That makes Sandbox available later without a second onboarding flow.

## Resume safely

Setup checkpoints every phase at
`data/<id>/setup/setup-state.json`. Re-run the same command after an
interruption:

```bash
npx deepsec init
```

Or resume from inside the workspace:

```bash
cd .deepsec
pnpm deepsec setup
```

Valid completed phases short-circuit. Deepsec still performs cheap local
reconciliation: it checks that the install exists and reloads credentials
into the fresh process. Network model/Sandbox probes reuse a fresh matching
verification checkpoint.

A changed source fingerprint invalidates scans and processing. A completed,
valid `INFO.md` is preserved instead of being overwritten merely because
source files changed.

## Installation options

The package manager is selected from lockfiles, the scaffolded
`packageManager` field, and the invoking user agent. Override it when needed:

```bash
npx deepsec init --package-manager npm
```

To forbid installation and require a usable existing `node_modules/deepsec`:

```bash
npx deepsec init --skip-install
```

Use the old file-only flow only when you intentionally want to drive every
later step yourself:

```bash
npx deepsec init --scaffold-only
```

That mode writes `SETUP.md` and prints the manual coding-agent prompt. It does
not install, link, analyze, scan, or process.

## Project link and credentials

Interactive setup links or reuses `.deepsec/.vercel/project.json`, pulls an
OIDC credential, and verifies that Sandbox credentials are in scope without
creating a billable Sandbox. An ancestor repository
link is not silently reused. A dedicated empty Vercel project is safest
because environment pull reads the linked project's development environment.

## Agents and headless clients

### Read the installed documentation

Deepsec installs its agent skill and complete documentation inside the isolated
workspace. From the repository root, an agent should read the skill first and
then the relevant topic:

```bash
cat .deepsec/node_modules/deepsec/SKILL.md
cat .deepsec/node_modules/deepsec/dist/docs/getting-started.md
cat .deepsec/node_modules/deepsec/dist/docs/vercel-setup.md
```

All packaged topics are under
`.deepsec/node_modules/deepsec/dist/docs/`. From inside `.deepsec`, omit the
leading `.deepsec/`; replace it with the custom workspace path when `init` was
given one. Structured setup errors include absolute `documentation` paths so
agents do not need to guess. These workspace copies exist after the install
phase; before then, use `npx deepsec init --help` or the repository docs.

When stdin or stdout is not a TTY, Deepsec automatically uses headless mode:
it never prompts, launches a browser, or starts an interactive login. Agents
can inspect the complete plan without writing anything:

```bash
npx deepsec init --plan --output json
```

For an autonomous run, accept deterministic defaults, select a benchmark
profile, and stream redacted machine-readable events:

```bash
npx deepsec init --yes --model-profile value --output jsonl
```

`best` chooses the highest score, `value` the highest score within 2.5× of the
cheapest recommendation, and `budget` the cheapest recommended combination.
The resolved harness/model/thinking level is persisted, so leaderboard changes
never alter a resumed run.

If Vercel is not authenticated, the command exits 2 with a
`VERCEL_AUTH_REQUIRED` `needs_input` payload. Agents should show its action to
the user—normally `npx vercel login`. For a new workspace, the payload then
guides the agent to run `npx vercel link` from inside `.deepsec`; a known
existing project can be linked non-interactively with
`npx vercel link --yes --team <team-slug> --project <project-name>`. The agent
then reruns the exact Deepsec command. Deepsec detects the authenticated CLI,
asks for a team only when ambiguous, and with `--yes` creates or reuses a
deterministic dedicated project. It never stores credential values in output
or setup state.

Useful automation controls:

```bash
# Stop before paid investigation, inspect coverage, then resume later
npx deepsec init --yes --model-profile value --through coverage --output jsonl

# Bound a full run; both limits leave resumable checkpoints
npx deepsec init --yes --model-profile value \
  --max-cost-usd 100 --max-duration 2h --output jsonl

# Inspect checkpoints from inside the workspace
cd .deepsec
pnpm deepsec setup --status --output json
```

Duration values always require an explicit unit: `ms`, `s`, `m`, or `h`.
Bare numbers are rejected rather than guessed.

JSON mode emits one final object. JSONL streams setup events followed by a
`complete`, `stopped`, `needs_input`, `limit`, or `failure` object. Exit code 2
means user/configuration input is needed; exit code 3 means a requested cost or
duration boundary was reached; either is safe to resume. A workspace lock
rejects concurrent setup processes instead of allowing two agents to race.

For CI with an explicit access-token identity:

```bash
VERCEL_TOKEN=... \
VERCEL_TEAM_ID=team_... \
VERCEL_PROJECT_ID=prj_... \
npx deepsec init --headless
```

An existing exact-workspace link is reusable with either its
`VERCEL_OIDC_TOKEN`, a `VERCEL_TOKEN`, or the authenticated Vercel CLI. The
three explicit values avoid CLI discovery in CI. `--headless` can be supplied
explicitly, and `--non-interactive` remains as a legacy alias.

The default model route is Vercel AI Gateway. To use your own OpenAI key:

```bash
MY_OPENAI_KEY=... npx deepsec init \
  --agent codex \
  --model-auth direct \
  --ai-provider openai \
  --ai-api-key-env MY_OPENAI_KEY
```

In an interactive terminal, `init` first asks for the model route, then shows
a short list of recommended model, reasoning-level, and harness combinations.
Each recommendation includes its latest DeepSecBench score and benchmark-run
cost relative to the cheapest recommendation. The numbers come from the
[live DeepSecBench results](https://vercel.com/ai-gateway/leaderboards/deepsecbench/results.json);
if that request fails, setup clearly labels its bundled snapshot as cached.
Choose the final option to paste any custom model slug instead.

The selected agent, model, and thinking level are persisted as workspace
defaults and reused by `setup`, `process`, and `revalidate`; explicit CLI flags
still override them. Use
`--no-tui` for line-oriented output; the same redacted JSONL setup log is kept
under `data/<project-id>/setup/` in either mode.

The config stores `MY_OPENAI_KEY`, not its value. Export that variable again
for later commands or put it in `.deepsec/.env.local`. Direct Anthropic works
with `--agent claude --ai-provider anthropic`. Custom HTTPS providers use Pi
plus `--ai-base-url` and `--ai-credential-header`.

See [vercel-setup.md](vercel-setup.md) for the full route matrix, Sandbox
credential brokering, and troubleshooting.

## Threat model and coverage

The setup agent reads repository documentation, manifests, entry points, auth
helpers, and representative source files without writing to the target repo.
It returns two outputs:

- `data/<id>/INFO.md`: concise context injected into later AI investigations;
- `data/<id>/setup/surface-inventory.json`: structured HTTP, RPC, queue, cron,
  CLI, webhook, and agent-tool surfaces used for coverage evaluation.

Review `INFO.md`; it is intentionally short and project-specific. The setup
inventory and checkpoint state are reproducible generated evidence and are
gitignored by default.

Coverage compares representative files and surface file universes against
the current scan, checks dominant-language blind spots, and rejects generated
matchers that touch an excessive share of the repository. Generated specs are
strict data—not executable model-written code—and compile through
`compileDeclarativeMatchers`. Accepted specs live in
`.deepsec/generated-matchers.ts`, which is intended to be reviewed and
committed.

Setup makes at most two matcher-generation attempts. If coverage is still
insufficient, it stops before paid processing and reports the remaining gaps.
Review the inventory or write a hand-authored matcher, then run `deepsec setup`
again.

### Trust boundary

Repository analysis runs on the host through the selected coding-agent SDK.
Deepsec requests read-only filesystem access and disables agent network tools,
but source text is still untrusted model input and the agent process must
authenticate to the model provider. Run one-shot setup only on code you trust
at coding-agent privilege. For untrusted pull requests, use the guarded CI
patterns in [reviewing-changes.md](reviewing-changes.md) or isolate the job.

## After initialization

The first scan and processing pass already ran. From `.deepsec/`, use these
commands for later work:

```bash
pnpm deepsec status
pnpm deepsec scan
pnpm deepsec process --concurrency 5
pnpm deepsec revalidate --min-severity HIGH
pnpm deepsec export --format md-dir --out ./findings
```

`--project-id` is inferred when the config has exactly one project. Pass it
explicitly in multi-project workspaces.

`scan` is local regex matching and makes no model calls. `process` is the
expensive stage. Both scan records and processing records are resumable;
re-running merges or skips completed work rather than starting over.

The default agent is Codex with its default model. Select another backend for
setup and processing with `--agent` and `--model`; see
[models.md](models.md).

## Distributed processing

The initializer already verified the project link, so distributed execution
needs no extra auth onboarding:

```bash
pnpm deepsec sandbox process --project-id my-app --sandboxes 10 --concurrency 4
```

The host keeps the real model credential and gives each worker a placeholder.
The network broker injects the credential only at the selected model host.

## Add another project

From the existing `.deepsec/` workspace:

```bash
pnpm deepsec init-project ../another-service --id another-service
pnpm deepsec setup --project-id another-service
```

`init-project` only registers and scaffolds the project. `setup` performs the
one-shot install/login/model/analysis/coverage/process workflow for it while
reusing the same workspace-level Vercel link.

## Next

- [configuration.md](configuration.md) — project, route, generated matcher,
  and environment configuration.
- [writing-matchers.md](writing-matchers.md) — when to keep generated
  declarative matchers and when to write richer hand-authored matchers.
- [data-layout.md](data-layout.md) — setup checkpoints, inventory, scan state,
  findings, and runs.
- [architecture.md](architecture.md) — setup coordinator and steady-state
  pipeline internals.
