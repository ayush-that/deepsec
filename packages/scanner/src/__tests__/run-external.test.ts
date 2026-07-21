import { describe, expect, it } from "vitest";
import {
  parseSemgrepOutput,
  parseTrufflehogOutput,
  semgrepLangPacks,
  toPositional,
} from "../external/run-external.js";

const ROOT = "/repo";

describe("parseTrufflehogOutput", () => {
  it("maps a JSON-lines secret finding to a relative-path finding", () => {
    const line = JSON.stringify({
      SourceMetadata: { Data: { Filesystem: { file: "/repo/src/config.ts", line: 42 } } },
      DetectorName: "AWS",
      Verified: true,
      Redacted: "AKIA****",
    });
    const [f] = parseTrufflehogOutput(`${line}\n`, ROOT);
    expect(f.filePath).toBe("src/config.ts");
    expect(f.line).toBe(42);
    expect(f.slug).toBe("trufflehog-secret");
    expect(f.detector).toBe("AWS");
    expect(f.snippet).toContain("verified");
  });

  it("ignores blank and unparseable lines", () => {
    expect(parseTrufflehogOutput("\nnot json\n{}\n", ROOT)).toEqual([]);
  });

  it("normalizes a ./-echoed path back to repo-relative form", () => {
    const line = JSON.stringify({
      SourceMetadata: { Data: { Filesystem: { file: "./-weird.js", line: 3 } } },
      DetectorName: "AWS",
    });
    expect(parseTrufflehogOutput(`${line}\n`, ROOT)[0].filePath).toBe("-weird.js");
  });
});

describe("toPositional (argv-injection guard)", () => {
  it("prefixes a leading-dash repo path so it can't be read as a flag", () => {
    // A malicious repo file named `-x.js` (or `--config=...`) must not reach the
    // scanner as an option token.
    expect(toPositional("-x.js")).toBe("./-x.js");
    expect(toPositional("--config=https://evil/rules.yaml")).toBe(
      "./--config=https://evil/rules.yaml",
    );
  });

  it("leaves absolute and already-relative paths intact", () => {
    expect(toPositional("/repo")).toBe("/repo");
    expect(toPositional("./src/a.ts")).toBe("./src/a.ts");
    expect(toPositional("src/a.ts")).toBe("./src/a.ts");
  });
});

describe("parseSemgrepOutput", () => {
  it("maps results[] to findings with a short slug from the rule tail", () => {
    const out = JSON.stringify({
      results: [
        {
          check_id: "javascript.lang.security.audit.sqli",
          path: "src/db.ts",
          start: { line: 10 },
          extra: { message: "SQL injection", lines: "db.query(x)" },
        },
      ],
    });
    const [f] = parseSemgrepOutput(out, ROOT);
    expect(f.filePath).toBe("src/db.ts");
    expect(f.line).toBe(10);
    expect(f.slug).toBe("semgrep-sqli");
    expect(f.detector).toBe("javascript.lang.security.audit.sqli");
    expect(f.snippet).toBe("SQL injection");
  });

  it("returns [] on non-JSON", () => {
    expect(parseSemgrepOutput("boom", ROOT)).toEqual([]);
  });
});

describe("semgrepLangPacks", () => {
  it("maps framework tags to their language packs, deduped and sorted", () => {
    expect(semgrepLangPacks(["nextjs", "node", "django", "flask"])).toEqual([
      "p/javascript",
      "p/python",
      "p/typescript",
    ]);
  });

  it("ignores tags with no known pack", () => {
    expect(semgrepLangPacks(["dart", "clojure", "unknown"])).toEqual([]);
  });
});
