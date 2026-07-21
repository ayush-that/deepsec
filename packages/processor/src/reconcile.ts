import type { FileRecord } from "@deepsec/core";

export type ExternalStatus = "confirmed" | "dismissed" | "acknowledged" | "open";

/** A deterministic-scanner hit to reconcile against the independent review. */
export interface ExternalHit {
  filePath: string;
  slug: string;
  line: number;
  detector: string;
}

export interface ExternalItem {
  filePath: string;
  vulnSlug: string;
  line: number;
  detector: string;
  status: ExternalStatus;
  reason?: string;
  by?: "ai" | "human";
}

/**
 * Cross-check each deterministic (trufflehog/semgrep) finding against the
 * independent AI review: `confirmed` (a review/cross-check finding lands on it),
 * `dismissed`/`acknowledged` (dismissal ledger, with reason), or `open` (neither
 * — surfaced before the final report). With `requireHumanAck`, an AI dismissal
 * stays `open` until a human signs off.
 */
export function reconcileExternal(
  records: FileRecord[],
  externalHits: ExternalHit[],
  opts: { requireHumanAck?: boolean } = {},
): ExternalItem[] {
  const byPath = new Map<string, FileRecord>(records.map((r) => [r.filePath, r]));
  return externalHits.map((hit) => {
    const rec = byPath.get(hit.filePath);
    // Confirmed: a finding lands on this hit — same slug, or within a few lines.
    const confirmed = !!rec?.findings.some(
      (f) => f.vulnSlug === hit.slug || f.lineNumbers.some((ln) => Math.abs(ln - hit.line) <= 3),
    );
    // Match a dismissal to this exact hit (slug + line). A dismissal whose line
    // the AI omitted lands at 0, which matches no real hit (scanner lines are
    // ≥1) — so it surfaces as `open` rather than wildcard-clearing every
    // same-slug hit in the file (trufflehog gives all secrets one slug).
    const disp = (rec?.dismissedExternal ?? []).find(
      (d) => d.vulnSlug === hit.slug && d.line === hit.line,
    );

    let status: ExternalStatus;
    if (confirmed) {
      status = "confirmed";
    } else if (disp) {
      const aiPending =
        !!opts.requireHumanAck && disp.by === "ai" && disp.disposition === "dismissed";
      status = aiPending
        ? "open"
        : disp.disposition === "acknowledged"
          ? "acknowledged"
          : "dismissed";
    } else {
      status = "open";
    }

    return {
      filePath: hit.filePath,
      vulnSlug: hit.slug,
      line: hit.line,
      detector: hit.detector,
      status,
      reason: disp?.reason,
      by: disp?.by,
    };
  });
}
