import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReverseImportGraph } from "../graph/collect-graph.js";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-graph-"));
  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  // Target that others depend on.
  write("lib/auth/rbac.ts", "export function check() {}\n");
  // Relative importer.
  write("app/api/route.ts", 'import { check } from "../../lib/auth/rbac";\ncheck();\n');
  // Alias importer (#lib/...).
  write("app/mw.ts", 'import { check } from "#lib/auth/rbac";\n');
  // Basename-only (single segment) importer.
  write("app/basename.ts", 'import { check } from "./rbac";\n');
  // Unrelated import — must NOT match.
  write("app/other.ts", 'import x from "some-package";\nimport y from "../lib/auth/other";\n');
  // A different file whose basename could false-match a *different* target.
  write("lib/http/client.ts", "export const client = 1;\n");
  write("app/uses-client.ts", 'import { client } from "../lib/http/client";\n');
  // Barrel re-export hub with no literal "import"/"require" — must still be seen.
  write("lib/index.ts", 'export { check } from "./auth/rbac";\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("buildReverseImportGraph", () => {
  it("finds relative, alias, and basename importers; excludes unrelated", async () => {
    const g = await buildReverseImportGraph({ root, files: ["lib/auth/rbac.ts"] });
    const importers = g["lib/auth/rbac.ts"].importers;
    expect(importers).toContain("app/api/route.ts");
    expect(importers).toContain("app/mw.ts");
    expect(importers).toContain("app/basename.ts");
    expect(importers).toContain("lib/index.ts"); // barrel `export … from` hub
    expect(importers).not.toContain("app/other.ts");
    expect(g["lib/auth/rbac.ts"].importedByCount).toBe(importers.length);
  });

  it("does not count a file as its own importer", async () => {
    const g = await buildReverseImportGraph({ root, files: ["lib/http/client.ts"] });
    expect(g["lib/http/client.ts"].importers).toEqual(["app/uses-client.ts"]);
  });

  it("returns a zeroed entry for a non-JS/TS target", async () => {
    const g = await buildReverseImportGraph({ root, files: ["config.yaml"] });
    expect(g["config.yaml"]).toEqual({ importedByCount: 0, importers: [], isEntryPoint: false });
  });
});
