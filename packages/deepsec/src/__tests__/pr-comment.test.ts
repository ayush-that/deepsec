import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureProject, writeFileRecord, writeRunMeta } from "@deepsec/core";
import { afterEach, describe, expect, it } from "vitest";
import { renderPrComment } from "../pr-comment.js";

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  delete process.env.DEEPSEC_DATA_ROOT;
});

function setupProject(): { projectId: string } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-comment-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-root-"));
  process.env.DEEPSEC_DATA_ROOT = dataRoot;
  cleanup = () => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  };
  const projectId = `c-${Date.now().toString(36)}`;
  ensureProject(projectId, root);
  return { projectId };
}

describe("renderPrComment()", () => {
  it("returns null when the run had no findings", () => {
    const { projectId } = setupProject();
    const md = renderPrComment({ projectId, runId: "r1" });
    expect(md).toBeNull();
  });

  it("renders only findings from the specified run", () => {
    const { projectId } = setupProject();

    writeRunMeta({
      runId: "r1",
      projectId,
      rootPath: "/tmp/x",
      createdAt: new Date().toISOString(),
      type: "process",
      phase: "done",
      stats: {},
    });

    writeFileRecord({
      filePath: "src/a.ts",
      projectId,
      candidates: [],
      lastScannedAt: new Date().toISOString(),
      lastScannedRunId: "r0",
      fileHash: "x",
      findings: [
        {
          severity: "HIGH",
          vulnSlug: "sql-injection",
          title: "Concatenated query",
          description: "User-controlled input flows into a string-concatenated SQL query.",
          lineNumbers: [12],
          recommendation: "Use parameterized queries.",
          confidence: "high",
        },
        {
          severity: "LOW",
          vulnSlug: "old",
          title: "Pre-existing finding",
          description: "Found in an earlier run.",
          lineNumbers: [99],
          recommendation: "n/a",
          confidence: "low",
        },
      ],
      analysisHistory: [
        {
          runId: "r1",
          investigatedAt: new Date().toISOString(),
          durationMs: 100,
          agentType: "claude-agent-sdk",
          model: "test",
          modelConfig: {},
          findingCount: 1,
        },
      ],
      status: "analyzed",
    });

    // A second file investigated in a DIFFERENT run — should not appear.
    writeFileRecord({
      filePath: "src/other.ts",
      projectId,
      candidates: [],
      lastScannedAt: new Date().toISOString(),
      lastScannedRunId: "r0",
      fileHash: "y",
      findings: [
        {
          severity: "CRITICAL",
          vulnSlug: "xss",
          title: "Stale finding from older run",
          description: "Should not appear.",
          lineNumbers: [1],
          recommendation: "irrelevant",
          confidence: "high",
        },
      ],
      analysisHistory: [
        {
          runId: "r-old",
          investigatedAt: new Date().toISOString(),
          durationMs: 100,
          agentType: "claude-agent-sdk",
          model: "test",
          modelConfig: {},
          findingCount: 1,
        },
      ],
      status: "analyzed",
    });

    const md = renderPrComment({ projectId, runId: "r1", source: "git-diff:HEAD~1" });
    expect(md).not.toBeNull();
    expect(md!).toContain("deepsec found");
    expect(md!).toContain("src/a.ts:L12");
    expect(md!).toContain("Concatenated query");
    expect(md!).toContain("Pre-existing finding"); // same file, ran in r1
    // The finding from src/other.ts (different run) must not leak in.
    expect(md!).not.toContain("Stale finding from older run");
    expect(md!).toContain("git-diff:HEAD~1");
  });
});
