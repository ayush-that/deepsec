import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRepositoryAnalysis } from "../setup/repository-analysis.js";

describe("repository analysis parsing", () => {
  it("defers stale representative-file existence checks to inventory grounding", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-analysis-"));
    fs.writeFileSync(path.join(root, "README.md"), "# app\n");
    const infoMarkdown = [
      "# app",
      "## What this codebase does",
      "App.",
      "## Auth shape",
      "Session.",
      "## Threat model",
      "Public input.",
      "## Project-specific patterns to flag",
      "Routes.",
      "## Known false-positives",
      "None.",
    ].join("\n");

    const result = parseRepositoryAnalysis(
      JSON.stringify({
        infoMarkdown,
        surfaces: [
          {
            id: "api-routes",
            kind: "http",
            description: "API routes",
            fileGlobs: ["src/routes/**/*.ts"],
            representativeFiles: ["src/routes/removed.ts"],
            exposure: "public",
          },
        ],
        inspectedPaths: ["README.md"],
      }),
      root,
    );

    expect(result.surfaces[0]?.representativeFiles).toEqual(["src/routes/removed.ts"]);
  });
});
