export type SetupOutputMode = "human" | "json" | "jsonl";

export interface SetupAction {
  id: string;
  description: string;
  commands?: string[];
  requiredEnv?: string[];
  resumeArgs?: string[];
}

export interface SetupChoice {
  value: string;
  label: string;
  recommended?: boolean;
  description?: string;
}

export class SetupProtocolError extends Error {
  readonly code: string;
  readonly kind: "needs_input" | "limit" | "failure";
  readonly missingInputs: string[];
  readonly choices: SetupChoice[];
  readonly actions: SetupAction[];
  readonly details?: Record<string, unknown>;

  constructor(options: {
    code: string;
    message: string;
    kind?: "needs_input" | "limit" | "failure";
    missingInputs?: string[];
    choices?: SetupChoice[];
    actions?: SetupAction[];
    details?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = "SetupProtocolError";
    this.code = options.code;
    this.kind = options.kind ?? "needs_input";
    this.missingInputs = options.missingInputs ?? [];
    this.choices = options.choices ?? [];
    this.actions = options.actions ?? [];
    this.details = options.details;
  }
}

export function parseSetupOutputMode(value: string | undefined): SetupOutputMode {
  const mode = value ?? "human";
  if (mode !== "human" && mode !== "json" && mode !== "jsonl") {
    throw new SetupProtocolError({
      code: "INVALID_OUTPUT_MODE",
      kind: "failure",
      message: "--output must be human, json, or jsonl",
    });
  }
  return mode;
}

export function setupErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof SetupProtocolError) {
    return {
      type: error.kind,
      code: error.code,
      message: error.message,
      missingInputs: error.missingInputs,
      choices: error.choices,
      actions: error.actions,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    type: "failure",
    code: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function setupErrorExitCode(error: unknown): number {
  if (error instanceof SetupProtocolError) {
    if (error.kind === "needs_input") return 2;
    if (error.kind === "limit") return 3;
  }
  return 1;
}

export function formatSetupErrorHuman(error: SetupProtocolError): string {
  const lines = [`${error.code}: ${error.message}`];
  for (const action of error.actions) {
    lines.push("", action.description);
    for (const command of action.commands ?? []) lines.push(`  ${command}`);
    if (action.requiredEnv?.length) {
      lines.push(`  Required environment: ${action.requiredEnv.join(", ")}`);
    }
    if (action.resumeArgs?.length) {
      lines.push(`  Resume with: ${action.resumeArgs.join(" ")}`);
    }
  }
  return lines.join("\n");
}

export function outputModeFromArgv(argv: string[] = process.argv): SetupOutputMode {
  const index = argv.indexOf("--output");
  if (index >= 0) {
    const value = argv[index + 1];
    return value === "json" || value === "jsonl" ? value : "human";
  }
  const inline = argv.find((arg) => arg.startsWith("--output="));
  const value = inline?.slice("--output=".length);
  return value === "json" || value === "jsonl" ? value : "human";
}
