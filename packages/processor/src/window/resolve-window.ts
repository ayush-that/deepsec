import { spawnSync } from "node:child_process";
import { resolveDefaultBranch } from "@deepsec/core";

export type ChangeStatus = "A" | "M" | "D" | "R" | "C";

export interface ChangedFile {
  filePath: string;
  status: ChangeStatus;
  /** Present for renames (status "R"): the pre-rename path. */
  oldPath?: string;
  /** Unified diff for this file across the window (empty for pure renames with no content change). */
  patch: string;
  /** Line numbers in the *current* (head) file that were added/changed in the window. */
  addedLines: number[];
}

export interface WindowResolution {
  windowId: string;
  /** Raw duration string as passed (e.g. "1 month"). */
  since: string;
  /** Concrete window-start date (YYYY-MM-DD), derived from the oldest commit. */
  sinceDate: string;
  defaultBranch: string;
  headSha: string;
  commits: { sha: string; subject: string }[];
  files: ChangedFile[];
  renameCount: number;
  /** True when the checkout is a shallow clone — the window may be truncated at the fetch boundary. */
  shallow: boolean;
}

// git's canonical empty-tree object — used as the diff base when the oldest
// commit in the window is a root commit (no parent).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** argv-safe git capture, host-side. Exported so sibling collectors reuse the same options. */
export function runGit(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  // argv form (no shell). The window string is user input; passing it as a
  // single argv slot keeps it from being re-parsed as a command.
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024 * 1024, // 2 GB — matches enrich; a month's diff on a large monorepo can be big
    timeout: 5 * 60 * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Turn the `--duration` value into a git --since string. The primary form is a
 * day count ("7d", "30d"); raw git approxidate strings ("1 month ago") pass
 * through unchanged. `Nd` is converted because git doesn't parse a bare "30d".
 */
export function durationToGitSince(input: string): string {
  const m = /^\s*(\d+)\s*d\s*$/i.exec(input);
  return m ? `${m[1]} days ago` : input;
}

/**
 * Resolve a change window against the default branch (the merged-to-main view
 * — "what shipped last month", not in-flight branches). Runs entirely
 * host-side; the sandbox strips .git so this must complete before dispatch.
 */
export function resolveWindow(params: { root: string; since: string }): WindowResolution {
  const { root } = params;
  const since = durationToGitSince(params.since);
  const defaultBranch = resolveDefaultBranch(root);

  // Shallow clones truncate the window silently (ref resolves, log exits 0) — surface it.
  const shallow = runGit(root, ["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";

  // Fail loud on an unresolvable ref rather than collapse to a silent "empty window".
  const verify = runGit(root, ["rev-parse", "--verify", "--quiet", defaultBranch]);
  if (verify.status !== 0) {
    throw new Error(
      `Cannot resolve default branch "${defaultBranch}" in ${root}. ` +
        `Set it (git remote set-head origin -a) or pass --root pointing at a full checkout.`,
    );
  }

  // Commits newest-first: sha \t committer-date \t subject. %cs = when it landed on the branch.
  const log = runGit(root, [
    "log",
    `--since=${since}`,
    "--pretty=format:%H%x09%cs%x09%s",
    defaultBranch,
  ]);
  if (log.status !== 0) {
    throw new Error(`git log failed resolving the window on ${defaultBranch}: ${log.stderr.trim()}`);
  }
  const commits: { sha: string; subject: string }[] = [];
  let oldestSha = "";
  let sinceDate = "";
  if (log.stdout.trim()) {
    const lines = log.stdout.trim().split("\n");
    for (const line of lines) {
      const parts = line.split("\t");
      const sha = parts[0];
      // %s is the last field; rejoin so a subject containing a literal tab survives.
      if (sha) commits.push({ sha, subject: parts.slice(2).join("\t") });
    }
    const last = lines[lines.length - 1]?.split("\t");
    oldestSha = last?.[0] ?? "";
    sinceDate = last?.[1] ?? "";
  }

  const headSha = commits[0]?.sha ?? "";
  const windowId = `${sinceDate || "unknown"}_${headSha.slice(0, 7) || "empty"}`;

  if (!headSha || !oldestSha) {
    return {
      windowId,
      since,
      sinceDate,
      defaultBranch,
      headSha,
      commits,
      files: [],
      renameCount: 0,
      shallow,
    };
  }

  // 2. Diff base = parent of the oldest window commit (empty tree if root).
  const parent = runGit(root, ["rev-parse", "--verify", "--quiet", `${oldestSha}^`]);
  const base = parent.status === 0 && parent.stdout.trim() ? parent.stdout.trim() : EMPTY_TREE;
  const range = `${base}..${headSha}`;

  // 3. name-status (rename-aware) → status per file.
  const statuses = new Map<string, { status: ChangeStatus; oldPath?: string }>();
  let renameCount = 0;
  const ns = runGit(root, ["diff", "--name-status", "-M", "--diff-filter=AMRCD", range]);
  if (ns.status === 0) {
    for (const line of ns.stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const code = parts[0][0] as ChangeStatus;
      if (code === "R" || code === "C") {
        // "R100\told\tnew" — track the current (new) path.
        const oldPath = parts[1];
        const newPath = parts[2];
        if (!newPath) continue;
        if (code === "R") renameCount++;
        statuses.set(newPath, { status: code, oldPath });
      } else {
        const p = parts[1];
        if (p) statuses.set(p, { status: code });
      }
    }
  }

  // 4. Per-file patch: split the window's unified diff on "diff --git".
  const patches = new Map<string, string>();
  const diff = runGit(root, ["diff", "-M", "-U3", "--diff-filter=AMRCD", range]);
  if (diff.status === 0) {
    for (const chunk of splitUnifiedDiff(diff.stdout)) {
      if (chunk.path) patches.set(chunk.path, chunk.patch);
    }
  }

  const files: ChangedFile[] = [];
  for (const [filePath, meta] of statuses) {
    const patch = patches.get(filePath) ?? "";
    files.push({
      filePath,
      status: meta.status,
      oldPath: meta.oldPath,
      patch,
      addedLines: addedLineNumbers(patch),
    });
  }

  return { windowId, since, sinceDate, defaultBranch, headSha, commits, files, renameCount, shallow };
}

/**
 * Line numbers in the NEW (head) file that a unified-diff patch adds or changes.
 * Walks the hunk headers (`@@ -a,b +c,d @@`) tracking the new-file line counter,
 * recording each `+` line. Exported for the self-check.
 */
export function addedLineNumbers(patch: string): number[] {
  const out: number[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      newLine = parseInt(h[1], 10);
      inHunk = true;
      continue;
    }
    // The `+++ b/…` / `--- a/…` file headers sit before the first hunk, so
    // gating on inHunk skips them — and inside a hunk the first char is always
    // the marker, so an added line like `+++i;` (content `++i;`) is handled
    // correctly rather than mistaken for a header.
    if (!inHunk) continue;
    const marker = line[0];
    if (marker === "+") {
      out.push(newLine);
      newLine++;
    } else if (marker === "-" || marker === "\\") {
      // removed line advances the old file only; `\ No newline` advances neither
    } else {
      newLine++; // context line (leading space) or blank
    }
  }
  return out;
}

/**
 * Split a `git diff` blob into per-file chunks. The current (new) path is
 * parsed from the `+++ b/<path>` header; deletions fall back to `--- a/<path>`.
 * Exported for the self-check.
 */
export function splitUnifiedDiff(diff: string): { path: string; patch: string }[] {
  const out: { path: string; patch: string }[] = [];
  const chunks = diff.split(/^diff --git /m).filter((c) => c.trim());
  for (const body of chunks) {
    const patch = "diff --git " + body;
    const plus = patch.match(/^\+\+\+ b\/(.+)$/m);
    const minus = patch.match(/^--- a\/(.+)$/m);
    let path = plus?.[1]?.trim();
    if (!path || path === "/dev/null") path = minus?.[1]?.trim();
    if (path && path !== "/dev/null") out.push({ path, patch });
  }
  return out;
}
