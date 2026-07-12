import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPiReadOnlyToolDefinitions,
  resolvePiModelWithDynamicGateway,
} from "../agents/pi-sdk.js";

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

describe("Pi model resolution", () => {
  const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
    globalThis.fetch = originalFetch;
  });

  it("hydrates missing Vercel AI Gateway models from the live catalog shape", async () => {
    process.env.AI_GATEWAY_API_KEY = "vck_test";
    globalThis.fetch = async (input, init) => {
      expect(String(input)).toBe("https://ai-gateway.vercel.sh/v1/models");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer vck_test");
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "xai/grok-4.5",
              name: "Grok 4.5",
              type: "language",
              tags: ["reasoning", "tool-use", "vision"],
              context_window: 500000,
              max_tokens: 500000,
              pricing: {
                input: "0.000002",
                output: "0.000006",
                input_cache_read: "0.0000005",
              },
            },
            {
              id: "xai/grok-imagine-image",
              name: "Grok Imagine Image",
              type: "image",
            },
          ],
        }),
        { status: 200 },
      );
    };

    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    const model = await resolvePiModelWithDynamicGateway(registry, "xai/grok-4.5", {});

    expect(model.provider).toBe("vercel-ai-gateway");
    expect(model.id).toBe("xai/grok-4.5");
    expect(model.name).toBe("Grok 4.5");
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.contextWindow).toBe(500000);
    expect(model.maxTokens).toBe(500000);
    expect(model.cost.input).toBe(2);
    expect(model.cost.output).toBe(6);
    expect(registry.find("vercel-ai-gateway", "xai/grok-imagine-image")).toBeUndefined();
  });

  it("does not hydrate Gateway models for explicit custom provider overrides", async () => {
    process.env.AI_GATEWAY_API_KEY = "vck_test";
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    await expect(
      resolvePiModelWithDynamicGateway(registry, "xai/grok-4.5", {
        aiProvider: "xai",
      }),
    ).rejects.toThrow(/Pi model not found: xai\/grok-4\.5/);
    expect(called).toBe(false);
  });
});
