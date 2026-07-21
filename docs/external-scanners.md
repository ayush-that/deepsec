---
title: "External scanners"
description: "Run trufflehog and semgrep as a deterministic cross-check on top of the AI review, without biasing it."
---

When [trufflehog](https://github.com/trufflesecurity/trufflehog) and/or
[semgrep](https://semgrep.dev) are on `PATH`, `deepsec` runs them as a
deterministic pass alongside `scan`, `process --duration`, and
`process --diff-scan`. They are **not** merged into the candidate set —
their findings are stored aside so the AI review stays unbiased, then
cross-checked against the review afterward.

Both are optional. If a binary isn't installed, that scanner is skipped
with a log line and nothing else changes. Pass `--no-external` to skip
them (and the cross-check) entirely.

## The flow

1. `scan` / `process` runs its own regex matchers and the AI review as
   usual, with **no knowledge** of the external findings.
2. In parallel, trufflehog (secrets) and semgrep (SAST) run and write
   their hits to `data/<id>/external/findings.json` (plus per-scanner
   raw output).
3. After the review, a **cross-check** pass reconciles each external hit
   against the findings the review produced:
   - **confirmed** — a review finding already covers it. Nothing to do.
   - **dismissed** / **acknowledged** — the AI (or a human, see
     `--require-human-ack`) explicitly cleared it, with a reason, into
     the dismissal ledger (`FileRecord.dismissedExternal`).
   - **open** — neither covered nor dismissed. These are re-investigated
     (seeded as candidates for a targeted pass), and any that remain
     surface before the final report.

The point is that the review's judgment is formed independently, and the
deterministic scanners are used to catch what it missed — not to steer
it.

## semgrep rulesets

semgrep defaults to `p/security-audit` plus language packs selected
automatically from the detected tech (for example `p/typescript`,
`p/python`, `p/golang`). Override with
`data/<id>/config.json`:

```json
{ "semgrepConfig": "p/typescript,p/react" }
```

An override is used **verbatim** — comma-separated for multiple packs —
and disables the automatic language-pack selection.

## trufflehog and secret matchers

trufflehog scans for all detector types and all result types (verified
and unverified, no entropy filter), so recall is maximized.

When trufflehog is present, `deepsec` **skips its own secret matchers**
(it delegates secret detection to trufflehog) so the two don't
double-report. Only the default matcher set is skipped — an explicit
`--matchers <slug>` request is always honored. Override which matchers
are treated as "secret" via `data/<id>/config.json`:

```json
{ "secretMatcherSlugs": ["secret-env-var", "secret-in-log"] }
```

> Caveat: the handoff is gated on trufflehog being *installed*, not on
> its run *succeeding*. If trufflehog is installed but its run fails, the
> built-in secret matchers were already skipped for that run, so secret
> coverage is lost. The failure is surfaced as a loud warning rather than
> a silent clean result, but there is no automatic fallback yet.

## Where findings land

```
data/<id>/external/
  findings.json    # normalized ExternalFinding[] (the cross-check reads this)
  trufflehog.json  # raw per-scanner output
  semgrep.json
```

External findings never overwrite AI findings; they live aside and are
reconciled, so you can always see what each scanner reported on its own.

## Security note

Repo-controlled file paths are `./`-prefixed before they are passed to
trufflehog/semgrep, so a file named e.g. `-x.js` or `--config=…` in the
scanned repo can't be interpreted as a scanner flag (argument
injection). A non-zero trufflehog exit with empty output is treated as an
error, not a silent clean result.
