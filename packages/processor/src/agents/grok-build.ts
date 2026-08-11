import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RefusalReport } from "@deepsec/core";
import {
  backoff,
  buildInvestigateJsonRepairPrompt,
  buildInvestigatePrompt,
  buildRevalidateJsonRepairPrompt,
  buildRevalidatePrompt,
  classifyQuotaError,
  formatJsonRepairFailureDebugText,
  isTransientError,
  jsonRepairFailureError,
  MAX_ATTEMPTS,
  type ParsedInvestigateResults,
  parseInvestigateResults,
  parseRefusalReport,
  parseRevalidateVerdicts,
  QuotaExhaustedError,
  REFUSAL_FOLLOWUP_PROMPT,
  runInvestigateFieldRepairLoop,
  runRevalidateIdRepairLoop,
  writeParseFailureDebug,
} from "./shared.js";
import type {
  AgentPlugin,
  AgentProgress,
  BatchMeta,
  InvestigateOutput,
  InvestigateParams,
  InvestigateResult,
  RevalidateOutput,
  RevalidateParams,
  RevalidateRawResponse,
  RevalidateVerdict,
  SetupTaskParams,
} from "./types.js";

/**
 * Grok Build (xAI) coding-agent backend.
 *
 * Spawns the local `grok` CLI in headless mode (`-p`) with a restricted
 * tool allowlist and optional OS sandbox. Same prompt + JSON schema as the
 * other backends; investigation output is parsed by the shared helpers.
 *
 * Auth:
 *   - `XAI_API_KEY` in the environment, or
 *   - an existing `~/.grok/auth.json` from `grok login` (mirrored into an
 *     isolated per-run GROK_HOME so user skills/plugins are not loaded).
 */

const DEFAULT_MODEL = "grok-4.5";
const DEFAULT_THINKING_LEVEL = "xhigh";

/** Read-only tools for investigation / revalidation (internal Grok tool ids). */
const INVESTIGATE_TOOLS = "read_file,grep,list_dir,run_terminal_cmd";
/** Even tighter set for setup analysis. */
const SETUP_TOOLS = "read_file,grep,list_dir";

const GROK_ENV_ALLOWLIST = new Set<string>([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_NUMERIC",
  "LC_TIME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "GROK_HOME",
  "GROK_DISABLE_AUTOUPDATER",
  "GROK_SANDBOX",
  "RUST_LOG",
  "RUST_BACKTRACE",
]);

export interface GrokJsonResult {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    reasoning_tokens?: number;
    total_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  type?: string;
  message?: string;
}

interface GrokRunResult {
  resultText: string;
  meta: Partial<BatchMeta>;
  raw: GrokJsonResult;
}

interface GrokRunOptions {
  prompt: string;
  projectRoot: string;
  model: string;
  maxTurns: number;
  tools: string;
  thinkingLevel: string;
  /** Resume an existing session (JSON repair / refusal follow-up). */
  resumeSessionId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
  /** Isolated GROK_HOME for this batch; created if omitted. */
  grokHome?: string;
  /** Keep the home dir after the run (needed when resuming). */
  keepHome?: boolean;
}

function resolveThinkingLevel(config: Record<string, unknown>): string {
  const level = config.thinkingLevel ?? config.reasoningEffort;
  if (typeof level === "string" && level.length > 0) return level;
  return DEFAULT_THINKING_LEVEL;
}

function resolveGrokBinary(): string {
  if (process.env.GROK_EXECUTABLE) return process.env.GROK_EXECUTABLE;
  // Common install locations before falling back to PATH.
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "grok"),
    path.join(os.homedir(), ".grok", "bin", "grok"),
    "/opt/homebrew/bin/grok",
    "/usr/local/bin/grok",
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // try next
    }
  }
  return "grok";
}

/**
 * Build a minimal GROK_HOME so deepsec does not inherit the operator's
 * 400+ skills, MCP servers, and plugins (those bloat the system prompt
 * and burn tokens on every batch).
 *
 * Mirrors `auth.json` when present so OAuth login works without
 * XAI_API_KEY. Prefer symlink so token refresh writes back to the
 * real home; copy as fallback.
 */
export function makeIsolatedGrokHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-grok-home-"));
  fs.writeFileSync(
    path.join(home, "config.toml"),
    [
      "[ui]",
      'permission_mode = "dontAsk"',
      "",
      "[cli]",
      "auto_update = false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const userHomes = [
    process.env.GROK_HOME,
    path.join(os.homedir(), ".grok"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const userHome of userHomes) {
    const auth = path.join(userHome, "auth.json");
    if (!fs.existsSync(auth)) continue;
    const dst = path.join(home, "auth.json");
    try {
      fs.symlinkSync(auth, dst);
    } catch {
      fs.copyFileSync(auth, dst);
      fs.chmodSync(dst, 0o600);
    }
    break;
  }

  return home;
}

/** Exported for tests. */
export function buildGrokEnv(grokHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (GROK_ENV_ALLOWLIST.has(k) || k.startsWith("LC_")) {
      env[k] = v;
    }
  }
  env.GROK_HOME = grokHome;
  env.GROK_DISABLE_AUTOUPDATER = "1";
  // Forward only the credential the CLI actually needs. Never ship
  // GITHUB_TOKEN / AWS_* / etc. into a prompt-injectionable shell.
  for (const k of ["XAI_API_KEY", "XAI_API_BASE_URL"]) {
    const v = process.env[k];
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

function sandboxProfile(): string {
  // Nested OS sandbox inside a Vercel Sandbox microVM is unnecessary.
  if (process.env.DEEPSEC_INSIDE_SANDBOX === "1") return "off";
  // Read-only project FS; agent can still write session state under GROK_HOME.
  return process.env.DEEPSEC_GROK_SANDBOX ?? "read-only";
}

function parseGrokStdout(stdout: string): GrokJsonResult {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Grok produced empty stdout");
  // Prefer the last complete JSON object (in case any banner leaked).
  try {
    return JSON.parse(trimmed) as GrokJsonResult;
  } catch {
    const start = trimmed.lastIndexOf("{");
    if (start < 0) throw new Error(`Grok stdout was not JSON: ${trimmed.slice(0, 200)}`);
    return JSON.parse(trimmed.slice(start)) as GrokJsonResult;
  }
}

function metaFromGrokJson(raw: GrokJsonResult): Partial<BatchMeta> {
  const meta: Partial<BatchMeta> = {
    agentSessionId: raw.sessionId,
    numTurns: raw.num_turns,
  };
  if (typeof raw.total_cost_usd === "number") {
    meta.costUsd = raw.total_cost_usd;
  }
  if (raw.usage) {
    meta.usage = {
      inputTokens: raw.usage.input_tokens ?? 0,
      outputTokens: raw.usage.output_tokens ?? 0,
      cacheReadInputTokens: raw.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: raw.usage.cache_creation_input_tokens ?? 0,
    };
  }
  return meta;
}

/**
 * Run one headless Grok prompt. Uses `--output-format json` so the final
 * result is a single parseable object with text + spend metadata.
 * Progress is coarse (started / complete) because the json format only
 * emits at the end; streaming-messages-json is available later if we
 * need tool-level progress.
 */
export async function runGrokHeadless(opts: GrokRunOptions): Promise<GrokRunResult> {
  const bin = resolveGrokBinary();
  const grokHome = opts.grokHome ?? makeIsolatedGrokHome();
  const ownHome = opts.grokHome === undefined;
  const sandbox = sandboxProfile();

  const args = [
    "-p",
    opts.prompt,
    "--cwd",
    opts.projectRoot,
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--tools",
    opts.tools,
    "--max-turns",
    String(opts.maxTurns),
    "-m",
    opts.model,
    "--reasoning-effort",
    opts.thinkingLevel,
    "--sandbox",
    sandbox,
    "--no-subagents",
    "--disable-web-search",
    "--no-memory",
    "--verbatim",
    // Block write tools even if a future CLI change expands the allowlist.
    "--disallowed-tools",
    "search_replace,write,image_gen,image_edit,image_to_video,reference_to_video,Agent",
  ];

  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }

  const env = buildGrokEnv(grokHome);
  // Write large prompts to a temp file to stay under ARG_MAX.
  let promptFile: string | undefined;
  if (Buffer.byteLength(opts.prompt, "utf8") > 80_000) {
    promptFile = path.join(
      os.tmpdir(),
      `deepsec-grok-prompt-${crypto.randomBytes(8).toString("hex")}.txt`,
    );
    fs.writeFileSync(promptFile, opts.prompt, { mode: 0o600 });
    // Replace -p PROMPT with --prompt-file.
    const pIdx = args.indexOf("-p");
    if (pIdx >= 0) {
      args.splice(pIdx, 2, "--prompt-file", promptFile);
    }
  }

  opts.onProgress?.({
    type: "started",
    message: `Running Grok Build (${opts.model}, effort=${opts.thinkingLevel})`,
  });

  try {
    const { stdout, stderr, code } = await spawnCollect({
      bin,
      args,
      env,
      cwd: opts.projectRoot,
      signal: opts.signal,
    });

    if (code !== 0) {
      const errText = (stderr || stdout || `exit ${code}`).trim();
      const quota = classifyQuotaError(errText);
      if (quota) throw new QuotaExhaustedError(quota, errText);
      // JSON error objects on stdout with non-zero exit.
      try {
        const errObj = parseGrokStdout(stdout);
        if (errObj.type === "error" || errObj.message) {
          const msg = errObj.message ?? errText;
          const q = classifyQuotaError(msg);
          if (q) throw new QuotaExhaustedError(q, msg);
          throw new Error(`Grok failed: ${msg}`);
        }
      } catch (e) {
        if (e instanceof QuotaExhaustedError) throw e;
        // fall through
      }
      throw new Error(`Grok exited ${code}: ${errText.slice(0, 500)}`);
    }

    const raw = parseGrokStdout(stdout);
    if (raw.type === "error") {
      const msg = raw.message ?? "unknown Grok error";
      const q = classifyQuotaError(msg);
      if (q) throw new QuotaExhaustedError(q, msg);
      throw new Error(`Grok error: ${msg}`);
    }

    const resultText = String(raw.text ?? "").trim();
    if (!resultText) {
      throw new Error(
        `Grok produced no result text (stopReason=${raw.stopReason ?? "?"}, turns=${raw.num_turns ?? "?"}).`,
      );
    }

    return {
      resultText,
      meta: metaFromGrokJson(raw),
      raw,
    };
  } finally {
    if (promptFile) {
      try {
        fs.unlinkSync(promptFile);
      } catch {
        // ignore
      }
    }
    if (ownHome && !opts.keepHome) {
      try {
        fs.rmSync(grokHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

function spawnCollect(params: {
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new Error("Aborted before Grok spawn"));
      return;
    }

    const child = spawn(params.bin, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const onAbort = () => {
      child.kill("SIGTERM");
      // Escalate if the CLI ignores SIGTERM.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2_000).unref?.();
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      params.signal?.removeEventListener("abort", onAbort);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `Grok Build CLI not found (${params.bin}). Install Grok Build and ensure \`grok\` is on PATH, or set GROK_EXECUTABLE.`,
          ),
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      params.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code });
    });
  });
}

async function runToollessFollowUp(params: {
  sessionId: string | undefined;
  grokHome: string;
  projectRoot: string;
  model: string;
  thinkingLevel: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  if (!params.sessionId) return undefined;
  try {
    const run = await runGrokHeadless({
      prompt: params.prompt,
      projectRoot: params.projectRoot,
      model: params.model,
      maxTurns: 1,
      tools: "",
      thinkingLevel: "low",
      resumeSessionId: params.sessionId,
      signal: params.signal,
      grokHome: params.grokHome,
      keepHome: true,
    });
    return run.resultText;
  } catch {
    return undefined;
  }
}

export async function runGrokSetupTask(params: SetupTaskParams): Promise<string> {
  const model = (params.config.model as string) ?? DEFAULT_MODEL;
  const thinkingLevel = resolveThinkingLevel(params.config);
  params.onProgress?.({
    type: "started",
    message: `Understanding repository with Grok Build (${model})`,
  });
  const run = await runGrokHeadless({
    prompt: params.prompt,
    projectRoot: params.projectRoot,
    model,
    maxTurns: (params.config.maxTurns as number) ?? 40,
    tools: SETUP_TOOLS,
    thinkingLevel,
    signal: params.signal,
    onProgress: params.onProgress,
  });
  if (!run.resultText.trim()) throw new Error("Grok produced no setup result");
  params.onProgress?.({ type: "complete", message: "Repository setup analysis complete" });
  return run.resultText.trim();
}

export class GrokBuildAgentPlugin implements AgentPlugin {
  type = "grok";

  async *investigate(params: InvestigateParams): AsyncGenerator<AgentProgress, InvestigateOutput> {
    const { batch, projectRoot, promptTemplate, projectInfo, config, signal, projectId } = params;
    const model = (config.model as string) ?? DEFAULT_MODEL;
    const maxTurns = (config.maxTurns as number) ?? 150;
    const thinkingLevel = resolveThinkingLevel(config);
    const prompt = buildInvestigatePrompt({ promptTemplate, projectInfo, batch });
    const startTime = Date.now();

    let resultText = "";
    let lastError = "";
    let sdkMeta: Partial<BatchMeta> = {};
    let sessionId: string | undefined;
    let grokHome: string | undefined;
    let turnCount = 0;

    yield {
      type: "started",
      message: `Investigating ${batch.length} file(s) with Grok Build (${model})`,
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        yield {
          type: "thinking",
          message: `Retrying Grok batch after transient error (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastError.slice(0, 200)}`,
        };
        resultText = "";
        lastError = "";
        sdkMeta = {};
        sessionId = undefined;
        if (grokHome) {
          try {
            fs.rmSync(grokHome, { recursive: true, force: true });
          } catch {
            // ignore
          }
          grokHome = undefined;
        }
      }

      try {
        grokHome = makeIsolatedGrokHome();
        const run = await runGrokHeadless({
          prompt,
          projectRoot,
          model,
          maxTurns,
          tools: INVESTIGATE_TOOLS,
          thinkingLevel,
          signal,
          grokHome,
          keepHome: true,
          onProgress: (p) => {
            // Coarse progress only from the headless json path.
            if (p.type === "tool_use" || p.type === "thinking") {
              // no-op bridge; reserved for streaming mode
            }
          },
        });
        resultText = run.resultText;
        sdkMeta = run.meta;
        sessionId = run.raw.sessionId;
        turnCount = run.raw.num_turns ?? 0;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (err instanceof QuotaExhaustedError) {
          cleanupHome(grokHome);
          throw err;
        }
        yield { type: "error", message: `Grok error: ${lastError.slice(0, 300)}` };
      }

      if (resultText) break;
      const quotaSource = classifyQuotaError(lastError);
      if (quotaSource) {
        cleanupHome(grokHome);
        throw new QuotaExhaustedError(quotaSource, lastError);
      }
      if (attempt >= MAX_ATTEMPTS || !isTransientError(lastError)) break;
      await backoff(attempt);
    }

    if (!resultText) {
      cleanupHome(grokHome);
      throw new Error(
        `Grok Build produced no investigation result after ${MAX_ATTEMPTS} attempt(s). ` +
          `Last error: ${lastError || "(none captured)"}.`,
      );
    }

    const durationMs = Date.now() - startTime;
    let parsed: ParsedInvestigateResults;
    try {
      parsed = parseInvestigateResults(resultText, batch);
    } catch (err) {
      yield {
        type: "thinking",
        message: "Grok returned non-JSON investigation output; requesting JSON-only repair",
      };
      const repairText = await runToollessFollowUp({
        sessionId,
        grokHome: grokHome!,
        projectRoot,
        model,
        thinkingLevel,
        prompt: buildInvestigateJsonRepairPrompt(batch),
        signal,
      });
      if (repairText === undefined) {
        writeParseFailureDebug({
          projectId,
          phase: "investigate",
          agentType: this.type,
          resultText,
          error: err,
          batch,
        });
        cleanupHome(grokHome);
        throw err;
      }
      try {
        parsed = parseInvestigateResults(repairText, batch);
        resultText = repairText;
        yield { type: "thinking", message: "Grok JSON repair succeeded" };
      } catch (repairErr) {
        const combinedError = jsonRepairFailureError(err, repairErr);
        writeParseFailureDebug({
          projectId,
          phase: "investigate",
          agentType: this.type,
          resultText: formatJsonRepairFailureDebugText(resultText, repairText),
          error: combinedError,
          batch,
        });
        cleanupHome(grokHome);
        throw combinedError;
      }
    }

    let results: InvestigateResult[] = parsed.results;
    if (parsed.invalid.length > 0) {
      const fieldRepair = yield* runInvestigateFieldRepairLoop({
        results,
        invalid: parsed.invalid,
        batch,
        followUp: (p) =>
          runToollessFollowUp({
            sessionId,
            grokHome: grokHome!,
            projectRoot,
            model,
            thinkingLevel,
            prompt: p,
            signal,
          }),
        agentLabel: "Grok",
        agentType: this.type,
        projectId,
      });
      results = fieldRepair.results;
    }

    let refusal: RefusalReport | undefined;
    const refusalRaw = await runToollessFollowUp({
      sessionId,
      grokHome: grokHome!,
      projectRoot,
      model,
      thinkingLevel,
      prompt: REFUSAL_FOLLOWUP_PROMPT,
      signal,
    });
    if (refusalRaw) refusal = parseRefusalReport(refusalRaw);
    if (refusal?.refused) {
      yield {
        type: "thinking",
        message: `Refusal detected: ${refusal.reason ?? "see raw"}`,
      };
    }

    const costStr = sdkMeta.costUsd != null ? ` $${sdkMeta.costUsd.toFixed(3)}` : "";
    const tokensStr = sdkMeta.usage
      ? ` ${sdkMeta.usage.inputTokens + sdkMeta.usage.outputTokens} tokens`
      : "";
    yield {
      type: "complete",
      message: `Investigation complete (${(durationMs / 1000).toFixed(1)}s, ${turnCount} turns${costStr}${tokensStr}${refusal?.refused ? " refusal" : ""})`,
    };

    cleanupHome(grokHome);
    return {
      results,
      meta: {
        durationMs,
        ...sdkMeta,
        refusal,
      },
    };
  }

  async *revalidate(params: RevalidateParams): AsyncGenerator<AgentProgress, RevalidateOutput> {
    const {
      batch,
      projectRoot,
      projectInfo,
      config,
      force = false,
      onlyFindingIds,
      signal,
      projectId,
    } = params;
    const model = (config.model as string) ?? DEFAULT_MODEL;
    const maxTurns = (config.maxTurns as number) ?? 150;
    const thinkingLevel = resolveThinkingLevel(config);

    const { prompt, totalFindings, expected } = buildRevalidatePrompt({
      batch,
      projectRoot,
      projectInfo,
      force,
      onlyFindingIds: onlyFindingIds ? new Set(onlyFindingIds) : undefined,
    });

    yield {
      type: "started",
      message: `Revalidating ${totalFindings} finding(s) across ${batch.length} file(s) with Grok Build (${model})`,
    };

    const startTime = Date.now();
    let resultText = "";
    let lastError = "";
    let sdkMeta: Partial<BatchMeta> = {};
    let sessionId: string | undefined;
    let grokHome: string | undefined;
    const rawResponses: RevalidateRawResponse[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        yield {
          type: "thinking",
          message: `Retrying Grok revalidation after transient error (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastError.slice(0, 200)}`,
        };
        resultText = "";
        lastError = "";
        sdkMeta = {};
        sessionId = undefined;
        cleanupHome(grokHome);
        grokHome = undefined;
      }

      try {
        grokHome = makeIsolatedGrokHome();
        const run = await runGrokHeadless({
          prompt,
          projectRoot,
          model,
          maxTurns,
          tools: INVESTIGATE_TOOLS,
          thinkingLevel,
          signal,
          grokHome,
          keepHome: true,
        });
        resultText = run.resultText;
        sdkMeta = run.meta;
        sessionId = run.raw.sessionId;
        rawResponses.push({ kind: "initial", rawText: resultText });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (err instanceof QuotaExhaustedError) {
          cleanupHome(grokHome);
          throw err;
        }
        yield { type: "error", message: `Grok error: ${lastError.slice(0, 300)}` };
      }

      if (resultText) break;
      const quotaSource = classifyQuotaError(lastError);
      if (quotaSource) {
        cleanupHome(grokHome);
        throw new QuotaExhaustedError(quotaSource, lastError);
      }
      if (attempt >= MAX_ATTEMPTS || !isTransientError(lastError)) break;
      await backoff(attempt);
    }

    if (!resultText) {
      cleanupHome(grokHome);
      throw new Error(
        `Grok Build produced no revalidation result after ${MAX_ATTEMPTS} attempt(s). ` +
          `Last error: ${lastError || "(none captured)"}.`,
      );
    }

    let verdicts: RevalidateVerdict[];
    try {
      verdicts = parseRevalidateVerdicts(resultText);
    } catch (err) {
      yield {
        type: "thinking",
        message: "Grok returned non-JSON revalidation output; requesting JSON-only repair",
      };
      const repairPrompt = buildRevalidateJsonRepairPrompt(expected);
      const repairText = await runToollessFollowUp({
        sessionId,
        grokHome: grokHome!,
        projectRoot,
        model,
        thinkingLevel,
        prompt: repairPrompt,
        signal,
      });
      if (repairText === undefined) {
        writeParseFailureDebug({
          projectId,
          phase: "revalidate",
          agentType: this.type,
          resultText,
          error: err,
          batch,
        });
        cleanupHome(grokHome);
        throw err;
      }
      rawResponses.push({ kind: "json-repair", prompt: repairPrompt, rawText: repairText });
      try {
        verdicts = parseRevalidateVerdicts(repairText);
        resultText = repairText;
        yield { type: "thinking", message: "Grok revalidation JSON repair succeeded" };
      } catch (repairErr) {
        const combinedError = jsonRepairFailureError(err, repairErr);
        writeParseFailureDebug({
          projectId,
          phase: "revalidate",
          agentType: this.type,
          resultText: formatJsonRepairFailureDebugText(resultText, repairText),
          error: combinedError,
          batch,
        });
        cleanupHome(grokHome);
        throw combinedError;
      }
    }

    const idRepair = yield* runRevalidateIdRepairLoop({
      expected,
      verdicts,
      initialRawText: resultText,
      followUp: async (p) =>
        runToollessFollowUp({
          sessionId,
          grokHome: grokHome!,
          projectRoot,
          model,
          thinkingLevel,
          prompt: p,
          signal,
        }),
      agentLabel: "Grok",
    });
    verdicts = idRepair.verdicts;
    // Prefer the repair loop's complete transcript (includes initial).
    const finalRawResponses =
      idRepair.rawResponses.length > 0
        ? [
            ...rawResponses.filter((r) => r.kind !== "initial"),
            ...idRepair.rawResponses,
          ]
        : rawResponses;

    const durationMs = Date.now() - startTime;
    const costStr = sdkMeta.costUsd != null ? ` $${sdkMeta.costUsd.toFixed(3)}` : "";
    yield {
      type: "complete",
      message: `Revalidation complete (${(durationMs / 1000).toFixed(1)}s, ${verdicts.length} verdicts${costStr})`,
    };

    cleanupHome(grokHome);
    return {
      verdicts,
      meta: {
        durationMs,
        ...sdkMeta,
      },
      rawResponses: finalRawResponses,
      repairAttempts: idRepair.repairAttempts,
    };
  }
}

function cleanupHome(home: string | undefined): void {
  if (!home) return;
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
