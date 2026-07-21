import { execFile, spawnSync } from "node:child_process";
import type { PullRequestContext, PullRequestProvider } from "@deepsec/core";

// Concurrent gh calls — a window can link hundreds of PRs. Modest, to respect rate limits.
const GH_CONCURRENCY = 6;

const PR_KEYWORDS = [
  "recovery",
  "recover",
  "reset",
  "password",
  "session",
  "auth",
  "login",
  "sso",
  "oauth",
  "token",
  "secret",
  "permission",
  "role",
  "rbac",
  "invite",
  "impersonate",
  "mfa",
  "2fa",
  "otp",
  "webhook",
  "signature",
  "middleware",
  "proxy",
  "routing",
  "headers",
  "admin",
  "internal",
  "db",
  "database",
  "integration",
  "connector",
];

/** PR numbers from a commit subject: `Title (#123)` and `Merge pull request #123`. */
export function parsePrNumbersFromSubject(subject: string): number[] {
  const nums = new Set<number>();
  for (const m of subject.matchAll(/\(#(\d+)\)/g)) nums.add(Number(m[1]));
  const merge = subject.match(/Merge pull request #(\d+)/);
  if (merge) nums.add(Number(merge[1]));
  return [...nums];
}

function keywordHits(text: string): string[] {
  const lower = text.toLowerCase();
  return PR_KEYWORDS.filter((k) => lower.includes(k));
}

// Checked once per fetch() call (per window run), not memoized process-wide —
// a stale false would otherwise stick across tests or a long-lived daemon.
function ghAvailable(): boolean {
  try {
    const r = spawnSync("gh", ["--version"], { encoding: "utf-8", timeout: 5000 });
    return (r.status ?? 1) === 0;
  } catch {
    return false;
  }
}

interface GhPr {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  files: { path: string }[];
}

function ghPrView(prNumber: number, repo: string | null, root: string): Promise<GhPr | null> {
  const args = ["pr", "view", String(prNumber), "--json", "number,title,body,labels,files"];
  if (repo) args.push("--repo", repo);
  return new Promise((resolve) => {
    // execFile (async, argv form) so many PRs can be in flight at once; run in
    // the target checkout so `gh` resolves the right repo even without --repo.
    execFile(
      "gh",
      args,
      { cwd: root, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout?.trim()) return resolve(null);
        try {
          resolve(JSON.parse(stdout) as GhPr);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Default PR provider: commit-message parsing (always available) + `gh` enrichment
 * (title/body/labels/files) when present. Degraded-safe — never throws/returns null;
 * without `gh` the bundle marks prSignal "unavailable".
 * NOTE: GITHUB_TOKEN raw-HTTP tier deferred; commit-msg parse covers correctness.
 */
export const defaultPullRequestProvider: PullRequestProvider = {
  name: "gh+commit-msg",
  async fetch(args) {
    const numbers = new Set<number>();
    for (const c of args.commits) {
      for (const n of parsePrNumbersFromSubject(c.subject)) numbers.add(n);
    }
    const nums = [...numbers];
    const ghByNumber = new Map<number, GhPr | null>();
    if (ghAvailable()) {
      let idx = 0;
      const worker = async () => {
        while (idx < nums.length) {
          const n = nums[idx++];
          ghByNumber.set(n, await ghPrView(n, args.repo || null, args.root));
        }
      };
      await Promise.all(Array.from({ length: Math.min(GH_CONCURRENCY, nums.length) }, worker));
    }
    return nums.map((prNumber) => {
      const gh = ghByNumber.get(prNumber);
      if (gh) {
        const text = `${gh.title}\n${gh.body}`;
        return {
          prNumber,
          files: gh.files.map((f) => f.path),
          description: text,
          keywordHits: keywordHits(text),
          labels: gh.labels.map((l) => l.name),
        };
      }
      return { prNumber, files: [], keywordHits: [], labels: [] };
    });
  },
};
