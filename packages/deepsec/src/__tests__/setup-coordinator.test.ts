import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, type FileRecord, setLoadedConfig } from "@deepsec/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSetupWorkflow, type SetupWorkflowOptions } from "../setup/coordinator.js";

const originalCwd = process.cwd();
afterEach(() => process.chdir(originalCwd));

describe("one-shot setup coordinator", () => {
  it("short-circuits completed install, login, analysis, scan, and process phases", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-one-shot-"));
    const workspace = path.join(root, ".deepsec");
    const project = path.join(root, "app");
    fs.mkdirSync(path.join(workspace, "data", "app"), { recursive: true });
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src", "route.ts"), "export const GET = () => 'ok';\n");
    fs.writeFileSync(path.join(workspace, "package.json"), '{"private":true}\n');
    fs.writeFileSync(
      path.join(workspace, "deepsec.config.ts"),
      `const defineConfig = <T>(config: T): T => config;\nexport default defineConfig({ projects: [{ id: "app", root: "../app" }] });\n`,
    );
    fs.writeFileSync(
      path.join(workspace, "generated-matchers.ts"),
      `export const generatedMatchersPlugin = { name: "generated", matchers: [] };\n`,
    );
    fs.writeFileSync(path.join(workspace, "data", "app", "INFO.md"), "placeholder\n");

    const install = vi.fn(async ({ workspaceDir }: { workspaceDir: string }) => {
      fs.mkdirSync(path.join(workspaceDir, "node_modules", "deepsec"), { recursive: true });
      return { packageManager: "pnpm" as const, version: "test", installed: true };
    });
    const connect = vi.fn(async (_options: SetupWorkflowOptions) => ({
      verification: {
        project: "linked",
        route: { mode: "direct", provider: "anthropic", apiKeyEnv: "MY_ANTHROPIC_KEY" },
      },
    }));
    const analyze = vi.fn(async () => ({
      infoMarkdown:
        "# app\n\n## What this codebase does\nApp.\n\n## Auth shape\nNone.\n\n## Threat model\nPublic input.\n\n## Project-specific patterns to flag\nRoutes.\n\n## Known false-positives\nNone.",
      surfaces: [
        {
          id: "http-routes",
          kind: "http" as const,
          description: "HTTP routes",
          fileGlobs: ["src/**/*.ts"],
          representativeFiles: ["src/route.ts"],
          exposure: "public" as const,
        },
      ],
      inspectedPaths: ["src/route.ts"],
    }));
    const scan = vi.fn(async () => ({
      runId: "scan-1",
      candidateCount: 1,
      detected: { tags: [], sentinels: [], detectedAt: "now", rootPath: project },
      activeMatchers: ["public-endpoint"],
      skippedMatchers: [],
      languageStats: [],
    }));
    const record = {
      filePath: "src/route.ts",
      projectId: "app",
      candidates: [
        { vulnSlug: "public-endpoint", lineNumbers: [1], snippet: "GET", matchedPattern: "GET" },
      ],
      lastScannedAt: "now",
      lastScannedRunId: "scan-1",
      fileHash: "hash",
      findings: [],
      analysisHistory: [],
      status: "pending",
    } as FileRecord;
    const process = vi.fn(async () => ({
      runId: "process-1",
      analysisCount: 1,
      findingCount: 0,
      errorBatchCount: 0,
    }));
    let fingerprint = "source-v1";
    const services = {
      install,
      connect,
      analyze,
      scan,
      process,
      listFiles: () => ["src/route.ts"],
      fingerprint: () => fingerprint,
      loadRecords: () => [record],
    };
    const options = {
      workspaceDir: workspace,
      projectId: "app",
      projectRoot: project,
      agent: "claude",
      model: "test-model",
      thinkingLevel: "high",
      modelRoute: {
        mode: "direct" as const,
        provider: "anthropic",
        apiKeyEnv: "MY_ANTHROPIC_KEY",
      },
      services,
      onLog: () => undefined,
    };

    const first = await runSetupWorkflow(options);
    const second = await runSetupWorkflow({
      workspaceDir: workspace,
      projectId: "app",
      projectRoot: project,
      services,
      onLog: () => undefined,
    });
    const statePath = path.join(workspace, "data", "app", "setup", "setup-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.finalScanRunId = "scan-final";
    state.finalScanSummary = { runId: "scan-final", languageStats: [] };
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    record.lastScannedRunId = "scan-final";
    const coverageOnly = await runSetupWorkflow({
      workspaceDir: workspace,
      projectId: "app",
      projectRoot: project,
      through: "coverage",
      services,
      onLog: () => undefined,
    });

    expect(first.processRunId).toBe("process-1");
    expect(second.processRunId).toBe("process-1");
    expect(coverageOnly).toMatchObject({ completed: false, stoppedAfter: "coverage" });
    expect(install).toHaveBeenCalledTimes(3);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]?.[0]).toMatchObject({ force: true });
    expect(install.mock.calls[1]?.[0]).not.toHaveProperty("force");
    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      modelRoute: { mode: "direct", provider: "anthropic", apiKeyEnv: "MY_ANTHROPIC_KEY" },
    });
    expect(connect.mock.calls[1]?.[0]).toMatchObject({
      modelRoute: { mode: "direct", provider: "anthropic", apiKeyEnv: "MY_ANTHROPIC_KEY" },
    });
    const config = fs.readFileSync(path.join(workspace, "deepsec.config.ts"), "utf8");
    expect(config).toContain('defaultAgent: "claude-agent-sdk"');
    expect(config).toContain('defaultModel: "test-model"');
    expect(config).toContain('defaultThinkingLevel: "high"');
    expect(config).toContain('ai: {"mode":"direct","provider":"anthropic"');

    const curatedInfo =
      "# app\n\n## What this codebase does\nPromise<void>.\n\n## Auth shape\nNone.\n\n## Threat model\nReject <script> input.\n\n## Project-specific patterns to flag\nRoutes.\n\n## Known false-positives\nNone.\n";
    fs.writeFileSync(path.join(workspace, "data", "app", "INFO.md"), curatedInfo);
    fingerprint = "source-v2";
    fs.writeFileSync(path.join(project, "src", "route.ts"), "export const POST = () => 'ok';\n");
    await runSetupWorkflow({
      workspaceDir: workspace,
      projectId: "app",
      projectRoot: project,
      through: "threat-model",
      services,
      onLog: () => undefined,
    });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(workspace, "data", "app", "INFO.md"), "utf8")).toBe(
      curatedInfo,
    );
  });

  it("uses the new harness default model instead of a previous harness model", async () => {
    setLoadedConfig(defineConfig({ projects: [], defaultAgent: "codex", defaultModel: "gpt-old" }));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-agent-switch-"));
    const workspace = path.join(root, ".deepsec");
    const project = path.join(root, "app");
    fs.mkdirSync(path.join(workspace, "data", "app", "setup"), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(workspace, "package.json"), '{"private":true}\n');
    fs.writeFileSync(
      path.join(workspace, "data", "app", "setup", "setup-state.json"),
      `${JSON.stringify({
        version: 1,
        projectId: "app",
        targetRoot: project,
        phases: {},
        matcherAttempts: [],
        agent: { type: "codex", model: "gpt-old" },
        updatedAt: new Date().toISOString(),
      })}\n`,
    );

    const result = await runSetupWorkflow({
      workspaceDir: workspace,
      projectId: "app",
      projectRoot: project,
      agent: "claude",
      through: "install",
      services: {
        install: async () => ({ packageManager: "pnpm", version: "test", installed: true }),
      },
      onLog: () => undefined,
    });

    expect(result.state.agent).toMatchObject({
      type: "claude-agent-sdk",
      model: "claude-opus-4-8",
    });
  });
});
