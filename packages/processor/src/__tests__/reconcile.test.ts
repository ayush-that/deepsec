import type { FileRecord } from "@deepsec/core";
import { describe, expect, it } from "vitest";
import { type ExternalHit, reconcileExternal } from "../reconcile.js";

function rec(over: Partial<FileRecord>): FileRecord {
  return {
    filePath: "src/x.ts",
    projectId: "p",
    candidates: [],
    lastScannedAt: "",
    lastScannedRunId: "",
    fileHash: "",
    findings: [],
    analysisHistory: [],
    status: "analyzed",
    ...over,
  };
}
const hit = (filePath: string, slug: string, line: number): ExternalHit => ({
  filePath,
  slug,
  line,
  detector: slug,
});
const finding = (vulnSlug: string, line: number) =>
  ({
    severity: "HIGH",
    vulnSlug,
    title: "t",
    description: "d",
    lineNumbers: [line],
    recommendation: "r",
    confidence: "high",
  }) as FileRecord["findings"][number];

describe("reconcileExternal", () => {
  it("confirmed when a review finding lands near the external hit", () => {
    const r = rec({ filePath: "src/db.ts", findings: [finding("other", 11)] });
    const [i] = reconcileExternal([r], [hit("src/db.ts", "semgrep-sqli", 10)]);
    expect(i.status).toBe("confirmed");
  });

  it("dismissed when the dismissal ledger has an entry", () => {
    const r = rec({
      filePath: "src/s.ts",
      dismissedExternal: [
        { vulnSlug: "trufflehog-secret", line: 5, disposition: "dismissed", reason: "test fixture", by: "ai", at: "" },
      ],
    });
    const [i] = reconcileExternal([r], [hit("src/s.ts", "trufflehog-secret", 5)]);
    expect(i.status).toBe("dismissed");
    expect(i.reason).toBe("test fixture");
  });

  it("open when neither confirmed nor dismissed", () => {
    const [i] = reconcileExternal([rec({ filePath: "src/x.ts" })], [hit("src/x.ts", "semgrep-xss", 20)]);
    expect(i.status).toBe("open");
  });

  it("--require-human-ack keeps an AI dismissal open until a human acks", () => {
    const r = rec({
      filePath: "src/x.ts",
      dismissedExternal: [
        { vulnSlug: "semgrep-xss", line: 20, disposition: "dismissed", reason: "x", by: "ai", at: "" },
      ],
    });
    const h = [hit("src/x.ts", "semgrep-xss", 20)];
    expect(reconcileExternal([r], h, { requireHumanAck: true })[0].status).toBe("open");
    r.dismissedExternal![0].by = "human";
    r.dismissedExternal![0].disposition = "acknowledged";
    expect(reconcileExternal([r], h, { requireHumanAck: true })[0].status).toBe("acknowledged");
  });

  it("an omitted-line (0) dismissal does not clear a real same-slug hit", () => {
    // trufflehog gives every secret one slug; a line-0 dismissal (AI omitted the
    // line) must not wildcard-clear other real secrets in the file.
    const r = rec({
      filePath: "src/s.ts",
      dismissedExternal: [
        { vulnSlug: "trufflehog-secret", line: 0, disposition: "dismissed", reason: "x", by: "ai", at: "" },
      ],
    });
    const [i] = reconcileExternal([r], [hit("src/s.ts", "trufflehog-secret", 40)]);
    expect(i.status).toBe("open");
  });

  it("no external hits → nothing to reconcile", () => {
    expect(reconcileExternal([rec({})], [])).toEqual([]);
  });
});
