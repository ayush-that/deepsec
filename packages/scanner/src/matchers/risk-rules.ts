// Path/structural risk conventions for change-window blast-radius selection: a
// file is on a risk surface by its path alone, independent of content.

const PATH_RISK: { category: string; rx: RegExp }[] = [
  { category: "auth", rx: /(^|\/)(auth|login|session|sso|oauth)(\/|\.|-)/i },
  { category: "middleware", rx: /(^|\/)middleware(\.(ts|js|mjs|cjs)$|\/)/i },
  {
    category: "account-recovery",
    rx: /(^|\/)(reset|recover|forgot[-_]?password|verify[-_]?email|magic[-_]?link|invite|impersonate|2fa|mfa|otp)(\/|\.|-)/i,
  },
  { category: "webhook-signature", rx: /(^|\/)webhook/i },
];

/** Risk categories implied by a file's PATH alone (no content). */
export function pathRiskCategories(filePath: string): string[] {
  return PATH_RISK.filter((p) => p.rx.test(filePath)).map((p) => p.category);
}
