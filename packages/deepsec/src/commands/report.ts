import fs from "node:fs";
import path from "node:path";
import type { FileRecord, Finding, Severity } from "@deepsec/core";
import { loadAllFileRecords, readProjectConfig, reportJsonPath, reportMdPath } from "@deepsec/core";
import {
  addedLinesByFile,
  type ExternalItem,
  introducedFindings,
  reconcileExternal,
  resolveWindow,
} from "@deepsec/processor";
import { readExternalFindings } from "@deepsec/scanner";
import { BOLD, DIM, RESET, severityColor } from "../formatters.js";
import { resolveProjectId } from "../resolve-project-id.js";

/** Findings whose line falls inside the window's changed hunks. null (+warn) if the window won't resolve. */
function resolveIntroduced(
  records: FileRecord[],
  root: string,
  since: string,
): (Finding & { filePath: string })[] | null {
  try {
    const window = resolveWindow({ root, since });
    const byPath = new Map(records.map((r) => [r.filePath, r]));
    return introducedFindings(records, addedLinesByFile(window)).map(({ filePath, findingIndex }) => {
      const rec = byPath.get(filePath)!;
      return { ...rec.findings[findingIndex], filePath };
    });
  } catch (err) {
    console.warn(
      `${DIM}Could not resolve --duration window (${err instanceof Error ? err.message : String(err)}); skipping the "introduced" section.${RESET}`,
    );
    return null;
  }
}

function introducedSectionMd(introduced: (Finding & { filePath: string })[], since: string): string {
  let md = `## Introduced in the last ${since} (${introduced.length})\n\n`;
  if (introduced.length === 0) {
    md += `_No findings landed on lines changed in this window._\n\n`;
    return md;
  }
  md += `Findings whose line falls inside changes on the default branch in this window.\n\n`;
  md += `| Severity | Finding | File:line |\n|----------|---------|-----------|\n`;
  for (const f of introduced) {
    const loc = `\`${f.filePath.replace(/`/g, "'")}\`${f.lineNumbers.length ? `:${f.lineNumbers[0]}` : ""}`;
    md += `| ${f.severity} | ${f.title.replace(/\|/g, "\\|")} | ${loc} |\n`;
  }
  return md + "\n";
}

const ACTIONABLE_SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "HIGH_BUG", "BUG"];
const STDOUT_PER_SEVERITY_LIMIT = 10;

function unreconciledSectionMd(open: ExternalItem[]): string {
  let md = `## ⚠️ Unreconciled deterministic findings (${open.length})\n\n`;
  md += `External-scanner (trufflehog/semgrep) hits that were neither confirmed as a finding nor dismissed with a reason. Address these before treating the report as final.\n\n`;
  md += `| Detector | File:line | Slug |\n|----------|-----------|------|\n`;
  for (const it of open) {
    md += `| ${it.detector.replace(/\|/g, "\\|")} | \`${it.filePath.replace(/`/g, "'")}\`:${it.line} | ${it.vulnSlug} |\n`;
  }
  return md + "\n";
}

function generateMarkdown(
  records: FileRecord[],
  projectId: string,
  introducedMd?: string,
  unreconciledMd?: string,
): string {
  const byPath = new Map(records.map((r) => [r.filePath, r]));
  const allFindings: (Finding & { filePath: string })[] = [];
  for (const r of records) {
    for (const f of r.findings) {
      allFindings.push({ ...f, filePath: r.filePath });
    }
  }

  const bySeverity: Record<Severity, typeof allFindings> = {
    CRITICAL: [],
    HIGH: [],
    MEDIUM: [],
    HIGH_BUG: [],
    BUG: [],
    LOW: [],
  };
  for (const f of allFindings) {
    bySeverity[f.severity].push(f);
  }

  const analyzedCount = records.filter((r) => r.status === "analyzed").length;

  let md = `# Vulnerability Scan Report\n\n`;
  md += `| Field | Value |\n|-------|-------|\n`;
  md += `| Project | ${projectId} |\n`;
  md += `| Date | ${new Date().toISOString()} |\n`;
  md += `| Files tracked | ${records.length} |\n`;
  md += `| Files analyzed | ${analyzedCount} |\n`;
  md += `| Total findings | ${allFindings.length} |\n`;
  md += `\n`;

  md += `## Summary\n\n`;
  md += `| Severity | Count |\n|----------|-------|\n`;
  md += `| CRITICAL | ${bySeverity.CRITICAL.length} |\n`;
  md += `| HIGH | ${bySeverity.HIGH.length} |\n`;
  md += `| MEDIUM | ${bySeverity.MEDIUM.length} |\n`;
  md += `| HIGH_BUG | ${bySeverity.HIGH_BUG.length} |\n`;
  md += `| BUG | ${bySeverity.BUG.length} |\n\n`;

  // The window "introduced" section (when --duration was passed) sits right
  // after the summary so it's the first thing a reader sees.
  if (introducedMd) md += introducedMd;
  if (unreconciledMd) md += unreconciledMd;

  for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "HIGH_BUG", "BUG"] as Severity[]) {
    const findings = bySeverity[severity];
    if (findings.length === 0) continue;

    md += `## ${severity} (${findings.length})\n\n`;
    for (const f of findings) {
      md += `### ${f.title}\n\n`;
      const record = byPath.get(f.filePath);
      md += `- **File:** \`${f.filePath}\`\n`;
      if (record?.gitInfo?.recentCommitters?.length) {
        const committers = record.gitInfo.recentCommitters
          .map((c) => `${c.name} <${c.email}>`)
          .join(", ");
        md += `- **Recent committers:** ${committers}\n`;
      }
      md += `- **Lines:** ${f.lineNumbers.join(", ")}\n`;
      md += `- **Slug:** ${f.vulnSlug}\n`;
      md += `- **Confidence:** ${f.confidence}\n`;
      if (f.revalidation) {
        const v = f.revalidation;
        const icon =
          v.verdict === "true-positive"
            ? "confirmed"
            : v.verdict === "false-positive"
              ? "~~false positive~~"
              : "uncertain";
        md += `- **Revalidation:** ${icon}\n`;
        md += `- **Reasoning:** ${v.reasoning}\n`;
      }
      md += `\n${f.description}\n\n`;
      md += `**Recommendation:** ${f.recommendation}\n\n`;
      md += `---\n\n`;
    }
  }

  return md;
}

export async function reportCommand(opts: {
  projectId?: string;
  runId?: string;
  duration?: string;
  requireHumanAck?: boolean;
}) {
  const projectId = resolveProjectId(opts.projectId);

  // readProjectConfig throws if data/<id>/project.json is missing — that's
  // the right behavior here (you can't report on a project that's never
  // been initialized).
  const project = readProjectConfig(projectId);
  const allRecords: FileRecord[] = loadAllFileRecords(projectId);
  let records: FileRecord[] = allRecords;

  if (opts.runId) {
    records = records.filter((r) => r.analysisHistory.some((a) => a.runId === opts.runId));
  }
  records = records.filter((r) => r.status === "analyzed");

  // Cross-check the deterministic scanner findings against the review — an
  // uncovered, undismissed hit is "open" and must be surfaced.
  const externalHits = readExternalFindings(projectId).map((f) => ({
    filePath: f.filePath,
    slug: f.slug,
    line: f.line,
    detector: f.detector,
  }));
  const reconciled = reconcileExternal(allRecords, externalHits, {
    requireHumanAck: opts.requireHumanAck,
  });
  const openExternal = reconciled.filter((i) => i.status === "open");

  if (records.length === 0) {
    console.log("No analyzed files found. Run `deepsec process` first.");
    return;
  }

  const findingsBySeverity: Record<Severity, (Finding & { filePath: string })[]> = {
    CRITICAL: [],
    HIGH: [],
    MEDIUM: [],
    HIGH_BUG: [],
    BUG: [],
    LOW: [],
  };
  for (const r of records) {
    for (const f of r.findings) {
      findingsBySeverity[f.severity].push({ ...f, filePath: r.filePath });
    }
  }
  const totalFindings = ACTIONABLE_SEVERITIES.reduce(
    (sum, sev) => sum + findingsBySeverity[sev].length,
    0,
  );

  // Optional "introduced in the last <duration>" overlay (line-level match).
  const introduced = opts.duration ? resolveIntroduced(records, project.rootPath, opts.duration) : null;
  const introducedMd =
    opts.duration && introduced ? introducedSectionMd(introduced, opts.duration) : undefined;

  const jsonPath = reportJsonPath(projectId, opts.runId);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  const reportData = {
    projectId,
    generatedAt: new Date().toISOString(),
    runId: opts.runId ?? null,
    summary: {
      filesAnalyzed: records.length,
      totalFindings,
      critical: findingsBySeverity.CRITICAL.length,
      high: findingsBySeverity.HIGH.length,
      medium: findingsBySeverity.MEDIUM.length,
      highBug: findingsBySeverity.HIGH_BUG.length,
      bug: findingsBySeverity.BUG.length,
    },
    files: records.map((r) => ({
      filePath: r.filePath,
      findings: r.findings,
      analysisHistory: r.analysisHistory,
    })),
    ...(opts.duration && introduced
      ? {
          introduced: {
            duration: opts.duration,
            count: introduced.length,
            findings: introduced.map((f) => ({
              filePath: f.filePath,
              title: f.title,
              severity: f.severity,
              lineNumbers: f.lineNumbers,
            })),
          },
        }
      : {}),
    external: {
      confirmed: reconciled.filter((i) => i.status === "confirmed").length,
      dismissed: reconciled.filter((i) => i.status === "dismissed").length,
      acknowledged: reconciled.filter((i) => i.status === "acknowledged").length,
      open: openExternal,
    },
  };
  fs.writeFileSync(jsonPath, JSON.stringify(reportData, null, 2) + "\n");

  const unreconciledMd = openExternal.length > 0 ? unreconciledSectionMd(openExternal) : undefined;
  const mdPath = reportMdPath(projectId, opts.runId);
  fs.writeFileSync(mdPath, generateMarkdown(records, projectId, introducedMd, unreconciledMd));

  printStdoutSummary({
    projectId,
    runId: opts.runId,
    records,
    findingsBySeverity,
    totalFindings,
    jsonPath,
    mdPath,
  });

  if (opts.duration && introduced) {
    console.log();
    console.log(
      `${BOLD}Introduced in the last ${opts.duration}:${RESET} ${introduced.length} finding(s) on lines changed in the window`,
    );
    for (const f of introduced.slice(0, STDOUT_PER_SEVERITY_LIMIT)) {
      const loc = f.lineNumbers.length ? `:${f.lineNumbers[0]}` : "";
      console.log(`  • ${severityColor(f.severity)}${f.severity}${RESET} ${f.title}`);
      console.log(`    ${DIM}${f.filePath}${loc}${RESET}`);
    }
    if (introduced.length > STDOUT_PER_SEVERITY_LIMIT) {
      console.log(`    ${DIM}… and ${introduced.length - STDOUT_PER_SEVERITY_LIMIT} more${RESET}`);
    }
  }

  // Soft gate: report is written, but unreconciled deterministic findings are
  // surfaced and the command exits non-zero so a pipeline can't treat the run
  // as final while trufflehog/semgrep hits sit unaddressed.
  if (openExternal.length > 0) {
    console.log();
    console.log(
      `${BOLD}⚠ ${openExternal.length} unreconciled deterministic finding(s)${RESET} — neither confirmed nor dismissed${opts.requireHumanAck ? " (human ack required)" : ""}:`,
    );
    for (const it of openExternal.slice(0, STDOUT_PER_SEVERITY_LIMIT)) {
      console.log(`  • ${it.detector} ${DIM}${it.filePath}:${it.line}${RESET}`);
    }
    if (openExternal.length > STDOUT_PER_SEVERITY_LIMIT) {
      console.log(`    ${DIM}… and ${openExternal.length - STDOUT_PER_SEVERITY_LIMIT} more${RESET}`);
    }
    process.exitCode = 1;
  }
}

function printStdoutSummary(args: {
  projectId: string;
  runId?: string;
  records: FileRecord[];
  findingsBySeverity: Record<Severity, (Finding & { filePath: string })[]>;
  totalFindings: number;
  jsonPath: string;
  mdPath: string;
}) {
  const { projectId, runId, records, findingsBySeverity, totalFindings, jsonPath, mdPath } = args;
  const date = new Date().toISOString().slice(0, 10);

  console.log();
  console.log(`${BOLD}Vulnerability scan report — ${projectId}${RESET}`);
  console.log(`${DIM}Generated ${date}${runId ? ` · run ${runId}` : ""}${RESET}`);
  console.log();
  console.log(`  Files analyzed: ${records.length}`);
  console.log(`  Findings:       ${totalFindings}`);
  console.log();

  // Severity breakdown — show every actionable severity even if zero so the
  // reader sees the shape of the result, not just what fired.
  for (const severity of ACTIONABLE_SEVERITIES) {
    const count = findingsBySeverity[severity].length;
    const padded = severity.padEnd(8);
    const color = count > 0 ? severityColor(severity) : DIM;
    console.log(`  ${color}${padded}${RESET}  ${count}`);
  }

  // Top findings, severity-ordered. Skips false-positive/fixed/duplicate
  // verdicts — those are noise once revalidate has run (duplicates point
  // at a primary that's still in the list).
  for (const severity of ACTIONABLE_SEVERITIES) {
    const findings = findingsBySeverity[severity].filter((f) => {
      const v = f.revalidation?.verdict;
      return v !== "false-positive" && v !== "fixed" && v !== "duplicate";
    });
    if (findings.length === 0) continue;

    console.log();
    console.log(`${severityColor(severity)}${BOLD}${severity}${RESET} (${findings.length})`);
    for (const f of findings.slice(0, STDOUT_PER_SEVERITY_LIMIT)) {
      const lines = f.lineNumbers.length > 0 ? `:${f.lineNumbers[0]}` : "";
      console.log(`  • ${f.title}`);
      console.log(`    ${DIM}${f.filePath}${lines}${RESET}`);
    }
    const remaining = findings.length - STDOUT_PER_SEVERITY_LIMIT;
    if (remaining > 0) {
      console.log(`    ${DIM}… and ${remaining} more${RESET}`);
    }
  }

  console.log();
  console.log(`${DIM}Reports written:${RESET}`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);
}
