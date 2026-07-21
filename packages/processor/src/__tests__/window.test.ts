import { pathRiskCategories } from "@deepsec/scanner";
import { describe, expect, it } from "vitest";
import { introducedFindings } from "../window/focus.js";
import { parsePrNumbersFromSubject } from "../window/pull-requests.js";
import { addedLineNumbers, splitUnifiedDiff } from "../window/resolve-window.js";

describe("pathRiskCategories", () => {
  it("classifies by path convention, not content", () => {
    expect(pathRiskCategories("src/auth/session.ts")).toContain("auth");
    expect(pathRiskCategories("app/middleware.ts")).toContain("middleware");
    expect(pathRiskCategories("api/webhooks/stripe.ts")).toContain("webhook-signature");
    // A generated schema is not on any risk path, however keyword-heavy its text.
    expect(pathRiskCategories("apps/x/payload-generated-schema.ts")).toEqual([]);
  });
});

describe("addedLineNumbers", () => {
  it("maps + lines to their new-file line numbers", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -10,3 +10,4 @@",
      " context",
      "+added at 11",
      "-removed",
      "+added at 12",
      " context at 13",
    ].join("\n");
    // new-file: 10 context, 11 added, 12 added (removed doesn't advance new), 13 context
    expect(addedLineNumbers(patch)).toEqual([11, 12]);
  });

  it("empty for a pure-context / no-add patch", () => {
    expect(addedLineNumbers("@@ -1,1 +1,1 @@\n-gone")).toEqual([]);
  });

  it("does not mistake an added line whose content starts with ++ for a +++ header", () => {
    // Added content `++i;` is emitted as `+++i;` — must NOT be skipped or shift the next line.
    const patch = ["@@ -1,2 +1,3 @@", " ctx", "+++i;", "+b"].join("\n");
    expect(addedLineNumbers(patch)).toEqual([2, 3]);
  });

  it("skips the +++/--- file headers before the first hunk", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1,2 @@",
      " ctx",
      "+added",
    ].join("\n");
    expect(addedLineNumbers(patch)).toEqual([2]);
  });
});

describe("introducedFindings", () => {
  const records = [
    { filePath: "src/a.ts", findings: [{ lineNumbers: [12] }, { lineNumbers: [99] }] },
    { filePath: "src/untouched.ts", findings: [{ lineNumbers: [12] }] },
  ];
  it("matches only findings whose line is inside the window's added lines", () => {
    const added = new Map([["src/a.ts", [11, 12]]]);
    const hits = introducedFindings(records, added);
    expect(hits).toEqual([{ filePath: "src/a.ts", findingIndex: 0 }]);
  });
});

describe("parsePrNumbersFromSubject", () => {
  it("squash convention", () => {
    expect(parsePrNumbersFromSubject("Fix auth bug (#123)")).toEqual([123]);
  });
  it("merge convention", () => {
    expect(parsePrNumbersFromSubject("Merge pull request #456 from foo/bar")).toEqual([456]);
  });
  it("no PR → empty", () => {
    expect(parsePrNumbersFromSubject("just a commit")).toEqual([]);
  });
});

describe("splitUnifiedDiff", () => {
  it("splits per file and tracks the new path", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "deleted file mode 100644",
      "--- a/src/b.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
    ].join("\n");
    const parts = splitUnifiedDiff(diff);
    expect(parts.map((p) => p.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
