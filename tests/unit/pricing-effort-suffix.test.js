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

  it("covers dotted Kiro ids and leaves unsuffixed lookups unchanged", () => {
    expect(getPricingForModel("kiro", "claude-opus-5.5")).toMatchObject({ input: 4, output: 20 });
    expect(getPricingForModel("muse", "muse-spark-1.3-contributor(xhigh)")).toMatchObject({ input: 0.1, output: 0.2 });
    expect(getPricingForModel("x", "totally-unknown(high)")).toBeNull();
  });
});
