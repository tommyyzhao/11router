/**
 * Mistral local-spend quota card.
 * Run: cd tests && npx vitest run unit/mistral-local-spend-quota.test.js
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// proxyAwareFetch drives the *packaged* undici fetch (rawFetch imports undici
// directly), never globalThis.fetch — stub undici, not fetch. Other undici
// exports consumed across the import graph (Agent, ProxyAgent) are stubbed
// as inert classes.
function stubUpstream(status, body = JSON.stringify({ object: "list", data: [] })) {
  vi.doMock("undici", () => ({
    fetch: vi.fn(async () => new Response(body, { status })),
    Agent: class {},
    ProxyAgent: class {},
  }));
}

describe("mistral local-spend quota", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock("undici");
  });

  it("registry declares usage + usageApikey for mistral", async () => {
    const { default: mistral } = await import(
      "../../open-sse/providers/registry/mistral.js"
    );
    expect(mistral.features?.usage).toBe(true);
    expect(mistral.features?.usageApikey).toBe(true);
  });

  it("registers mistral in USAGE_HANDLERS", async () => {
    stubUpstream(200);
    const { getUsageForProvider } = await import(
      "../../open-sse/services/usage.js"
    );
    const usage = await getUsageForProvider(
      { provider: "mistral", apiKey: "test-key" },
      null,
      {},
    );
    expect(usage.message).not.toMatch(/not implemented/i);
    expect(usage.localSpend).toBe(true);
    expect(usage.plan).toBe("Mistral");
  });

  it("getMistralUsage validates key and marks localSpend", async () => {
    stubUpstream(200);
    const { getMistralUsage } = await import(
      "../../open-sse/services/usage/mistral.js"
    );
    const usage = await getMistralUsage("test-key", null);
    expect(usage.localSpend).toBe(true);
    expect(usage.quotas).toEqual({});
    expect(usage.message).toMatch(/9Router/i);
    expect(usage.plan).toBe("Mistral");
  });

  it("getMistralUsage surfaces auth failure", async () => {
    stubUpstream(401, "nope");
    const { getMistralUsage } = await import(
      "../../open-sse/services/usage/mistral.js"
    );
    const usage = await getMistralUsage("bad-key", null);
    expect(usage.message).toMatch(/authentication failed/i);
  });

  it("enrich clears message when local spend rows exist (card would hide table)", async () => {
    vi.doMock("../../src/lib/db/repos/usageRepo.js", () => ({
      getLocalSpendForConnection: async () => ({
        d7: { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0 },
        d30: { requests: 3, promptTokens: 30, completionTokens: 5, cost: 0 },
      }),
    }));
    const { enrichUsageWithLocalSpend } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const enriched = await enrichUsageWithLocalSpend(
      {
        plan: "Mistral",
        message: "API key valid. Mistral does not expose numeric quota for this key; showing spend routed through 9Router.",
        quotas: {},
      },
      { id: "conn-1", provider: "mistral" },
    );
    expect(enriched.quotas["Requests (30d)"].used).toBe(3);
    expect(enriched.message).toBeUndefined();
  });

  it("buildLocalSpendQuotas produces unlimited count rows", async () => {
    const { buildLocalSpendQuotas } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const quotas = buildLocalSpendQuotas({
      d7: { requests: 2, promptTokens: 40, completionTokens: 6, cost: 0.0001 },
      d30: { requests: 15, promptTokens: 286, completionTokens: 55, cost: 0.00035 },
    });
    expect(quotas["Requests (30d)"].used).toBe(15);
    expect(quotas["Requests (30d)"].unlimited).toBe(true);
    expect(quotas["Prompt tokens (30d)"].used).toBe(286);
    expect(quotas["Completion tokens (7d)"].used).toBe(6);
    expect(quotas["Est. cost (30d, USD)"].used).toBeCloseTo(0.00035, 6);
  });

  it("enrichUsageWithLocalSpend merges rows for mistral connections", async () => {
    vi.doMock("../../src/lib/db/repos/usageRepo.js", () => ({
      getLocalSpendForConnection: async () => ({
        d7: { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0 },
        d30: { requests: 3, promptTokens: 30, completionTokens: 5, cost: 0 },
      }),
    }));
    const { enrichUsageWithLocalSpend } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const enriched = await enrichUsageWithLocalSpend(
      { plan: "Mistral", quotas: {} },
      { id: "conn-1", provider: "mistral" },
    );
    expect(enriched.localSpend).toBe(true);
    expect(enriched.quotas["Requests (30d)"].used).toBe(3);
  });

  it("enrichUsageWithLocalSpend is a no-op for non-local-spend providers", async () => {
    vi.doMock("../../src/lib/db/repos/usageRepo.js", () => ({
      getLocalSpendForConnection: async () => {
        throw new Error("should not be called");
      },
    }));
    const { enrichUsageWithLocalSpend } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const usage = { plan: "DeepSeek", quotas: { "Balance (USD)": { used: 0, total: 1 } } };
    const enriched = await enrichUsageWithLocalSpend(usage, {
      id: "conn-2",
      provider: "deepseek",
    });
    expect(enriched).toBe(usage);
  });

  it("parseQuotaData forwards mistral local-spend rows with unlimited", async () => {
    const { parseQuotaData } = await import(
      "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );
    const parsed = parseQuotaData("mistral", {
      plan: "Mistral",
      localSpend: true,
      quotas: {
        "Requests (30d)": { used: 12, total: 0, remainingPercentage: 100, unlimited: true },
        "Est. cost (30d, USD)": { used: 0.42, total: 0, remainingPercentage: 100, unlimited: true },
      },
    });
    expect(parsed).toHaveLength(2);
    const rows = Object.fromEntries(parsed.map((r) => [r.name, r]));
    expect(rows["Requests (30d)"].used).toBe(12);
    expect(rows["Requests (30d)"].unlimited).toBe(true);
    expect(rows["Est. cost (30d, USD)"].used).toBeCloseTo(0.42, 6);
  });
});
