import fs from "node:fs";
import path from "node:path";
import { ensureProject, loadAllFileRecords, readProjectConfig } from "@deepsec/core";
import {
  expandByBlastRadius,
  introducedFindings,
  process as processRun,
  resolveWindowFocus,
} from "@deepsec/processor";
import { scan, scanFiles } from "@deepsec/scanner";
import { buildAgentConfig } from "../agent-config.js";
import { defaultModelForAgent } from "../agent-defaults.js";
import { crossCheckExternalFindings, externalScanPlan, runExternals } from "../external-scan.js";
import { resolveFiles } from "../file-sources.js";
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "../formatters.js";
import { renderPrComment } from "../pr-comment.js";
import { assertAgentCredential } from "../preflight.js";
import { renderQuotaMessage } from "../quota-message.js";
import { resolveAgentType } from "../resolve-agent-type.js";
import { resolveProjectId, resolveProjectIdForDirect } from "../resolve-project-id.js";

function logProgress(progress: {
  type: string;
  message: string;
  batchIndex?: number;
  totalBatches?: number;
  agentProgress?: { type: string; message: string };
}) {
  try {
    switch (progress.type) {
      case "batch_started":
        console.log(
          `${BOLD}Batch ${(progress.batchIndex ?? 0) + 1}/${progress.totalBatches}${RESET}: ${progress.message}`,
        );
        break;
      case "agent_progress": {
        const ap = progress.agentProgress;
        if (!ap) break;
        switch (ap.type) {
          case "started":
            console.log(`  ${GREEN}>${RESET} ${ap.message}`);
            break;
          case "thinking":
            console.log(`  ${DIM}  ${ap.message}${RESET}`);
            break;
          case "tool_use":
            console.log(`  ${CYAN}  tool:${RESET} ${ap.message}`);
            break;
          case "complete":
            console.log(`  ${GREEN}  ${ap.message}${RESET}`);
            break;
          case "error":
            console.log(`  ${RED}  ${ap.message}${RESET}`);
            break;
          default:
            console.log(`  ${DIM}  ${ap.message}${RESET}`);
        }
        break;
      }
      case "batch_complete":
        console.log(`  ${progress.message}`);
        console.log();
        break;
      case "all_complete":
        console.log(`  ${DIM}${progress.message}${RESET}`);
        break;
    }
  } catch (err) {
    console.error(
      `  ${DIM}[progress render error: ${err instanceof Error ? err.message : String(err)}]${RESET}`,
    );
  }
}

function parseCsv(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const parts = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/** Post-review cross-check of the deterministic scanners (unless --no-external). Shared by all modes. */
/** Returns the number of findings the cross-check confirmed (0 when disabled/none). */
async function maybeCrossCheck(
  opts: { external?: boolean; concurrency?: number; batchSize?: number },
  projectId: string,
  agentType: string,
  config: Record<string, unknown>,
  rootPath: string,
): Promise<number> {
  if (opts.external === false) return 0;
  return crossCheckExternalFindings({
    projectId,
    agentType,
    config,
    rootPathOverride: rootPath,
    concurrency: opts.concurrency,
    batchSize: opts.batchSize,
    onProgress: logProgress,
  });
}

export async function processCommand(opts: {
  projectId?: string;
  runId?: string;
  agent?: string;
  model?: string;
  maxTurns?: number;
  thinkingLevel?: string;
  aiProvider?: string;
  aiBaseUrl?: string;
  aiApiKeyEnv?: string;
  aiHeader?: string[];
  /** Commander yields `true` when bare; string (unparsed) when an arg is provided */
  reinvestigate?: boolean | string;
  limit?: number;
  concurrency?: number;
  filter?: string;
  batchSize?: number;
  root?: string;
  manifest?: string;
  onlySlugs?: string;
  skipSlugs?: string;
  // Direct invocation flags
  diff?: string;
  diffStaged?: boolean;
  diffWorking?: boolean;
  files?: string;
  filesFrom?: string;
  /** Commander auto-injects this from `--no-ignore` (default true). */
  ignore?: boolean;
  commentOut?: string;
  // Window mode
  duration?: string;
  /** With --duration: scope investigation to the window's changed files only. */
  diffScan?: boolean;
  /** Resolve the window + scan, print what would be investigated, then stop (zero AI). */
  dryRun?: boolean;
  /** With --duration: expand the deep set by blast radius (reverse-import graph). Opt-in. */
  graph?: boolean;
  /** Commander `--no-external` sets this false; default true. */
  external?: boolean;
}) {
  const isDirectMode =
    opts.diff !== undefined ||
    !!opts.diffStaged ||
    !!opts.diffWorking ||
    !!opts.files ||
    !!opts.filesFrom;

  // --diff-scan: window-scoped investigation (only changed files). Requires
  // --duration and is exclusive with the whole-repo direct sources.
  if (opts.diffScan) {
    if (opts.duration === undefined) {
      throw new Error("--diff-scan requires --duration (the window to scope to).");
    }
    if (isDirectMode) {
      throw new Error("--diff-scan is mutually exclusive with --diff*/--files*. Pick one mode.");
    }
    return processDiffScanMode(opts);
  }

  if (opts.duration !== undefined) {
    if (isDirectMode) {
      throw new Error("--duration is mutually exclusive with --diff*/--files*. Pick one mode.");
    }
    return processWindowMode(opts);
  }

  if (isDirectMode) {
    return processDirectMode(opts);
  }
  // Standard mode has no window/file preview to show; --dry-run there would
  // otherwise fall through to a full billed run — the opposite of its intent.
  if (opts.dryRun) {
    throw new Error(
      "--dry-run requires --duration, --diff-scan, or a --diff*/--files* source (nothing to preview in standard mode).",
    );
  }
  return processStandardMode(opts);
}

/**
 * Window mode (process --duration): full scan + process over the whole repo,
 * with window-changed files investigated deeper (deep pass at full thinking, the
 * rest at medium). The "introduced" report section comes from `report --duration`.
 */
async function processWindowMode(opts: Parameters<typeof processCommand>[0]) {
  const { projectId, rootPath, autoCreated } = resolveProjectIdForDirect(opts.projectId, opts.root);
  ensureProject(projectId, rootPath);
  const root = rootPath;
  const since = opts.duration as string;
  const agentType = resolveAgentType(opts.agent);
  const model = opts.model ?? defaultModelForAgent(agentType);
  // A dry run never calls the agent — don't require a credential to preview.
  if (!opts.dryRun) assertAgentCredential(agentType, { aiApiKeyEnv: opts.aiApiKeyEnv });

  // Window files: full thinking; rest of repo: medium — so focus is always deeper.
  const focusThinking = opts.thinkingLevel ?? "xhigh";
  const baseThinking = "medium";
  const focusConfig = buildAgentConfig({ ...opts, model, thinkingLevel: focusThinking });
  const baseConfig = buildAgentConfig({ ...opts, model, thinkingLevel: baseThinking });

  console.log(`${BOLD}Window mode${RESET} project ${BOLD}${projectId}${RESET}`);
  if (autoCreated) console.log(`  ${DIM}Auto-created project at ${rootPath}${RESET}`);
  console.log(`  Duration: ${since}`);
  console.log(`  Root: ${root}`);
  console.log(`  Agent: ${agentType} (${model})`);
  console.log(`  Thinking: window=${focusThinking}, rest=${baseThinking}`);
  console.log();

  // Resolve the window (host-side; sandbox strips .git), ignore-filter the changed set.
  const focus = await resolveWindowFocus({ root, since });
  const changedFiles =
    focus.focusFiles.length > 0
      ? resolveFiles({ rootPath, files: focus.focusFiles, noIgnore: opts.ignore === false })
          .filePaths
      : [];

  // Blast radius (on by default, --no-graph to skip): risk-path importers of the changed files.
  const BLAST_CAP = 50;
  const blastAll = opts.graph !== false ? await expandByBlastRadius({ root, changedFiles }) : [];
  const changedSet = new Set(changedFiles);
  // Drop ignored importers (tests/dist) via the same filter as the changed set.
  const blastCandidates = blastAll.filter((h) => !changedSet.has(h.filePath));
  const keptBlast = new Set(
    blastCandidates.length > 0
      ? resolveFiles({
          rootPath,
          files: blastCandidates.map((h) => h.filePath),
          noIgnore: opts.ignore === false,
        }).filePaths
      : [],
  );
  const kept = blastCandidates.filter((h) => keptBlast.has(h.filePath));
  const blast = kept.slice(0, BLAST_CAP);
  const deepFiles = [...new Set([...changedFiles, ...blast.map((h) => h.filePath)])];

  console.log(
    `  Window ${focus.windowId} on ${focus.defaultBranch}: ${focus.commitCount} commit(s), ${changedFiles.length} changed file(s)${blast.length ? ` + ${blast.length} via blast radius` : ""}`,
  );
  if (kept.length > BLAST_CAP) {
    console.log(
      `  ${YELLOW}blast radius capped at ${BLAST_CAP} (${kept.length} risk-relevant importers found)${RESET}`,
    );
  }
  if (focus.shallow) {
    console.log(
      `  ${YELLOW}⚠ shallow clone — window may be truncated; run 'git fetch --unshallow' for a complete window.${RESET}`,
    );
  }
  console.log();

  // Full scan (regex, no AI). scanFiles gives every deep file a record so the
  // deep pass investigates it even with no candidates.
  const extPlan = externalScanPlan(projectId, opts);
  console.log(`${BOLD}Scanning whole repo…${RESET}`);
  await scan({ projectId, root, skipMatcherSlugs: extPlan.skipMatcherSlugs });
  if (deepFiles.length > 0) {
    await scanFiles({
      projectId,
      root,
      filePaths: deepFiles,
      source: `window-focus:${since}`,
      skipMatcherSlugs: extPlan.skipMatcherSlugs,
    });
  }
  // External scanners (trufflehog/semgrep) over the whole repo → candidates.
  runExternals(projectId, root, extPlan);
  console.log();

  if (opts.dryRun) {
    // Standard set = remaining pending candidates (deep files excluded; the deep
    // pass runs first). Only needed for this preview — the real standard pass
    // re-selects internally.
    const deepSet = new Set(deepFiles);
    const standardFiles = loadAllFileRecords(projectId).filter(
      (r) =>
        (r.status === "pending" || r.status === "error") &&
        !deepSet.has(r.filePath) &&
        r.candidates.length > 0,
    );
    console.log(`${BOLD}Dry run${RESET} — window + scan resolved, no AI investigation.`);
    console.log(
      `  ${BOLD}Deep pass${RESET} (${focusThinking}): ${deepFiles.length} file(s) — ${changedFiles.length} changed + ${blast.length} blast radius`,
    );
    for (const f of changedFiles.slice(0, 12)) console.log(`    ${DIM}${f}${RESET}`);
    if (changedFiles.length > 12)
      console.log(`    ${DIM}… and ${changedFiles.length - 12} more changed${RESET}`);
    for (const h of blast.slice(0, 12))
      console.log(`    ${DIM}${h.filePath} ← imports ${h.viaChangedFile} [${h.riskCategories.join(",")}]${RESET}`);
    if (blast.length > 12) console.log(`    ${DIM}… and ${blast.length - 12} more blast radius${RESET}`);
    console.log(
      `  ${BOLD}Standard pass${RESET} (${baseThinking}): ${standardFiles.length} repo candidate file(s)`,
    );
    for (const r of standardFiles.slice(0, 12)) console.log(`    ${DIM}${r.filePath}${RESET}`);
    if (standardFiles.length > 12)
      console.log(`    ${DIM}… and ${standardFiles.length - 12} more${RESET}`);
    console.log();
    console.log(`${GREEN}Dry run complete — zero AI spend.${RESET}`);
    return;
  }

  // Deep pass first (forced, full thinking) so the standard pass skips these.
  if (deepFiles.length > 0) {
    console.log(
      `${BOLD}Deep pass:${RESET} ${deepFiles.length} file(s) — ${changedFiles.length} changed + ${blast.length} blast radius (${focusThinking})`,
    );
    await processRun({
      projectId,
      agentType,
      config: focusConfig,
      filePaths: deepFiles,
      source: `window-focus:${since}`,
      concurrency: opts.concurrency,
      batchSize: opts.batchSize,
      rootPathOverride: root,
      onProgress: logProgress,
    });
    console.log();
  }

  // 4. Standard pass over the rest of the repo's candidates.
  console.log(`${BOLD}Standard pass:${RESET} remaining repo candidates (${baseThinking})`);
  const baseResult = await processRun({
    projectId,
    agentType,
    config: baseConfig,
    concurrency: opts.concurrency,
    batchSize: opts.batchSize,
    rootPathOverride: root,
    onProgress: logProgress,
  });

  // Cross-check the deterministic scanners against the review (targeted triage).
  await maybeCrossCheck(opts, projectId, agentType, baseConfig, root);

  // 5. Summarize what landed inside the window (line-level).
  const records = loadAllFileRecords(projectId);
  const introduced = introducedFindings(records, focus.addedLinesByFile);
  console.log();
  console.log(`${GREEN}Window run complete.${RESET} Run: ${BOLD}${baseResult.runId}${RESET}`);
  console.log(
    `  ${BOLD}${introduced.length}${RESET} finding(s) introduced in the last ${since} (line inside the window's changes)`,
  );
  console.log(`Next:`);
  console.log(
    `${DIM}pnpm deepsec report --project-id ${projectId} --duration ${JSON.stringify(since)}${RESET}`,
  );
}

async function processStandardMode(opts: Parameters<typeof processCommand>[0]) {
  const projectId = resolveProjectId(opts.projectId);
  const onlySlugs = parseCsv(opts.onlySlugs);
  const skipSlugs = parseCsv(opts.skipSlugs);
  const project = readProjectConfig(projectId);
  const effectiveRoot = opts.root ?? project.rootPath;
  const agentType = resolveAgentType(opts.agent);
  const model = opts.model ?? defaultModelForAgent(agentType);
  const agentConfig = buildAgentConfig({ ...opts, model });

  assertAgentCredential(agentType, { aiApiKeyEnv: opts.aiApiKeyEnv });

  // --reinvestigate  → true (re-investigate all)
  // --reinvestigate 2 → number (only files with < 2 analyses)
  let reinvestigate: boolean | number | undefined;
  if (opts.reinvestigate === true) {
    reinvestigate = true;
  } else if (typeof opts.reinvestigate === "string") {
    const n = parseInt(opts.reinvestigate, 10);
    if (Number.isNaN(n) || n < 1) {
      throw new Error(
        `--reinvestigate value must be a positive integer, got "${opts.reinvestigate}"`,
      );
    }
    reinvestigate = n;
  }

  console.log(`${BOLD}Processing${RESET} project ${BOLD}${projectId}${RESET}`);
  console.log(`  Agent: ${agentType} (${model})`);
  console.log(`  Root: ${effectiveRoot}${opts.root ? " (override)" : ""}`);
  if (opts.manifest) {
    console.log(`  Manifest: ${opts.manifest}`);
  }
  if (opts.runId) {
    console.log(`  Resuming run: ${opts.runId}`);
  }
  if (opts.concurrency && opts.concurrency > 1) {
    console.log(`  Concurrency: ${opts.concurrency} batches in parallel`);
  }
  if (reinvestigate === true) {
    console.log(`  ${YELLOW}Re-investigating all files (--reinvestigate)${RESET}`);
  } else if (typeof reinvestigate === "number") {
    console.log(`  ${YELLOW}Re-investigating files with < ${reinvestigate} analyses${RESET}`);
  }
  if (onlySlugs) console.log(`  Only slugs: ${onlySlugs.join(", ")}`);
  if (skipSlugs) console.log(`  Skip slugs: ${skipSlugs.join(", ")}`);
  console.log();

  const result = await processRun({
    projectId,
    runId: opts.runId,
    agentType,
    config: agentConfig,
    reinvestigate,
    limit: opts.limit,
    concurrency: opts.concurrency,
    filter: opts.filter,
    batchSize: opts.batchSize,
    rootPathOverride: opts.root,
    manifestPath: opts.manifest,
    onlySlugs,
    skipSlugs,
    onProgress: logProgress,
  });

  // Cross-check the deterministic scanners (from a prior `scan`) against the
  // review — targeted triage of anything the review didn't cover.
  await maybeCrossCheck(opts, projectId, agentType, agentConfig, effectiveRoot);

  console.log(`${GREEN}Processing complete.${RESET} Run: ${BOLD}${result.runId}${RESET}`);
  console.log(`  Analyses: ${result.analysisCount}`);
  console.log(`  Findings: ${result.findingCount}`);
  if (result.errorBatchCount > 0) {
    console.log(`  ${RED}Errored batches: ${result.errorBatchCount}${RESET}`);
  }
  console.log();

  // Quota exhaustion is a fatal, run-stopping condition. Render the
  // tailored remediation message before the generic "errored batches"
  // banner so the user sees actionable guidance first, then exit non-zero
  // — same fail-loud contract as a regular agent failure.
  if (result.quotaExhausted) {
    console.log(
      renderQuotaMessage({
        source: result.quotaExhausted.source,
        rawMessage: result.quotaExhausted.rawMessage,
        command: "process",
        projectId,
      }),
    );
    process.exit(1);
  }

  // Standard-mode parity with direct-mode: a run that crashed agent
  // batches isn't a clean review. Print the runtime hint first so
  // operators see it on success runs, then fail-loud when applicable.
  if (result.errorBatchCount === 0) {
    console.log(`Next:`);
    console.log(`${DIM}pnpm deepsec report --project-id ${projectId}${RESET}`);
    return;
  }

  console.log(
    `${RED}${result.errorBatchCount} batch(es) errored — exiting 1 (agent failure, not a clean review).${RESET}`,
  );
  console.log(
    `${DIM}Files in those batches were marked status=error and will be retried on the next run.${RESET}`,
  );
  process.exit(1);
}

/**
 * Direct invocation: scan + process a specific file list.
 *
 * Lifecycle:
 *   1. Resolve the file list (git diff / explicit files / stdin).
 *   2. Auto-create the project on disk if it isn't in deepsec.config.ts.
 *   3. Run a scoped `scanFiles()` so each path has a FileRecord — this
 *      gives the agent regex-derived signals to anchor on, even when the
 *      diff includes files outside any matcher's pattern set.
 *   4. Run `process()` over those exact paths.
 *   5. Optionally render a PR-comment markdown.
 *   6. Exit 1 if any new finding was produced. CI gates on this.
 */
async function processDirectMode(opts: Parameters<typeof processCommand>[0]) {
  const sources = [
    opts.diff !== undefined ? "--diff" : null,
    opts.diffStaged ? "--diff-staged" : null,
    opts.diffWorking ? "--diff-working" : null,
    opts.files ? "--files" : null,
    opts.filesFrom ? "--files-from" : null,
  ].filter(Boolean) as string[];
  if (sources.length > 1) {
    throw new Error(`Conflicting file sources: ${sources.join(", ")}. Pick exactly one.`);
  }

  // Warn-and-ignore options that don't apply in direct mode. The user's
  // file list IS the filter — these flags would silently subset it
  // further, which is rarely what someone passing a diff wants.
  if (opts.reinvestigate !== undefined) {
    console.warn(
      `${YELLOW}Note: --reinvestigate is ignored in direct mode (file list is authoritative).${RESET}`,
    );
  }
  if (opts.manifest) {
    console.warn(
      `${YELLOW}Note: --manifest is ignored in direct mode; --files / --files-from / --diff* take precedence.${RESET}`,
    );
  }

  const { projectId, rootPath, autoCreated } = resolveProjectIdForDirect(opts.projectId, opts.root);

  // Materialize project on disk before resolveFiles needs it (no — resolveFiles
  // doesn't need it, but scanFiles + process do, and ensureProject also normalizes
  // the rootPath in data/<id>/project.json).
  ensureProject(projectId, rootPath);

  // Resolve the file list.
  const resolved = resolveFiles({
    rootPath,
    diff: opts.diff,
    diffStaged: opts.diffStaged,
    diffWorking: opts.diffWorking,
    files: parseCsv(opts.files),
    filesFrom: opts.filesFrom,
    // Commander's `--no-ignore` toggles `opts.ignore` to false; default true.
    noIgnore: opts.ignore === false,
  });

  await runScopedInvestigation({
    projectId,
    rootPath,
    autoCreated,
    filePaths: resolved.filePaths,
    sourceLabel: resolved.sourceLabel,
    headerLabel: "Direct process",
    opts,
  });
}

/**
 * Diff-scan mode (--diff-scan --duration): investigate ONLY the window's changed
 * files, CI-style (same exit codes as direct mode). Deleted files are noted, not
 * investigated (content is gone).
 */
async function processDiffScanMode(opts: Parameters<typeof processCommand>[0]) {
  const { projectId, rootPath, autoCreated } = resolveProjectIdForDirect(opts.projectId, opts.root);
  ensureProject(projectId, rootPath);
  const since = opts.duration as string;

  console.log(`  ${DIM}Resolving window (${since})…${RESET}`);
  const focus = await resolveWindowFocus({ root: rootPath, since });
  if (focus.shallow) {
    console.log(
      `  ${YELLOW}⚠ shallow clone — window may be truncated; run 'git fetch --unshallow'.${RESET}`,
    );
  }
  if (focus.deletedFiles.length > 0) {
    console.log(
      `  ${DIM}${focus.deletedFiles.length} file(s) deleted in window — not investigated (content removed).${RESET}`,
    );
  }

  // Reuse resolveFiles purely for its ignore filter over the changed set.
  const filePaths =
    focus.focusFiles.length > 0
      ? resolveFiles({ rootPath, files: focus.focusFiles, noIgnore: opts.ignore === false })
          .filePaths
      : [];

  await runScopedInvestigation({
    projectId,
    rootPath,
    autoCreated,
    filePaths,
    sourceLabel: `window-diff:${since}`,
    headerLabel: "Diff-scan process",
    opts,
  });
}

/**
 * Shared scoped investigation core: scan an exact file list, investigate it, and
 * apply CI exit codes + optional PR comment. Used by both direct mode (the
 * --diff / --files sources) and diff-scan mode (--diff-scan --duration).
 */
async function runScopedInvestigation(params: {
  projectId: string;
  rootPath: string;
  autoCreated: boolean;
  filePaths: string[];
  sourceLabel: string;
  headerLabel: string;
  opts: Parameters<typeof processCommand>[0];
}) {
  const { projectId, rootPath, autoCreated, filePaths, sourceLabel, headerLabel, opts } = params;

  const agentType = resolveAgentType(opts.agent);
  const model = opts.model ?? defaultModelForAgent(agentType);
  const agentConfig = buildAgentConfig({ ...opts, model });
  // A dry run never calls the agent — don't require a credential to preview.
  if (!opts.dryRun) assertAgentCredential(agentType, { aiApiKeyEnv: opts.aiApiKeyEnv });

  console.log(`${BOLD}${headerLabel}${RESET} project ${BOLD}${projectId}${RESET}`);
  if (autoCreated) {
    console.log(`  ${DIM}Auto-created project at ${rootPath}${RESET}`);
  }
  console.log(`  Source: ${sourceLabel}`);
  console.log(`  Files: ${filePaths.length}`);
  console.log(`  Agent: ${agentType} (${model})`);
  console.log(`  Root: ${rootPath}`);
  console.log();

  if (filePaths.length === 0) {
    console.log(`${YELLOW}No files matched ${sourceLabel} (after ignore filter).${RESET}`);
    console.log(`${GREEN}Nothing to process — exit 0.${RESET}`);
    return;
  }

  // Scan the listed files first to gather signals. Records get written
  // for every file, even those with no matcher hits.
  const extPlan = externalScanPlan(projectId, opts);
  console.log(`${BOLD}Scanning ${filePaths.length} file(s)…${RESET}`);
  const scanResult = await scanFiles({
    projectId,
    root: rootPath,
    filePaths,
    source: sourceLabel,
    skipMatcherSlugs: extPlan.skipMatcherSlugs,
  });
  console.log(
    `  ${DIM}${scanResult.candidateCount} candidate(s) across ${scanResult.filesScanned} file(s)${RESET}`,
  );
  // External scanners (trufflehog/semgrep), scoped to the changed set → candidates.
  runExternals(projectId, rootPath, extPlan, filePaths);
  console.log();

  if (opts.dryRun) {
    console.log(`${BOLD}Dry run${RESET} — would investigate ${filePaths.length} file(s), no AI:`);
    for (const f of filePaths.slice(0, 20)) console.log(`  ${DIM}${f}${RESET}`);
    if (filePaths.length > 20) console.log(`  ${DIM}… and ${filePaths.length - 20} more${RESET}`);
    console.log();
    console.log(`${GREEN}Dry run complete — zero AI spend.${RESET}`);
    return;
  }

  // Now investigate. process() loads the records scanFiles wrote.
  const result = await processRun({
    projectId,
    runId: opts.runId,
    agentType,
    config: agentConfig,
    concurrency: opts.concurrency,
    batchSize: opts.batchSize,
    rootPathOverride: rootPath,
    filePaths,
    source: sourceLabel,
    onProgress: logProgress,
  });

  // Cross-check the deterministic scanners against the review (targeted triage).
  // Its confirmations count toward the CI gate below (a secret only trufflehog
  // caught still fails the build).
  const crossCheckFindings = await maybeCrossCheck(opts, projectId, agentType, agentConfig, rootPath);
  const findingCount = result.findingCount + crossCheckFindings;

  console.log(`${GREEN}Processing complete.${RESET} Run: ${BOLD}${result.runId}${RESET}`);
  console.log(`  Analyses: ${result.analysisCount}`);
  console.log(`  Findings: ${findingCount}`);
  if (result.errorBatchCount > 0) {
    console.log(`  ${RED}Errored batches: ${result.errorBatchCount}${RESET}`);
  }

  if (result.quotaExhausted) {
    console.log(
      renderQuotaMessage({
        source: result.quotaExhausted.source,
        rawMessage: result.quotaExhausted.rawMessage,
        command: "process",
        projectId,
      }),
    );
    process.exit(1);
  }

  // Hard-fail when any batch threw — that means the agent itself
  // failed to run (missing binary, auth error, etc.) on at least one
  // batch. A "clean run with 0 findings" is a green CI signal; we
  // can't let a silent agent crash mascarade as that.
  if (result.errorBatchCount > 0) {
    console.log();
    console.log(
      `${RED}${result.errorBatchCount} batch(es) errored — exiting 1 (agent failure, not a clean review).${RESET}`,
    );
    process.exit(1);
  }

  // Optionally write a PR-comment-shaped markdown for the workflow to
  // pass to github-script.
  if (opts.commentOut && result.findingCount > 0) {
    const md = renderPrComment({ projectId, runId: result.runId, source: sourceLabel });
    if (md) {
      const outPath = path.resolve(opts.commentOut);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, md);
      console.log(`  ${DIM}Wrote PR comment to ${outPath}${RESET}`);
    }
  }

  if (findingCount > 0) {
    console.log();
    console.log(`${RED}${findingCount} new finding(s) — exiting 1${RESET}`);
    process.exit(1);
  }
  console.log();
  console.log(`${GREEN}No findings.${RESET}`);
}
