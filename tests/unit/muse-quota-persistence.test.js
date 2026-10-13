import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn() }));
vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: async () => ({ ...mocks, transaction: (fn) => fn() }),
}));
import { museCredentialFingerprint } from "../../open-sse/utils/museSubscriptionUsage.js";
import { updateMuseSubscriptionUsage, updateProviderConnection } from "../../src/lib/db/repos/connectionsRepo.js";

const snapshot = { tier: "1", window: { usedPercent: 95, resetsAt: 1791924691, durationMins: 300 }, weekly: { usedPercent: 65, resetsAt: 1792368000 }, capturedAt: 1000 };
const row = (data = {}, provider = "muse") => ({ id: "account", provider, authType: "oauth", isActive: 1, data: JSON.stringify({ accessToken: "synthetic", ...data }) });

beforeEach(() => vi.clearAllMocks());
describe("Muse quota persistence (mock adapter, no real DB)", () => {
  it("atomically merges only the snapshot, preserves proxy/credential/identity fields", async () => {
    mocks.get.mockReturnValue(row({ providerSpecificData: { connectionProxyPoolId: "pool", username: "user" }, refreshToken: "synthetic-refresh" }));
    await updateMuseSubscriptionUsage("account", snapshot, "synthetic");
    const [, params] = mocks.run.mock.calls[0];
    expect(params[0]).toBe("account");
    expect(JSON.parse(params[7])).toEqual({
      accessToken: "synthetic", refreshToken: "synthetic-refresh",
      providerSpecificData: { connectionProxyPoolId: "pool", username: "user", museSubscriptionUsage: snapshot, museSubscriptionUsageCredential: museCredentialFingerprint("synthetic") },
    });
  });
  it("credential replacement clears quota/fingerprint without dropping proxy metadata", async () => {
    mocks.get.mockReturnValue(row({ providerSpecificData: { museSubscriptionUsage: snapshot, museSubscriptionUsageCredential: museCredentialFingerprint("synthetic"), connectionProxyPoolId: "pool" } }));
    await updateProviderConnection("account", { accessToken: "replacement" });
    expect(JSON.parse(mocks.run.mock.calls[0][1][7]).providerSpecificData).toEqual({ connectionProxyPoolId: "pool" });
  });
  it.each([null, row({}, "codex"), row({ accessToken: "replacement" }), row({ providerSpecificData: { museSubscriptionUsage: { capturedAt: 2000 } } })])("ignores deleted/replaced/non-Muse/newer connections %#", async (value) => {
    mocks.get.mockReturnValue(value);
    await updateMuseSubscriptionUsage("account", snapshot, "synthetic");
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
