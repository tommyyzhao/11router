import { describe, expect, it } from "vitest";
import muse from "../../open-sse/providers/registry/muse.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("muse-ember-1.0", () => {
  it("is a canonical Responses-wire model on the muse provider", () => {
    expect(muse.models.find((m) => m.id === "muse-ember-1.0")).toMatchObject({
      name: "Muse Ember 1.0",
      targetFormat: "openai-responses",
      supportedFormats: ["openai-responses"],
    });
  });

  it("reports multimodal reasoning caps and minimal..max levels", () => {
    expect(getCapabilitiesForModel("muse", "muse-ember-1.0")).toMatchObject({
      vision: true,
      audioInput: true,
      videoInput: true,
      pdf: true,
      reasoning: true,
      contextWindow: 1048576,
      maxOutput: 524288,
    });
    expect(getThinkingLevels("muse", "muse-ember-1.0")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("emits nested reasoning.effort on the Responses wire", () => {
    const body = { input: "hi" };
    applyThinking("openai-responses", "muse-ember-1.0(xhigh)", body, "muse");
    expect(body.reasoning).toMatchObject({ effort: "xhigh" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("prices at $0.10 in / $0.50 out per 1M tokens", () => {
    expect(getPricingForModel("muse", "muse-ember-1.0")).toMatchObject({
      input: 0.1,
      output: 0.5,
      cached: 0.004,
    });
  });
});
