# deepsec

[`deepsec`](https://deepsec.sh) is an agent-powered vulnerability scanner that you can run in your own infrastructure, optimized to perform on-demand review of all code in existing 
large-scale repos.

`deepsec` is designed to surface hard-to-find issues that have been lurking in applications for a long time. It is configured to use the best models at maximum thinking levels (tunable via `--thinking-level`, see [models](https://github.com/vercel-labs/deepsec/blob/main/docs/models.md)), meaning scans can cost thousands or even tens-of-thousands of dollars for large codebases. Our customers have found the cost worth it for how quickly they were able to patch vulnerabilities that would have otherwise gone unfixed.

For large codebases, work fans out across worker machines in parallel.
If a run is interrupted or errors out partway through, just re-run the same
command — deepsec picks up where it left off, skipping files it already
analyzed and only investigating the rest.

## Get started

Navigate to the root of the repository that you want to scan, then:

```bash
npx deepsec init
```

That one resumable command creates the isolated `.deepsec/` workspace,
installs its pnpm/npm dependencies, links it to a Vercel project with
Sandbox access, offers benchmark-backed model/reasoning combinations (or a
custom model slug), verifies the selected model route, builds `INFO.md` and
an attack-surface inventory, scans, adds narrowly validated custom
matchers when coverage needs them, scans again, and starts AI processing.
Re-run the same command—or `cd .deepsec && pnpm deepsec setup`—to resume;
completed phases are reconciled and skipped.

Agents and CI clients can inspect the setup without mutations and then run it
with a stable machine protocol:

```bash
npx deepsec init --plan --output json
npx deepsec init --yes --model-profile value --output jsonl
```

Headless mode is automatic without a TTY. Missing login or ambiguous scope is
returned as structured `needs_input` with user actions and resume arguments;
cost/duration bounds and `--through coverage` stop at resumable checkpoints.

Use `npx deepsec init --scaffold-only` for the old manual workflow. For a
user-owned model key, select `--model-auth direct` with
`--ai-provider`, `--ai-api-key-env`, and optionally `--ai-base-url`.

After setup, daily commands run from `.deepsec/`:

```bash
pnpm deepsec scan
pnpm deepsec process    
pnpm deepsec revalidate # optional, cuts FP rate
pnpm deepsec export --format md-dir --out ./findings
```

Setup evaluates scanner coverage before processing and safely generates
declarative matchers for concrete gaps. For richer negative/contextual rules,
see [generated and hand-authored matchers](https://github.com/vercel-labs/deepsec/blob/main/docs/writing-matchers.md).

## Docs

After initialization, agents can read the exact documentation matching the
installed CLI at `.deepsec/node_modules/deepsec/SKILL.md` and
`.deepsec/node_modules/deepsec/dist/docs/`. Setup errors expose these as
absolute machine-readable paths.

- [Getting started](https://github.com/vercel-labs/deepsec/blob/main/docs/getting-started.md) — one-shot setup and resume
- [Reviewing changes](https://github.com/vercel-labs/deepsec/blob/main/docs/reviewing-changes.md) — `process --diff` and CI gating
- [Supported technology](https://github.com/vercel-labs/deepsec/blob/main/docs/supported-tech.md) — built-in coverage
- [Generated and hand-authored matchers](https://github.com/vercel-labs/deepsec/blob/main/docs/writing-matchers.md)
- [Configuration](https://github.com/vercel-labs/deepsec/blob/main/docs/configuration.md)
- [Plugins](https://github.com/vercel-labs/deepsec/blob/main/docs/plugins.md)
- [Models](https://github.com/vercel-labs/deepsec/blob/main/docs/models.md)
- [Project link and credentials](https://github.com/vercel-labs/deepsec/blob/main/docs/vercel-setup.md)
- [Architecture](https://github.com/vercel-labs/deepsec/blob/main/docs/architecture.md)
- [Data layout](https://github.com/vercel-labs/deepsec/blob/main/docs/data-layout.md)
- [FAQ](https://github.com/vercel-labs/deepsec/blob/main/docs/faq.md)
- [Samples](https://github.com/vercel-labs/deepsec/tree/main/samples)
- [Contributing](https://github.com/vercel-labs/deepsec/blob/main/CONTRIBUTING.md)

## AI provider

Initialization separates the Vercel project link from the model route. The
workspace is always linked with Sandbox-capable credentials in scope; the model can use Vercel
AI Gateway (default), your own OpenAI/Anthropic key, or a custom Pi provider.
Only the environment-variable name and routing metadata are persisted.

Interactive setup explains the isolated link, lets you create a dedicated
Deepsec project or choose an existing one, and pulls linked-project OIDC
automatically. It does not create a billable Sandbox during onboarding. For a long-lived
Gateway key, set `AI_GATEWAY_API_KEY`; for BYOK, use `--model-auth direct`
with `--ai-api-key-env`. See [project link, Sandbox, and model
credentials](https://github.com/vercel-labs/deepsec/blob/main/docs/vercel-setup.md).

If a `process` or `revalidate` run halts because the upstream credential
ran out of quota or credits, deepsec stops gracefully and tells you
where to top up. Re-run the same command afterward and it picks up
where it left off.

## Distributed execution (optional)

Large monorepos can fan work across [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) microVMs:

```bash
pnpm deepsec sandbox process --project-id my-app --sandboxes 10 --concurrency 4
```

The normal initializer already verified the exact workspace link. The local
working tree is tarballed and uploaded; `.git` is excluded. Model credentials
remain host-side and are injected only at the selected egress host.

## Security model of deepsec itself

Treat `deepsec` like a coding agent with full shell access on the enviroment that it is
running on. It is designed to run on trusted inputs (your source code) but you may still
be concerned about prompt injection due to external dependencies or vendored code.

Running on a sandbox (see above) does limit the potential exposure substantially:

- The API keys for the coding agents are injected outside of the sandbox and hence cannot be exfiltrated
- For the worker sandboxes, network egress from the sandbox is limited to coding agent hosts (Egress is allowed during the bootstrap process, but this does not run the coding agent)

## Workflow reference

| Command         | What it does                                             |
|-----------------|----------------------------------------------------------|
| `scan`          | Find candidate sites with regex matchers (fast, no AI)   |
| `process`       | AI investigation; emits findings + recommendation        |
| `process --diff`| PR-mode: scan + investigate only files changed in a diff |
| `triage`        | Lightweight P0/P1/P2 classification (cheaper model)      |
| `revalidate`    | Re-check existing findings; checks git history for fixes |
| `enrich`        | Add git committer info + (with a plugin) ownership data  |
| `report`        | Markdown + JSON summary for one project                  |
| `export`        | Per-finding JSON or directory of markdown files          |
| `metrics`       | Cross-project counts: severities, vulns by type, TPs     |
| `status`        | Snapshot of the project mirror                           |
| `sandbox <cmd>` | Run any of the above on Vercel Sandbox microVMs          |

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
