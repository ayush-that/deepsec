import fs from "node:fs";
import path from "node:path";
import type { GraphProvider } from "@deepsec/core";
import { glob } from "glob";

// NOTE: reverse-reference index, not a resolved graph — greps quoted JS/TS
// specifiers and matches by path suffix (no alias/tsconfig resolution). AST
// provider is the precision upgrade behind this slot.

const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/.turbo/**",
  "**/vendor/**",
  "**/.deepsec/**",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "**/fixtures/**",
  "**/*.test.*",
  "**/*.spec.*",
];

const SOURCE_GLOBS = ["**/*.{ts,tsx,js,jsx,mjs,cjs}"];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IMPORT_RE = /(?:\b(?:import|export|require|from)\b)[^\n'"]*['"]([^'"\n]+)['"]/g;

function moduleKey(filePath: string): string {
  return filePath.replace(SOURCE_EXT, "").replace(/\/index$/, "");
}

/** Import specifier → path tail comparable to a target's moduleKey. `@scope/pkg` stays intact. */
function normalizeSpecifier(spec: string): string | null {
  if (spec.startsWith("node:")) return null;
  let s = spec.replace(SOURCE_EXT, "").replace(/\/index$/, "");
  s = s.replace(/^(?:\.\.\/)+/, "").replace(/^\.\//, "");
  s = s.replace(/^[#~]/, "").replace(/^@\//, "");
  return s || null;
}

/** Reverse-reference index: for each target file, the source files that import it. */
export async function buildReverseImportGraph(params: {
  root: string;
  files: string[];
}): Promise<Record<string, { importedByCount: number; importers: string[]; isEntryPoint: boolean }>> {
  const { root, files } = params;
  const out: Record<
    string,
    { importedByCount: number; importers: string[]; isEntryPoint: boolean }
  > = {};
  const targets = files.filter((f) => SOURCE_EXT.test(f)); // only JS/TS matchable
  for (const f of files) out[f] = { importedByCount: 0, importers: [], isEntryPoint: false };
  if (targets.length === 0) return out;

  // Index targets by every path-suffix of their moduleKey (segment-aligned), so
  // matching a source's import specifiers is an O(1) lookup per spec rather than
  // scanning every target. `lib/auth/rbac` → suffixes rbac, auth/rbac, lib/auth/rbac.
  const suffixToTargets = new Map<string, string[]>();
  for (const t of targets) {
    const segs = moduleKey(t).split("/");
    for (let i = 0; i < segs.length; i++) {
      const suffix = segs.slice(i).join("/");
      const list = suffixToTargets.get(suffix);
      if (list) list.push(t);
      else suffixToTargets.set(suffix, [t]);
    }
  }

  const sources = await glob(SOURCE_GLOBS, {
    cwd: root,
    ignore: IGNORE,
    nodir: true,
    absolute: false,
  });

  const importersOf = new Map<string, Set<string>>(targets.map((t) => [t, new Set()]));

  for (const rawSrc of sources) {
    const src = rawSrc.replaceAll("\\", "/");
    let content: string;
    try {
      content = fs.readFileSync(path.join(root, src), "utf-8");
    } catch {
      continue;
    }
    // Include `export … from` barrels (re-export hubs), not just import/require.
    if (
      !content.includes("import") &&
      !content.includes("require") &&
      !content.includes("export")
    )
      continue;

    for (const m of content.matchAll(IMPORT_RE)) {
      const norm = normalizeSpecifier(m[1]);
      if (!norm) continue;
      for (const t of suffixToTargets.get(norm) ?? []) {
        if (t !== src) importersOf.get(t)!.add(src);
      }
    }
  }

  for (const t of targets) {
    const importers = [...importersOf.get(t)!].sort();
    out[t] = { importedByCount: importers.length, importers, isEntryPoint: false };
  }
  return out;
}

/** Default GraphProvider — plugins can override the slot with an AST-based one. */
export const defaultGraphProvider: GraphProvider = {
  name: "reverse-ref",
  async buildReverseGraph(args) {
    return buildReverseImportGraph(args);
  },
};
