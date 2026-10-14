import { describe, it, expect } from "vitest";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

describe("pricing: combo effort suffix", () => {
  it("prices gpt-6.1-sol(high) as gpt-6.1-sol, not $0", () => {
    expect(getPricingForModel("codex", "gpt-6.1-sol(high)")).toMatchObject({ input: 2, output: 10, cached: 0.1 });
    expect(getPricingForModel("codex", "gpt-6-luna(medium)")).toMatchObject({ input: 0.1, output: 0.5 });
  });

  it("uses the exact model rate instead of the coarse claude-* pattern", () => {
    expect(getPricingForModel("claude", "claude-opus-5-5(xhigh)")).toMatchObject({ input: 4, output: 20, cached: 0.2 });
    expect(getPricingForModel("claude", "claude-haiku-5-5(medium)")).toMatchObject({ input: 0.1, output: 0.5 });
  });

  it.each([
    ["claude", "claude-fable-5-1(high)", 10, 50, 0.25],
    ["codex", "gpt-5.6-sol", 4, 20, 0.4],
    ["codex", "gpt-5.6-luna(xhigh)", 0.2, 1.2, 0.02],
    ["codex", "gpt-5.6-terra", 2, 12, 0.2],
    ["muse", "muse-wonder-1.0", 4, 20, 0.2],
    ["clinepass", "cline-pass/glm-5.3", 1.4, 4.4, 0.26],
    ["nvidia", "z-ai/glm-5.3-flash", 0.15, 0.5, 0.03],
    ["mistral", "mistral-medium-3-5", 1.5, 7.5, 0.15],
    ["mistral", "codestral-latest", 0.3, 0.9, 0.03],
    ["cloudflare-ai", "@cf/moonshotai/kimi-k2.6", 0.95, 4, 0.16],
    ["xiaomi-mimo", "mimo-v2.6-flash", 0.14, 0.28, 0.0028],
  ])("resolves public API rates for %s/%s", (provider, model, input, output, cached) => {
    expect(getPricingForModel(provider, model)).toMatchObject({ input, output, cached });
  });

  it("prices hosted/open models without generic patterns", () => {
    expect(getPricingForModel("kiro", "qwen3-coder-next")).toMatchObject({ input: 0.3, output: 1.5 });
    expect(getPricingForModel("cerebras", "gpt-oss-120b(high)")).toMatchObject({ input: 0.35, output: 0.75 });
    expect(getPricingForModel("grok-cli", "grok-4.7-build-fast")).toMatchObject({ input: 4, output: 12, cached: 1 });
    expect(getPricingForModel("clinepass", "cline-pass/minimax-m3")).toEqual(getPricingForModel("minimax", "MiniMax-M3"));
  });

  it.each(["muse-spark-1.3-contributor-free(xhigh)", "mimo-v2.5-free", "dots-studio/dots-3-note-preview:free", "cline-free/glm-5.3"])("keeps genuinely free %s at zero", model => {
    expect(getPricingForModel("opencode", model)).toMatchObject({ input: 0, output: 0, cached: 0 });
  });

  it("covers dotted Kiro ids and leaves unsuffixed lookups unchanged", () => {
    expect(getPricingForModel("kiro", "claude-opus-5.5")).toMatchObject({ input: 4, output: 20 });
    expect(getPricingForModel("muse", "muse-spark-1.3-contributor(xhigh)")).toMatchObject({ input: 0.1, output: 0.2 });
    expect(getPricingForModel("x", "totally-unknown(high)")).toBeNull();
  });

  it("applies owner-decided prices for models without a public rate", () => {
    expect(getPricingForModel("xiaomi-mimo", "mimo-x-pro-preview")).toMatchObject({ input: 0.435, output: 0.87 });
    expect(getPricingForModel("mistral", "mistral-vibe-cli-latest")).toMatchObject({ input: 1.5, output: 7.5 });
    expect(getPricingForModel("nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b")).toMatchObject({ input: 0, output: 0 });
    expect(getPricingForModel("nvidia", "meta/muse-glimmer-30b")).toMatchObject({ input: 0, output: 0 });
  });
});
