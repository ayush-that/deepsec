import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const packageRoot = dirname(fileURLToPath(import.meta.url));
// The docs collection compiles ../../docs (repo root), so Turbopack's root
// must span the whole repository, not just this package.
const repoRoot = resolve(packageRoot, "../..");

const withMDX = createMDX();

const nextConfig: NextConfig = {
  turbopack: {
    root: repoRoot,
  },
};

export default withMDX(nextConfig);
