# Reviewing changes (PR mode)

`deepsec process` has a direct-invocation mode for reviewing a specific
set of files — typically the files changed in a pull request. This is
the right tool when you want a fast, scoped read of changed code in CI,
rather than a whole-repo audit.

```bash
deepsec process --diff origin/main
```

## How it differs from a full scan

The standard flow is `scan` → `process` over the entire repo:

| Step      | What it looks at        | What it produces                       |
|-----------|-------------------------|----------------------------------------|
| `scan`    | The full source tree    | Regex candidates per file              |
| `process` | All pending candidates  | AI findings on every flagged file      |

Direct mode collapses both steps into one invocation, scoped to a file
list:

| Step              | What it looks at                | What it produces                                           |
|-------------------|---------------------------------|------------------------------------------------------------|
| Resolve files     | `--diff` / `--files` / stdin    | A POSIX-relative file list under `rootPath`                |
| Scoped scan       | Only the listed files           | Candidates as **signals** for the prompt (best-effort)     |
| Always-process    | The same listed files           | AI findings — even on files no matcher hit                 |

The scoped scan still runs because regex hits are useful prompt anchors
for the agent. Files with no hits still get a record and still get
investigated as a holistic review — no signals, no scanner anchoring,
just the agent reading the file.

## Flags

All five sources are mutually exclusive:

```text
--diff <ref|range>     Investigate `git diff --name-only <ref>` (e.g. origin/main, HEAD~1..HEAD)
--diff-staged          Investigate the index vs HEAD
--diff-working         Investigate uncommitted + untracked files
--files <csv>          Investigate this comma-separated path list
--files-from <path>    Read newline-delimited paths from <path> (or "-" for stdin)
```

Other knobs:

```text
--no-ignore            Bypass the default ignore filter (test files, dist/, node_modules/, …)
--comment-out <path>   Write a PR-comment-shaped markdown summary to <path> (only when findings exist)
--project-id <id>      Override the project id (auto-derived from rootPath basename otherwise)
--root <path>          Override the project root (defaults to cwd or deepsec.config.ts)
```

The usual `--agent`, `--model`, `--concurrency`, `--batch-size`,
`--max-turns` flags work the same as in standard mode.

## Auto-created projects

You don't need to run `deepsec init` first. When invoked with one of the
direct-mode flags, `process` will:

1. Use `--project-id` if you pass one. If it's already declared in
   `deepsec.config.ts`, the declared root is used; otherwise `--root`
   (or the current working directory) is used.
2. Otherwise, derive the id from the basename of the resolved root.
3. Write `data/<id>/project.json` if it doesn't already exist.

Auto-creation is one-line and non-destructive — it never modifies your
`deepsec.config.ts`. It just ensures `data/<id>/` exists so file
records, run metadata, and the optional PR-comment markdown have
somewhere to land.

## Exit codes

| Code | Meaning                                          |
|------|--------------------------------------------------|
| `0`  | No findings produced in this run                 |
| `1`  | At least one finding was produced                |
| `≠1` | Runtime error (bad input, missing credentials, …)|

This makes direct mode a drop-in CI gate: the job fails when the agent
finds something. Pre-existing findings on unrelated files are not
counted — only findings from the current run.

## PR comments

`--comment-out <path>` writes a markdown body summarizing the findings
from the current run. The file is only written when there are findings,
so a green run leaves nothing on disk and your "post comment" step can
short-circuit on `if: hashFiles('comment.md') != ''`.

A minimal GitHub Actions workflow that runs `deepsec` on PRs and
comments findings back:

```yaml
name: deepsec PR review

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # we need the merge base for `git diff origin/main`

      - uses: actions/setup-node@v4
        with:
          node-version: '24'

      - run: |
          npx deepsec process \
            --diff origin/${{ github.event.pull_request.base.ref }} \
            --comment-out comment.md
        env:
          AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}

      - name: Comment on PR
        if: failure() && hashFiles('comment.md') != ''
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const body = fs.readFileSync('comment.md', 'utf8');
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body
            })
```

`if: failure()` runs the comment step exactly when `deepsec process`
exited 1 (findings present). The `hashFiles` guard handles the rare case
where the job failed for a non-finding reason and no comment was
written.

## Cost notes

Wide diffs are expensive — each file pays for an AI investigation. For
PRs against `main`, scope to the merge base (`origin/main`), not the
entire branch ancestry. If a touched file isn't worth investigating
(generated code, fixtures), add it to your existing ignore patterns or
drop it via a custom `--files-from` script:

```bash
git diff --name-only origin/main \
  | grep -v '^generated/' \
  | deepsec process --files-from -
```

## When NOT to use direct mode

- For the initial sweep of a large repo: full `scan` + `process` orders
  by noise tier, parallelizes better, and benefits from the
  whole-repo signal in matcher gating. Direct mode is for incremental
  review.
- For revalidating existing findings: use `revalidate` with its own
  filters.
