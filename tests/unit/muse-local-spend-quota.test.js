import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function subscriptionResponse() {
  const event = {
    type: "response.subscription_usage",
    subscription: {
      tier: "123",
      window: { used_percent: 95, resets_at: 1791924691, window_duration_mins: 300 },
      weekly: { used_percent: 65, resets_at: 1792368000 },
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

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
    expect(muse.transport.usage.url).toBe("https://api.meta.ai/v1/responses");
  });

  it("registers muse in USAGE_HANDLERS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => subscriptionResponse()),
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
    expect(usage.quotas["Session (5h)"].remainingPercentage).toBe(5);
    expect(usage.plan).toBe("Muse Code (tier 123)");
  });

  it("returns missing-token message without fetching", async () => {
    const { getMuseUsage } = await import(
      "../../open-sse/services/usage/muse.js"
    );
    const usage = await getMuseUsage({ accessToken: "" });
    expect(usage.message).toBe(
      "Muse key not available. Reconnect this connection.",
    );
    const blank = await getMuseUsage({ accessToken: "   " });
    expect(blank.message).toBe(
      "Muse key not available. Reconnect this connection.",
    );
  });

  it("getMuseUsage returns subscription quotas before local-spend enrichment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => subscriptionResponse()),
    );
    const { getMuseUsage } = await import(
      "../../open-sse/services/usage/muse.js"
    );
    const usage = await getMuseUsage({ accessToken: "LLM|123|secret" });
    expect(usage.localSpend).toBeUndefined();
    expect(usage.plan).toBe("Muse Code (tier 123)");
    expect(usage.message).toContain("Snapshot");
    expect(usage.quotas["Weekly (7d)"].remainingPercentage).toBe(35);
  });

  it("getMuseUsage uses the snapshot tier instead of legacy subscriptionTier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => subscriptionResponse()),
    );
    const { getMuseUsage } = await import(
      "../../open-sse/services/usage/muse.js"
    );
    const usage = await getMuseUsage({
      accessToken: "LLM|123|secret",
      providerSpecificData: { subscriptionTier: "Contributor" },
    });
    expect(usage.plan).toBe("Muse Code (tier 123)");
  });

  it("getMuseUsage handles 401 as auth failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const { getMuseUsage } = await import(
      "../../open-sse/services/usage/muse.js"
    );
    const usage = await getMuseUsage({ accessToken: "LLM|123|secret" });
    expect(usage.quotas).toBeUndefined();
    expect(usage.message).toMatch(/authentication expired \(401\)/i);
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

  it.each([
    "Snapshot 1 minute old. Refresh probes use a little subscription quota.",
    "Muse quota probe failed (500). Snapshot 11 minutes old.",
  ])("enrichUsageWithLocalSpend preserves subscription quotas and message: %s", async (message) => {
    vi.doMock("../../src/lib/db/repos/usageRepo.js", () => ({
      getLocalSpendForConnection: async () => ({
        d7: { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0 },
        d30: { requests: 2, promptTokens: 20, completionTokens: 4, cost: 0 },
      }),
    }));
    const { enrichUsageWithLocalSpend } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const usage = {
      plan: "Muse Code (tier 123)",
      message,
      quotas: {
        "Session (5h)": { used: 95, total: 100, remainingPercentage: 5, resetAt: "2026-10-13T20:51:31.000Z", unlimited: false },
        "Weekly (7d)": { used: 65, total: 100, remainingPercentage: 35, resetAt: "2026-10-19T00:00:00.000Z", unlimited: false },
      },
    };
    const enriched = await enrichUsageWithLocalSpend(
      usage,
      { id: "muse-conn", provider: "muse" },
    );
    expect(enriched.quotas["Requests (30d)"].used).toBe(2);
    expect(enriched.quotas["Session (5h)"]).toEqual(usage.quotas["Session (5h)"]);
    expect(enriched.quotas["Weekly (7d)"]).toEqual(usage.quotas["Weekly (7d)"]);
    expect(enriched.message).toBe(message);
    expect(enriched.plan).toBe(usage.plan);
    expect(enriched.localSpend).toBe(true);
    expect(Object.keys(usage.quotas)).toEqual(["Session (5h)", "Weekly (7d)"]);
    const { parseQuotaData } = await import(
      "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );
    const rows = parseQuotaData("muse", enriched);
    expect(rows.find((row) => row.name === "Session (5h)").remainingPercentage).toBe(5);
    expect(rows.find((row) => row.name === "Weekly (7d)").remainingPercentage).toBe(35);
    expect(rows.find((row) => row.name === "Requests (30d)").unlimited).toBe(true);
  });
});
