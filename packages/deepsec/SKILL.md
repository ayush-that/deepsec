---
name: deepsec
description: Use deepsec (an AI-powered vulnerability scanner) — one-shot initialization, resumable setup, project/model credentials, scans, generated or hand-authored matchers, and plugins. Activates when the user asks how to initialize, scan, configure, resume, or extend deepsec.
---

# deepsec

`deepsec` is an AI-powered vulnerability scanner. This skill activates
when deepsec ships inside `node_modules/` — typically because the user
ran `npx deepsec …` (which caches the package locally). In the more
common dedicated-git setup the user works inside a clone of
`vercel-labs/deepsec` and the same docs sit at `docs/` from the repo root —
read those instead when this skill fires from outside a node_modules.

When the user asks how to use, configure, or extend deepsec, read the
relevant doc before answering — the docs are the source of truth, not
your training data.

## Where the docs are

`node_modules/deepsec/dist/docs/` (or `<deepsec-clone>/docs/`):

- `getting-started.md` — one-shot initialization and resume walkthrough
- `configuration.md` — full `deepsec.config.ts` reference
- `plugins.md` — plugin slots (matchers, notifiers, ownership, people, executor)
- `writing-matchers.md` — generated declarative vs hand-authored matchers
- `models.md` — model selection, defaults, refusals, future models
- `vercel-setup.md` — exact project link, Sandbox scope, Gateway/BYOK/custom routes
- `architecture.md` — pipeline internals
- `data-layout.md` — `data/` schemas (FileRecord, RunMeta, …)
- `faq.md` — cost, model choice, sandbox mode, FP rate

## Worked example

`node_modules/deepsec/dist/samples/webapp/` (or `<deepsec-clone>/samples/webapp/`)
is a reference for richer hand-authored matchers. The normal initializer now
creates `generated-matchers.ts` automatically; do not present the sample's
manual plugin as the default first-run path.

## How to answer common questions

- **"How do I install/init deepsec?"** → `getting-started.md`; default to `npx deepsec init`, not a manual install/scan recipe.
- **"Setup stopped; how do I resume?"** → `getting-started.md` + `data-layout.md`; re-run init or `deepsec setup`.
- **"How do I run another scan?"** → `getting-started.md` after noting the first scan/process already ran during setup.
- **"What goes in `deepsec.config.ts`?"** → `configuration.md` + `samples/webapp/deepsec.config.ts`.
- **"Why did setup generate a matcher?"** → `writing-matchers.md` + the project's `generated-matchers.ts`.
- **"How do I add a richer matcher?"** → `writing-matchers.md` + `samples/webapp/matchers/*.ts`.
- **"How do I write a plugin?"** → `plugins.md` + `samples/webapp/deepsec.config.ts` (inline plugin pattern).
- **"What does deepsec actually do?"** → `architecture.md`.
- **"What's in `data/<id>/files/foo.json`?"** → `data-layout.md`.
- **"Which model / agent should I use?"** → `models.md`.
- **"How do project linking, Sandbox, or my own credentials work?"** → `vercel-setup.md`.

Read the doc before paraphrasing. The CLI flag set, defaults, and
plugin-contract field names change — quote the doc, don't recall.

## Agent-native initialization

When you are asked to initialize Deepsec from a non-TTY agent session, first
inspect the read-only plan:

```bash
npx deepsec init --plan --output json
```

Then run the requested policy, normally:

```bash
npx deepsec init --yes --model-profile value --output jsonl
```

Parse every output line as JSON. On `needs_input`, show the supplied message
and actions to the user rather than inventing remediation. In particular,
`VERCEL_AUTH_REQUIRED` normally asks the user to run `npx vercel login`; after
they do, follow the returned link action from inside `.deepsec`. Use
`npx vercel link` when the user needs to choose, or the returned parameterized
`--yes --team <team-slug> --project <project-name>` form for a known existing
project. Then rerun the same Deepsec command. Exit code 2 means input is needed
and exit code 3 means a requested cost/duration boundary stopped the resumable
run. Never expose credential values, bypass `--yes`, or launch an interactive
login yourself.
