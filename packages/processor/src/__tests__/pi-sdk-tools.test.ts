import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPiReadOnlyToolDefinitions } from "../agents/pi-sdk.js";

describe("Pi read-only tools", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "deepsec-pi-root-"));
    outside = path.join(mkdtempSync(path.join(tmpdir(), "deepsec-pi-outside-")), "secret.txt");
    writeFileSync(path.join(root, "inside.ts"), "export const ok = true;\n");
    writeFileSync(outside, "do not read me\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(path.dirname(outside), { recursive: true, force: true });
  });

  function tool(name: string) {
    const found = createPiReadOnlyToolDefinitions(root).find((t) => t.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found as any;
  }

  it("allows reads inside the project root", async () => {
    const result = await tool("read").execute("read-1", { path: "inside.ts" });
    expect(result.content[0].text).toContain("export const ok");
  });

  it("rejects reads outside the project root", async () => {
    await expect(tool("read").execute("read-1", { path: outside })).rejects.toThrow(
      /Path escapes project root/,
    );
  });

  it("implements find without relying on external fd downloads", async () => {
    const result = await tool("find").execute("find-1", { pattern: "*.ts" });
    expect(result.content[0].text).toContain("inside.ts");
  });
});
