import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function serializeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Parse the small dotenv subset needed to reload credentials after setup. */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    result[match[1]] = value;
  }
  return result;
}

/**
 * Atomically append or replace dotenv assignments while preserving all
 * unrelated bytes. The resulting file is always owner-readable/writable only.
 */
export async function updateEnvFile(
  filePath: string,
  updates: Readonly<Record<string, string>>,
): Promise<void> {
  for (const name of Object.keys(updates)) {
    if (!ENV_NAME.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
  }

  let original = "";
  try {
    original = await readFile(filePath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const updateMap = new Map(Object.entries(updates));
  const pending = new Map(updateMap);
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=).*$/);
    if (!match || !updateMap.has(match[2])) return line;
    const value = updateMap.get(match[2])!;
    pending.delete(match[2]);
    return `${match[1]}${match[2]}${match[3]}${serializeEnvValue(value)}`;
  });

  let next = rewritten.join(newline);
  if (pending.size > 0) {
    if (next && !next.endsWith(newline)) next += newline;
    next += [...pending].map(([key, value]) => `${key}=${serializeEnvValue(value)}`).join(newline);
    next += newline;
  }

  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tempPath, next, { encoding: "utf8", mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(tempPath);
    } catch {}
    throw error;
  }
}

export async function loadEnvFile(
  filePath: string,
  target: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  let parsed: Record<string, string> = {};
  try {
    parsed = parseEnvFile(await readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  Object.assign(target, parsed);
  return parsed;
}
