/**
 * Mistral Vibe CLI 3.1 lineup — registry, thinking levels, capabilities, pricing.
 * Ground truth: live /v1/models + /v1/chat/completions probes on api.mistral.ai
 * (2026-11-20) and mistral-vibe 3.1.x known_models.
 * Run: cd tests && npx vitest run unit/mistral-vibe-3-1.test.js
 */
import { describe, it, expect } from "vitest";
import mistral from "../../open-sse/providers/registry/mistral.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getProviderModels, isValidModel } from "../../open-sse/config/providerModels.js";

const CHAT_IDS = mistral.models.filter((m) => m.kind !== "embedding").map((m) => m.id);

describe("mistral registry — Vibe CLI 3.1 lineup", () => {
  it("exposes the 3.1 catalog plus legacy public models", () => {
    expect(CHAT_IDS).toEqual([
      "mistral-large-4",
      "zai-glm-5-3",
      "zai-glm-5-3-flash",
      "mistral-medium-3.5",
      "mistral-vibe-cli-latest",
      "mistral-medium-latest",
      "mistral-large-latest",
      "codestral-latest",
    ]);
    expect(mistral.models.some((m) => m.id === "mistral-embed" && m.kind === "embedding")).toBe(true);
    // Retired/unused ids stay out of the registry.
    for (const dead of ["devstral-small-latest", "mistral-vibe-cli-fast", "mistral-vibe-cli-with-tools"]) {
      expect(CHAT_IDS).not.toContain(dead);
    }
  });

  it("models resolve through the provider matrix", () => {
    for (const id of CHAT_IDS) {
      expect(isValidModel("mistral", id)).toBe(true);
    }
    expect(getProviderModels("mistral").map((m) => m.id)).toEqual(mistral.models.map((m) => m.id));
  });

  it("transport quirks lift thinking blocks and drop client metadata", () => {
    expect(PROVIDERS.mistral.quirks.dropClientMetadata).toBe(true);
    expect(PROVIDERS.mistral.quirks.reasoningAliasFields).toBe(true);
    expect(PROVIDERS.mistral.baseUrl).toBe("https://api.mistral.ai/v1/chat/completions");
  });
});

describe("mistral thinking levels — probed live on api.mistral.ai", () => {
  it("mistral-large-4: low/medium/high, no disable", () => {
    expect(getThinkingLevels("mistral", "mistral-large-4")).toEqual(["low", "medium", "high"]);
    const caps = getCapabilitiesForModel("mistral", "mistral-large-4");
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("openai");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.vision).toBe(true);
  });

  it("zai-glm-5-3 pair: low/high/max (medium rejected upstream), text-only", () => {
    for (const id of ["zai-glm-5-3", "zai-glm-5-3-flash"]) {
      expect(getThinkingLevels("mistral", id)).toEqual(["low", "high", "max"]);
      const caps = getCapabilitiesForModel("mistral", id);
      expect(caps.reasoning).toBe(true);
      expect(caps.thinkingFormat).toBe("openai");
      expect(caps.thinkingCanDisable).toBe(false);
      expect(caps.contextWindow).toBe(1048576);
      expect(caps.maxOutput).toBe(131072);
      expect(caps.vision).toBe(false);
    }
  });

  it("Medium 3.5 family (incl. vibe-cli alias): high only, can disable", () => {
    for (const id of ["mistral-medium-3.5", "mistral-vibe-cli-latest", "mistral-medium-latest"]) {
      expect(getThinkingLevels("mistral", id)).toEqual(["none", "high"]);
      const caps = getCapabilitiesForModel("mistral", id);
      expect(caps.reasoning).toBe(true);
      expect(caps.thinkingFormat).toBe("openai");
      expect(caps.thinkingCanDisable).toBe(true);
      expect(caps.contextWindow).toBe(262144);
      expect(caps.vision).toBe(true);
    }
  });

  it("mistral-large-latest (Large 2512) has no reasoning", () => {
    expect(getThinkingLevels("mistral", "mistral-large-latest")).toBeNull();
    expect(getCapabilitiesForModel("mistral", "mistral-large-latest").reasoning).toBe(false);
  });
});

describe("mistral pricing — docs.mistral.ai model pages", () => {
  it("3.1 lineup carries the published rates", () => {
    expect(getPricingForModel("mistral", "mistral-large-4")).toMatchObject({
      input: 0.7, output: 2.1, cached: 0.07,
    });
    expect(getPricingForModel("mistral", "zai-glm-5-3")).toMatchObject({
      input: 1.4, output: 4.4, cached: 0.14,
    });
    expect(getPricingForModel("mistral", "zai-glm-5-3-flash")).toMatchObject({
      input: 0.15, output: 0.5, cached: 0.03,
    });
    expect(getPricingForModel("mistral", "mistral-medium-3.5")).toMatchObject({
      input: 1.5, output: 7.5, cached: 0.15,
    });
  });

  it("legacy aliases keep the owner-decided Medium 3.5 rates", () => {
    expect(getPricingForModel("mistral", "mistral-vibe-cli-latest")).toMatchObject({
      input: 1.5, output: 7.5, cached: 0.15,
    });
    expect(getPricingForModel("mistral", "mistral-medium-latest")).toMatchObject({
      input: 1.5, output: 7.5, cached: 0.15,
    });
  });
});
