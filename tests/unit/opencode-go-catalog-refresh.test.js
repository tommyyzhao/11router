import { describe, expect, it } from "vitest";
import go from "../../open-sse/providers/registry/opencode-go.js";
import free from "../../open-sse/providers/registry/opencode.js";
import { getModelSupportedFormats, getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getAppPackageVersion } from "../../open-sse/config/appConstants.js";

// Official docs + direct unauthenticated Go catalog, 2026-10-16.
// cat-jam-free is docs-only; discovery is not proof of inference entitlement.
const ROOT = "https://opencode.ai/inference/go";
const ADDED = ["gemini-4-argon-contributor", "space-bunny", "longcat-2.5-preview-free", "step-5-preview", "beam-free", "cat-jam-free"];
const REMOVED = ["deepseek-flash", "glm-5", "kimi-k2.5", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "mimo-v2-pro", "mimo-v2-omni", "space-bunny-free", "qwen3.5-plus", "hy3-preview", "grok-4.5"];

describe("OpenCode Go current catalog", () => {
  it("adds current IDs, removes stale suggestions without disabling passthrough", () => {
    const ids = go.models.map(m => m.id);
    for (const id of ADDED) expect(ids).toContain(id);
    for (const id of REMOVED) expect(ids).not.toContain(id);
    for (const id of ["glm-5.1", "kimi-k2.6", "minimax-m2.5", "minimax-m2.7", "qwen3.6-plus", "qwen3.7-max", "grok-4.6", "omen-alpha"]) expect(ids).toContain(id);
    expect(go.passthroughModels).toBe(true);
    expect(getModelSupportedFormats("opencode-go", "deepseek-v4-flash")).toEqual(["openai", "claude", "openai-responses"]);
    expect(getModelSupportedFormats("opencode-go", "space-bunny-free")).toEqual(["openai", "claude"]);
  });

  it("uses canonical discovery and subscription notice, preserves unknown usage URL", () => {
    expect(go.modelsFetcher.url).toBe(`${ROOT}/v1/models`);
    expect(go.display.notice.text).toContain("$10");
    expect(go.display.notice.text).toContain("$40");
    expect(go.transport.usage.url).toBe("https://opencode.ai/zen/go/v1/usage");
  });

  it("sets documented default wires without dropping established alternatives", () => {
    for (const id of ["minimax-m3", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus"]) {
      expect(getModelTargetFormat("opencode-go", id)).toBe("claude");
      expect(getModelSupportedFormats("opencode-go", id)).toEqual(["openai", "claude"]);
    }
    expect(getModelSupportedFormats("opencode-go", "deepseek-v4-pro")).toEqual(["openai", "claude", "openai-responses"]);
    expect(getModelTargetFormat("opencode-go", "gemini-4-argon-contributor(high)")).toBe("gemini");
    expect(getModelSupportedFormats("opencode-go", "gemini-4-argon-contributor")).toEqual(["gemini"]);
    expect(go.models.find(m => m.id === "beam-free").supportedFormats).toBeUndefined();
  });

  it("keeps Free curated candidates and discovery separate from Go", () => {
    for (const id of ["longcat-2.5-preview-free", "space-bunny-free"]) expect(free.models.map(m => m.id)).toContain(id);
    expect(free.modelsFetcher.url).toBe("https://opencode.ai/inference/v1/models");
    expect(free.noAuth).toBe(true);
  });
});

describe("OpenCode Go native Gemini transport", () => {
  const executor = new OpenCodeGoExecutor();
  for (const stream of [false, true]) {
    it(`builds fixed-host model URL and protocol auth (stream=${stream})`, () => {
      const model = "gemini-4-argon-contributor";
      const credentials = {
        apiKey: "test-go-key",
        runtimeTransport: resolveTransport("opencode-go", "gemini"),
        rawHeaders: { authorization: "Bearer client-secret", "x-api-key": "client-secret", "anthropic-beta": "client-beta" },
      };
      const url = executor.buildUrl(model, stream, 0, credentials);
      expect(url).toBe(`${ROOT}/google/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`);
      const headers = executor.buildHeaders(credentials, stream, url, model);
      expect(headers["User-Agent"]).toBe(`9router/${getAppPackageVersion()}`);
      expect(headers["x-goog-api-key"]).toBe("test-go-key");
      expect(JSON.stringify(headers)).not.toContain("client-secret");
      for (const key of ["Authorization", "authorization", "x-api-key", "anthropic-version", "anthropic-beta"]) expect(headers[key]).toBeUndefined();
      expect(url).not.toContain("test-go-key");
      expect(headers["x-opencode-session"]).toMatch(/^ses_/);
    });
  }

  it("does not accept a runtime host override for Gemini", () => {
    expect(executor.buildUrl("gemini-4-argon-contributor", false, 0, { runtimeTransport: { baseUrl: "https://attacker.invalid" } })).toBe(`${ROOT}/google/v1beta/models/gemini-4-argon-contributor:generateContent`);
  });

  it("encodes model path data rather than allowing injected URL suffixes", () => {
    const model = "gemini-4-argon-contributor/../../x?key=secret";
    const url = executor.buildUrl(model, true, 0, { runtimeTransport: resolveTransport("opencode-go", "gemini") });
    expect(url).toBe(`${ROOT}/google/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`);
  });
});

describe("OpenCode Go scoped metadata and flat estimates", () => {
  for (const [model, contextWindow, maxOutput] of [
    ["grok-4.7", 500000, 500000],
    ["kimi-k2.7-code", 262144, 262144],
    ["qwen3.8-flash", 1000000, 131072],
    ["gemini-4-argon-contributor", 1048576, 65536],
    ["longcat-2.5-preview-free", 1000000, 131072],
    ["space-bunny", 1048576, 524288],
  ]) {
    it(`pins ${model} limits`, () => {
      expect(getCapabilitiesForModel("opencode-go", model)).toMatchObject({ contextWindow, maxOutput });
    });
  }

  it("preserves provider-specific Haiku adaptive and GLM Flash thinking", () => {
    expect(getCapabilitiesForModel("opencode-go", "claude-haiku-5-5").thinkingFormat).toBe("claude-adaptive");
    expect(getCapabilitiesForModel("opencode-go", "glm-5.3-flash").thinkingFormat).toBe("openai");
  });

  it("provides exact missing documented rates, free zero, leaves public Grok rate intact", () => {
    expect(getPricingForModel("opencode-go", "gemini-4-argon-contributor")).toMatchObject({ input: 4, output: 20, cached: 0.2 });
    expect(getPricingForModel("opencode-go", "step-5-preview")).toMatchObject({ input: 1, output: 2.7, cached: 0.1 });
    expect(getPricingForModel("opencode-go", "space-bunny")).toMatchObject({ input: 0.15, output: 0.6, cached: 0.03 });
    for (const id of ["longcat-2.5-preview-free", "cat-jam-free", "beam-free"]) expect(getPricingForModel("opencode-go", id)).toMatchObject({ input: 0, output: 0 });
    for (const id of ["longcat-2.5-preview-free", "space-bunny-free"]) expect(getPricingForModel("oc", id)).toMatchObject({ input: 0, output: 0 });
    expect(getPricingForModel("opencode-go", "grok-4.7")).toMatchObject({ input: 2, output: 6, cached: 0.5 });
  });
});
