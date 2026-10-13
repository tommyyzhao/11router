import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("muse local-spend quota", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registry declares usage and usageApikey for muse", async () => {
    const { default: muse } = await import(
      "../../open-sse/providers/registry/muse.js"
    );
    expect(muse.features?.usage).toBe(true);
    expect(muse.features?.usageApikey).toBe(true);
    expect(muse.authModes).toEqual(["oauth", "apikey"]);
    expect(muse.transport.usage.url).toBe("https://api.meta.ai/v1/models");
  });

  it("registers muse in USAGE_HANDLERS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
        }),
      ),
    );
    const { getUsageForProvider } = await import(
      "../../open-sse/services/usage.js"
    );
    const usage = await getUsageForProvider(
      { provider: "muse", accessToken: "LLM|123|abc" },
      null,
      {},
    );
    expect(usage.message).not.toMatch(/not implemented/i);
    expect(usage.localSpend).toBe(true);
    expect(usage.plan).toBe("Muse (Meta Model API)");
  });

  it("returns missing-token message without fetching", async () => {
    const { getMuseUsage } = await import(
      "../../open-sse/services/usage/muse.js"
    );
    const usage = await getMuseUsage("", null, null);
    expect(usage.message).toBe(
      "Muse credentials not available. Reconnect to view usage.",
    );
    const blank = await getMuseUsage("   ", null, null);
    expect(blank.message).toBe(
      "Muse credentials not available. Reconnect to view usage.",
    );
  });

  it("getMuseUsage validates key and marks localSpend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
        }),
      ),
    );
    const { getMuseUsage } = await import(
      "../../open-sse/services/usage/muse.js"
    );
    const usage = await getMuseUsage("LLM|123|secret", null, null);
    expect(usage.localSpend).toBe(true);
    expect(usage.plan).toBe("Muse (Meta Model API)");
    expect(usage.message).toMatch(/9Router/i);
    expect(usage.quotas).toEqual({});
  });

  it("getMuseUsage uses subscriptionTier in plan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
        }),
      ),
    );
    const { getMuseUsage } = await import(
      "../../open-sse/services/usage/muse.js"
    );
    const usage = await getMuseUsage(
      "LLM|123|secret",
      { subscriptionTier: "Contributor" },
      null,
    );
    expect(usage.plan).toBe("Muse Code (Contributor)");
  });

  it("getMuseUsage handles 401 as auth failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const { getMuseUsage } = await import(
      "../../open-sse/services/usage/muse.js"
    );
    const usage = await getMuseUsage("LLM|123|secret", null, null);
    expect(usage.plan).toBe("Muse (Meta Model API)");
    expect(usage.message).toMatch(/authentication failed/i);
  });

  it("buildLocalSpendQuotas produces unlimited count rows", async () => {
    const { buildLocalSpendQuotas } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const quotas = buildLocalSpendQuotas({
      d7: { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0 },
      d30: { requests: 4, promptTokens: 80, completionTokens: 20, cost: 0.01 },
    });
    expect(quotas["Requests (30d)"].used).toBe(4);
    expect(quotas["Requests (30d)"].unlimited).toBe(true);
    expect(quotas["Requests (30d)"].remainingPercentage).toBe(100);
    expect(quotas["Est. cost (30d, USD)"].used).toBeCloseTo(0.01, 6);
  });

  it("enrichUsageWithLocalSpend merges rows and clears message", async () => {
    vi.doMock("../../src/lib/db/repos/usageRepo.js", () => ({
      getLocalSpendForConnection: async () => ({
        d7: { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0 },
        d30: { requests: 2, promptTokens: 20, completionTokens: 4, cost: 0 },
      }),
    }));
    const { enrichUsageWithLocalSpend } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const enriched = await enrichUsageWithLocalSpend(
      {
        plan: "Muse (Meta Model API)",
        message: "Meta does not expose subscription usage percentages over HTTP; showing spend routed through 9Router.",
        quotas: {},
      },
      { id: "muse-conn", provider: "muse" },
    );
    expect(enriched.quotas["Requests (30d)"].used).toBe(2);
    expect(enriched.message).toBeUndefined();
    expect(enriched.plan).toBe("Muse (Meta Model API)");
    expect(enriched.localSpend).toBe(true);
  });
});
