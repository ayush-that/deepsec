import type { PullRequestContext } from "@deepsec/core";
import { getRegistry } from "@deepsec/core";
import { defaultGraphProvider, pathRiskCategories } from "@deepsec/scanner";
import { getRepoFromGitRemote } from "../enrich.js";
import { defaultPullRequestProvider } from "./pull-requests.js";
import { resolveWindow, type WindowResolution } from "./resolve-window.js";

/** Per file, the head-file line numbers added/changed in the window. Shared by focus + report. */
export function addedLinesByFile(window: Pick<WindowResolution, "files">): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const f of window.files) {
    if (f.addedLines.length > 0) map.set(f.filePath, f.addedLines);
  }
  return map;
}

export interface WindowFocus {
  windowId: string;
  defaultBranch: string;
  since: string;
  shallow: boolean;
  /** Live (non-deleted) changed files — the deep-investigation focus set. */
  focusFiles: string[];
  deletedFiles: string[];
  addedLinesByFile: Map<string, number[]>;
  prContexts: PullRequestContext[];
  commitCount: number;
}

/** Resolve a change window as a focus overlay (not a filter). Host-side (sandbox strips .git). */
export async function resolveWindowFocus(params: {
  root: string;
  since: string;
}): Promise<WindowFocus> {
  const window = resolveWindow({ root: params.root, since: params.since });

  const focusFiles: string[] = [];
  const deletedFiles: string[] = [];
  for (const f of window.files) {
    // Deleted files have no current content to investigate.
    if (f.status === "D") deletedFiles.push(f.filePath);
    else focusFiles.push(f.filePath);
  }

  const prProvider = getRegistry().pullRequests ?? defaultPullRequestProvider;
  const repo = getRepoFromGitRemote(params.root) ?? "";
  const prContexts =
    (await prProvider.fetch({ root: params.root, repo, commits: window.commits })) ?? [];

  return {
    windowId: window.windowId,
    defaultBranch: window.defaultBranch,
    since: params.since,
    shallow: window.shallow,
    focusFiles,
    deletedFiles,
    addedLinesByFile: addedLinesByFile(window),
    prContexts,
    commitCount: window.commits.length,
  };
}

export interface BlastRadiusHit {
  filePath: string; // impacted importer (not changed, but depends on something that was)
  viaChangedFile: string;
  riskCategories: string[];
}

/**
 * Given the window's changed files, find risk-path files that import them —
 * sensitive call sites whose behavior may have shifted without being edited.
 * Filtered to risk-relevant importers so a high-fan-in util doesn't drag in the
 * whole repo; returns all matches sorted, caller caps + logs.
 */
export async function expandByBlastRadius(params: {
  root: string;
  changedFiles: string[];
}): Promise<BlastRadiusHit[]> {
  const { root, changedFiles } = params;
  if (changedFiles.length === 0) return [];
  const provider = getRegistry().graphProvider ?? defaultGraphProvider;
  const rev = await provider.buildReverseGraph({ root, files: changedFiles });
  if (!rev) return [];

  const changedSet = new Set(changedFiles);
  const seen = new Set<string>();
  const hits: BlastRadiusHit[] = [];
  for (const changed of changedFiles) {
    const info = rev[changed];
    if (!info) continue;
    for (const importer of info.importers) {
      if (changedSet.has(importer) || seen.has(importer)) continue;
      const cats = pathRiskCategories(importer);
      if (cats.length === 0) continue; // only pull risk-relevant dependents
      seen.add(importer);
      hits.push({ filePath: importer, viaChangedFile: changed, riskCategories: cats });
    }
  }
  return hits.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/** Findings whose line falls inside the window's added/changed hunk lines. */
export function introducedFindings(
  records: { filePath: string; findings: { lineNumbers: number[] }[] }[],
  addedLinesByFile: Map<string, number[]>,
): { filePath: string; findingIndex: number }[] {
  const out: { filePath: string; findingIndex: number }[] = [];
  for (const rec of records) {
    const added = addedLinesByFile.get(rec.filePath);
    if (!added || added.length === 0) continue;
    const addedSet = new Set(added);
    rec.findings.forEach((f, i) => {
      if (f.lineNumbers.some((ln) => addedSet.has(ln))) {
        out.push({ filePath: rec.filePath, findingIndex: i });
      }
    });
  }
  return out;
}
