import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "@deepsec/core";
import { readTechJson } from "../detect-tech.js";

// Optional OSS scanners run as a deterministic pass: trufflehog for secrets,
// semgrep for SAST. Their findings are stored ASIDE (data/<id>/external/
// findings.json), NOT merged into the scan's candidates — the AI review stays
// unbiased and cross-checks these afterward. Both no-op if the binary is absent.

export interface ExternalFinding {
  filePath: string; // repo-relative POSIX
  line: number;
  slug: string;
  detector: string; // trufflehog detector or semgrep rule id
  snippet: string;
}

export interface ExternalResult {
  trufflehog: boolean; // ran
  semgrep: boolean; // ran
  findings: number;
}

const TRUFFLEHOG_SLUG = "trufflehog-secret";

function hasBinary(bin: string): boolean {
  try {
    return (spawnSync(bin, ["--version"], { timeout: 10_000 }).status ?? 1) === 0;
  } catch {
    return false;
  }
}

function toRel(root: string, file: string): string {
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
  // Strip a leading `./` (we pass `./`-prefixed targets; some scanners echo it
  // back) so the path matches the repo-relative form used in file records.
  return rel.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Make a scan target safe to pass as a positional argv token. Repo-relative
 * paths come from the scanned repo (untrusted): a file named `-x.js` would be
 * read as a flag by trufflehog/semgrep. `./`-prefixing forces it to a path so a
 * malicious filename can't inject scanner options. Exported for the self-check.
 */
export function toPositional(p: string): string {
  return path.isAbsolute(p) || p.startsWith("./") ? p : `./${p}`;
}

/** Parse `trufflehog … --json` (one JSON object per line). Exported for the self-check. */
export function parseTrufflehogOutput(stdout: string, root: string): ExternalFinding[] {
  const out: ExternalFinding[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const fsMeta = (o.SourceMetadata as { Data?: { Filesystem?: { file?: string; line?: number } } })
      ?.Data?.Filesystem;
    if (!fsMeta?.file) continue;
    const detector = String(o.DetectorName ?? "secret");
    const verified = o.Verified === true;
    out.push({
      filePath: toRel(root, fsMeta.file),
      line: Math.max(1, Number(fsMeta.line ?? 1)),
      slug: TRUFFLEHOG_SLUG,
      detector,
      snippet: `${detector} secret${verified ? " (verified)" : ""}: ${String(o.Redacted ?? "").slice(0, 80)}`,
    });
  }
  return out;
}

/** Parse `semgrep --json`. Exported for the self-check. */
export function parseSemgrepOutput(stdout: string, root: string): ExternalFinding[] {
  let parsed: { results?: unknown[] };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const out: ExternalFinding[] = [];
  for (const r of parsed.results ?? []) {
    const res = r as {
      check_id?: string;
      path?: string;
      start?: { line?: number };
      extra?: { message?: string; lines?: string };
    };
    if (!res.path) continue;
    const ruleId = String(res.check_id ?? "semgrep-rule");
    // Short slug from the rule's last segment so it groups sensibly.
    const tail = ruleId.split(".").pop() ?? ruleId;
    out.push({
      filePath: toRel(root, res.path),
      line: Math.max(1, Number(res.start?.line ?? 1)),
      slug: `semgrep-${tail}`.slice(0, 60),
      detector: ruleId,
      snippet: (res.extra?.message ?? res.extra?.lines ?? "").slice(0, 200),
    });
  }
  return out;
}

type ScanRun = { findings: ExternalFinding[]; error: string | null } | null; // null = not installed

function runTrufflehog(root: string, targets: string[]): ScanRun {
  if (!hasBinary("trufflehog")) return null;
  // Scope to the changed files in diff-scan (trufflehog filesystem takes paths)
  // instead of scanning the whole repo and discarding most of it.
  const paths = targets.length > 0 ? targets.map(toPositional) : [root];
  const r = spawnSync(
    "trufflehog",
    [
      "filesystem",
      ...paths,
      "--json",
      "--no-verification",
      "--no-update",
      // Report everything: all detectors, and every result type (not just
      // verified). No --filter-entropy / --filter-unverified, so low-entropy
      // and duplicate unverified hits are kept too. Explicit so a trufflehog
      // default change can't silently narrow recall.
      "--include-detectors=all",
      "--results=verified,unverified,unknown",
    ],
    { cwd: root, encoding: "utf-8", timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 },
  );
  // trufflehog can exit non-zero when it *finds* secrets (findings on stdout),
  // so a non-zero exit alone isn't an error. But a non-zero exit with EMPTY
  // stdout is a real failure (bad args, parse error) — treat it as such rather
  // than silently reporting a clean 0-findings run.
  const status = r.status ?? 0;
  const error = r.error
    ? r.error.message
    : status !== 0 && !(r.stdout ?? "").trim()
      ? `trufflehog exited ${status}: ${(r.stderr ?? "").trim().slice(0, 300)}`
      : null;
  return { findings: parseTrufflehogOutput(r.stdout ?? "", root), error };
}

// Detected tag (from detect-tech) → semgrep registry language pack. Only packs
// that reliably exist in the registry — an unknown --config makes semgrep exit
// non-zero and drops the whole run. Frameworks map to their language's pack.
const TAG_TO_SEMGREP_PACK: Record<string, string> = {
  // JS/TS ecosystem
  node: "p/javascript",
  bun: "p/javascript",
  deno: "p/javascript",
  express: "p/javascript",
  fastify: "p/javascript",
  koa: "p/javascript",
  hapi: "p/javascript",
  nestjs: "p/typescript",
  next: "p/typescript",
  nextjs: "p/typescript",
  nuxt: "p/typescript",
  nuxt3: "p/typescript",
  react: "p/typescript",
  remix: "p/typescript",
  sveltekit: "p/typescript",
  astro: "p/typescript",
  hono: "p/typescript",
  trpc: "p/typescript",
  // Python
  python: "p/python",
  django: "p/python",
  djangorestframework: "p/python",
  flask: "p/python",
  fastapi: "p/python",
  sanic: "p/python",
  starlette: "p/python",
  tornado: "p/python",
  falcon: "p/python",
  bottle: "p/python",
  aiohttp: "p/python",
  celery: "p/python",
  airflow: "p/python",
  // Go
  go: "p/golang",
  gin: "p/golang",
  echo: "p/golang",
  fiber: "p/golang",
  chi: "p/golang",
  gorilla: "p/golang",
  buffalo: "p/golang",
  // Ruby
  ruby: "p/ruby",
  rails: "p/ruby",
  sinatra: "p/ruby",
  grape: "p/ruby",
  hanami: "p/ruby",
  // PHP
  php: "p/php",
  laravel: "p/php",
  symfony: "p/php",
  cakephp: "p/php",
  codeigniter: "p/php",
  drupal: "p/php",
  magento: "p/php",
  wordpress: "p/php",
  yii: "p/php",
  // JVM
  jvm: "p/java",
  spring: "p/java",
  micronaut: "p/java",
  jaxrs: "p/java",
  // .NET
  dotnet: "p/csharp",
  // Rust
  rust: "p/rust",
  actix: "p/rust",
  axum: "p/rust",
  rocket: "p/rust",
  // Infra
  terraform: "p/terraform",
  docker: "p/docker",
};

/** Language-specific semgrep packs implied by the detected tech tags. */
export function semgrepLangPacks(tags: string[]): string[] {
  const packs = new Set<string>();
  for (const t of tags) {
    const pack = TAG_TO_SEMGREP_PACK[t];
    if (pack) packs.add(pack);
  }
  return [...packs].sort();
}

function runSemgrep(root: string, configs: string[], targets: string[]): ScanRun {
  if (!hasBinary("semgrep")) return null;
  const args = [
    "--json",
    "--quiet",
    "--disable-version-check",
    ...configs.flatMap((c) => ["--config", c]),
    ...(targets.length > 0 ? targets.map(toPositional) : [root]),
  ];
  const r = spawnSync("semgrep", args, {
    cwd: root,
    encoding: "utf-8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 512 * 1024 * 1024,
  });
  // semgrep: 0 = clean, 1 = findings, ≥2 = real error (bad config, no rules, …).
  const status = r.status ?? 2;
  const error =
    r.error?.message ??
    (status >= 2 ? `semgrep exited ${status}: ${(r.stderr ?? "").trim().slice(0, 300)}` : null);
  return { findings: parseSemgrepOutput(r.stdout ?? "", root), error };
}

function findingsPath(projectId: string): string {
  return path.join(dataDir(projectId), "external", "findings.json");
}

/** Deterministic findings stored aside by the last external run (for the cross-check). */
export function readExternalFindings(projectId: string): ExternalFinding[] {
  try {
    return JSON.parse(fs.readFileSync(findingsPath(projectId), "utf-8")) as ExternalFinding[];
  } catch {
    return [];
  }
}

/**
 * Run whichever of trufflehog/semgrep is installed and store their findings
 * aside in data/<id>/external/ (findings.json + per-scanner raw). Does NOT touch
 * candidates — the AI review stays unbiased; `crossCheckExternalFindings`
 * reconciles these afterward. `filePaths` scopes which files are kept (diff-scan).
 */
export function runExternalScanners(params: {
  projectId: string;
  root: string;
  /** Base semgrep configs (user override, or the default security-audit pack). */
  semgrepConfigs: string[];
  /** Append language packs implied by the detected tech (skipped when the user overrode configs). */
  semgrepAutoLangPacks?: boolean;
  filePaths?: string[];
  onLog?: (msg: string) => void;
}): ExternalResult {
  const { projectId, root, semgrepConfigs, semgrepAutoLangPacks, filePaths, onLog } = params;
  const only = filePaths ? new Set(filePaths.map((p) => p.replaceAll("\\", "/"))) : undefined;
  const outDir = path.join(dataDir(projectId), "external");
  fs.mkdirSync(outDir, { recursive: true });

  // tech.json is written by the scan/scanFiles pass that always precedes this,
  // so language-pack targeting reflects the repo without a second detection.
  const langPacks = semgrepAutoLangPacks ? semgrepLangPacks(readTechJson(projectId)?.tags ?? []) : [];
  const configs = [...new Set([...semgrepConfigs, ...langPacks])];

  let findings: ExternalFinding[] = [];
  const th = runTrufflehog(root, filePaths ?? []);
  if (th) {
    fs.writeFileSync(path.join(outDir, "trufflehog.json"), JSON.stringify(th.findings, null, 2));
    findings = findings.concat(th.findings);
    if (th.error) onLog?.(`⚠ trufflehog failed to run: ${th.error}`);
    else onLog?.(`trufflehog: ${th.findings.length} secret finding(s)`);
  }
  const sg = runSemgrep(root, configs, filePaths ?? []);
  if (sg) {
    fs.writeFileSync(path.join(outDir, "semgrep.json"), JSON.stringify(sg.findings, null, 2));
    findings = findings.concat(sg.findings);
    if (sg.error) onLog?.(`⚠ semgrep failed to run: ${sg.error}`);
    else onLog?.(`semgrep (${configs.join(", ")}): ${sg.findings.length} finding(s)`);
  }

  if (only) findings = findings.filter((f) => only.has(f.filePath));
  fs.writeFileSync(findingsPath(projectId), JSON.stringify(findings, null, 2));
  return { trufflehog: th !== null, semgrep: sg !== null, findings: findings.length };
}

/** Whether trufflehog is available — the scan layer skips its own secret matchers when so. */
export function trufflehogAvailable(): boolean {
  return hasBinary("trufflehog");
}
