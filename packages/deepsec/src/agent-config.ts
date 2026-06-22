export interface AgentRuntimeOpts {
  model?: string;
  maxTurns?: number;
  aiProvider?: string;
  aiBaseUrl?: string;
  aiApiKeyEnv?: string;
  aiHeader?: string[];
}

export interface AgentCredentialOpts {
  aiApiKeyEnv?: string;
}

export function collectRepeatable(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseAiHeaders(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const raw of values) {
    const idx = raw.indexOf("=");
    if (idx <= 0) {
      throw new Error(`--ai-header must be NAME=VALUE, got "${raw}"`);
    }
    const name = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!name) throw new Error(`--ai-header must include a header name, got "${raw}"`);
    headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function buildAgentConfig(opts: AgentRuntimeOpts): Record<string, unknown> {
  const aiHeaders = parseAiHeaders(opts.aiHeader);
  const config: Record<string, unknown> = {
    model: opts.model,
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
  };
  if (opts.aiProvider) config.aiProvider = opts.aiProvider;
  if (opts.aiBaseUrl) config.aiBaseUrl = opts.aiBaseUrl;
  if (opts.aiApiKeyEnv) config.aiApiKeyEnv = opts.aiApiKeyEnv;
  if (aiHeaders) config.aiHeaders = aiHeaders;
  return config;
}

