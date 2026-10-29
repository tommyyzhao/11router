import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentials: vi.fn(), persist: vi.fn(), lease: vi.fn(), invalidate: vi.fn(),
  oauthRefresh: vi.fn(), execute: vi.fn(),
}));

// Keep the app callback, chatCore refresh/retry, and MiniMax executor real;
// isolate account selection, persistence, broker I/O, and upstream transport.
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}) }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials,
  markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
  extractApiKey: () => null, isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: mocks.persist,
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "minimax-code", model: "MiniMax-M3" }),
  getComboModels: async () => null,
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null, enforceKeyAccess: async () => null,
  filterAdapterModels: async (_context, models) => models,
}));
vi.mock("@/sse/services/systemoneRouter.js", () => ({ resolveSmartChoice: vi.fn() }));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn(),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:8787" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: async () => {},
  saveRequestDetail: async () => {}, saveRequestUsage: async () => {},
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("../../open-sse/services/minimaxCodeLease.js", async (original) => ({
  ...(await original()), getLeaseToken: mocks.lease, invalidateLeaseToken: mocks.invalidate,
}));
vi.mock("../../open-sse/services/tokenRefresh.js", async (original) => ({
  ...(await original()), refreshMiniMaxCodeToken: mocks.oauthRefresh,
}));
vi.mock("../../open-sse/executors/default.js", () => ({
  DefaultExecutor: class {
    constructor(provider) { this.provider = provider; }
    execute(args) { return mocks.execute(args.credentials.accessToken); }
  },
}));
vi.mock("../../open-sse/executors/index.js", async () => {
  const { MinimaxCodeExecutor } = await import("../../open-sse/executors/minimax-code.js");
  return { getExecutor: () => new MinimaxCodeExecutor("minimax-code") };
});

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { getMiniMaxCodeUsage } = await import("../../open-sse/services/minimaxCodeUsage.js");

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call"); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("MiniMax lease credentials stay in memory", () => {
  it.each(["mcode-lease", "oauth"])("refreshes and retries %s; persists only OAuth", async (authType) => {
    const credentials = {
      connectionId: "test-connection", authType, accessToken: "old-token",
      refreshToken: "oauth-refresh", providerSpecificData: { realUserID: "test-user" },
    };
    mocks.credentials.mockResolvedValue(credentials);
    mocks.lease.mockResolvedValueOnce({ accessToken: "initial-lease" })
      .mockResolvedValue({ accessToken: "new-token" });
    mocks.oauthRefresh.mockResolvedValue({ accessToken: "new-token", refreshToken: "rotated-refresh" });
    mocks.execute.mockResolvedValueOnce({ response: new Response("Unauthorized", { status: 401 }) })
      .mockResolvedValueOnce({ response: new Response(JSON.stringify({
        id: "test", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }), { headers: { "content-type": "application/json" } }) });

    const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "minimax-code/MiniMax-M3", stream: false, messages: [{ role: "user", content: "hello" }] }),
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
    expect(mocks.execute.mock.calls).toEqual([[authType === "mcode-lease" ? "initial-lease" : "old-token"], ["new-token"]]);
    expect(credentials.accessToken).toBe("new-token");
    if (authType === "mcode-lease") {
      expect(mocks.invalidate).toHaveBeenCalledTimes(1);
      expect(mocks.persist).not.toHaveBeenCalled();
      expect(mocks.oauthRefresh).not.toHaveBeenCalled();
    } else {
      expect(mocks.lease).not.toHaveBeenCalled();
      expect(mocks.persist).toHaveBeenCalledExactlyOnceWith("test-connection", {
        accessToken: "new-token", refreshToken: "rotated-refresh",
        existingProviderSpecificData: { realUserID: "test-user" }, testStatus: "active",
      });
    }
  });

  it("uses the broker for usage even with a stale stored token", async () => {
    mocks.lease.mockResolvedValue({ accessToken: "usage-lease" });
    fetch.mockResolvedValue(new Response(JSON.stringify({ workspaces: [] })));

    const result = await getMiniMaxCodeUsage({
      provider: "minimax-code", authType: "mcode-lease", accessToken: "stale-stored-token",
      providerSpecificData: { realUserID: "test-user" },
    });

    expect(mocks.lease).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer usage-lease");
    expect(result.quotas).toBeDefined();
  });

  it("does not fall back to a stored token when the usage broker fails", async () => {
    mocks.lease.mockRejectedValue(new Error("Broker unavailable"));
    const result = await getMiniMaxCodeUsage({
      provider: "minimax-code", authType: "mcode-lease", accessToken: "stale-stored-token",
    });
    expect(mocks.lease).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({ message: "Usage API not implemented for minimax-code" });
  });
});
