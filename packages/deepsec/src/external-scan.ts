import fs from "node:fs";
import path from "node:path";
import { dataDir, loadAllFileRecords, writeFileRecord } from "@deepsec/core";
import { process as processRun, reconcileExternal } from "@deepsec/processor";
import { readExternalFindings, runExternalScanners, trufflehogAvailable } from "@deepsec/scanner";
import { BOLD, DIM, RESET } from "./formatters.js";

// deepsec's own secret-leak matchers, skipped when trufflehog is present (it
// owns secret detection). Override via config.json:secretMatcherSlugs.
const DEFAULT_SECRET_MATCHERS = [
  "secret-env-var",
  "secret-in-fallback",
  "secret-in-log",
  "secrets-exposure",
  "secrets-plaintext-exposure",
  "tf-secret-in-data",
];

function readProjectConfigJson(projectId: string): {
  semgrepConfig?: string;
  secretMatcherSlugs?: string[];
} {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(projectId), "config.json"), "utf-8"));
  } catch {
    return {};
  }
}

export interface ExternalScanPlan {
  runExternal: boolean;
  useTrufflehog: boolean;
  /** Secret matchers to drop from the deepsec scan (when trufflehog is present). */
  skipMatcherSlugs?: string[];
  /** Base semgrep configs (comma-separated user override, or the default pack). */
  semgrepConfigs: string[];
  /** Augment with language packs from detected tech — only when the user didn't override. */
  semgrepAutoLangPacks: boolean;
}

/** Resolve whether/how external scanners run for this project (shared by scan + window modes). */
export function externalScanPlan(projectId: string, opts: { external?: boolean }): ExternalScanPlan {
  const runExternal = opts.external !== false;
  const cfg = readProjectConfigJson(projectId);
  const useTrufflehog = runExternal && trufflehogAvailable();
  // A user override (config.json:semgrepConfig, comma-separated for multiple) is
  // taken verbatim; otherwise security-audit is the base and language packs are
  // added automatically from the detected tech.
  const override = cfg.semgrepConfig
    ?.split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return {
    runExternal,
    useTrufflehog,
    skipMatcherSlugs: useTrufflehog
      ? (cfg.secretMatcherSlugs ?? DEFAULT_SECRET_MATCHERS)
      : undefined,
    semgrepConfigs: override?.length ? override : ["p/security-audit"],
    semgrepAutoLangPacks: !override?.length,
  };
}

/**
 * Run trufflehog/semgrep (if present) and merge their findings as candidates.
 * `filePaths` scopes which files' findings are merged (diff-scan). No-op when
 * disabled; prints a summary line.
 */
export function runExternals(
  projectId: string,
  root: string,
  plan: ExternalScanPlan,
  filePaths?: string[],
): void {
  if (!plan.runExternal) return;
  const ext = runExternalScanners({
    projectId,
    root,
    semgrepConfigs: plan.semgrepConfigs,
    semgrepAutoLangPacks: plan.semgrepAutoLangPacks,
    filePaths,
    onLog: (msg) => console.log(`  ${DIM}${msg}${RESET}`),
  });
  if (ext.trufflehog || ext.semgrep) {
    const ran = [ext.trufflehog && "trufflehog", ext.semgrep && "semgrep"]
      .filter(Boolean)
      .join(" + ");
    console.log(`${BOLD}External scanners${RESET} (${ran}): ${ext.findings} finding(s) stored aside`);
  } else {
    console.log(`${DIM}External scanners: trufflehog/semgrep not installed — skipped${RESET}`);
  }
}

/**
 * Phase 2 (auto, after the unbiased review): cross-check the stored deterministic
 * findings against the review. Hits the review already covered need nothing; the
 * rest are seeded as candidates and re-investigated (targeted) so the AI confirms
 * each (→ finding) or dismisses it (→ dismissal ledger, with reason). Keeps the
 * main review unbiased — external hits only enter here, after it's done.
 *
 * Returns the number of findings the re-investigation confirmed, so CI gates
 * can count cross-check confirmations alongside the main review's findings.
 */
export async function crossCheckExternalFindings(params: {
  projectId: string;
  agentType: string;
  config: Record<string, unknown>;
  rootPathOverride?: string;
  concurrency?: number;
  batchSize?: number;
  onProgress?: Parameters<typeof processRun>[0]["onProgress"];
}): Promise<number> {
  const { projectId } = params;
  // ExternalFinding is structurally an ExternalHit (+snippet) — no re-map needed.
  const hits = readExternalFindings(projectId);
  if (hits.length === 0) return 0;

  const records = loadAllFileRecords(projectId);
  const byPath = new Map(records.map((r) => [r.filePath, r]));
  const items = reconcileExternal(records, hits);
  const uncovered = hits.filter((_, i) => items[i].status === "open");
  if (uncovered.length === 0) {
    console.log(`${DIM}Cross-check: all ${hits.length} deterministic hit(s) covered by review${RESET}`);
    return 0;
  }

  // Seed uncovered hits as candidates so the scoped re-investigation prompt
  // surfaces them for confirm/dismiss.
  const files = new Set<string>();
  for (const h of uncovered) {
    files.add(h.filePath);
    let rec = byPath.get(h.filePath);
    if (!rec) {
      rec = {
        filePath: h.filePath,
        projectId,
        candidates: [],
        lastScannedAt: new Date().toISOString(),
        lastScannedRunId: "external",
        fileHash: "",
        findings: [],
        analysisHistory: [],
        status: "pending",
      };
      byPath.set(h.filePath, rec);
    }
    const dup = rec.candidates.some(
      (c) => c.vulnSlug === h.slug && c.lineNumbers.join(",") === String(h.line),
    );
    if (!dup) {
      rec.candidates.push({
        vulnSlug: h.slug,
        lineNumbers: [h.line],
        snippet: h.snippet,
        matchedPattern: h.detector,
      });
      writeFileRecord(rec);
    }
  }

  console.log(
    `${BOLD}Cross-check:${RESET} triaging ${uncovered.length} deterministic hit(s) the review didn't cover`,
  );
  const result = await processRun({
    projectId,
    agentType: params.agentType,
    config: params.config,
    filePaths: [...files],
    reinvestigate: true,
    rootPathOverride: params.rootPathOverride,
    concurrency: params.concurrency,
    batchSize: params.batchSize,
    source: "external-crosscheck",
    onProgress: params.onProgress,
  });
  return result.findingCount;
}
