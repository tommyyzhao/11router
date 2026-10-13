import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { parseMuseSubscriptionUsage, validateMuseSubscriptionSnapshot, captureMuseSubscriptionUsage, museCredentialFingerprint } from "../../open-sse/utils/museSubscriptionUsage.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import muse from "../../open-sse/providers/registry/muse.js";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const NOW = 1791920000000;
const event = () => ({
  type: "response.subscription_usage",
  subscription: {
    tier: "27681393394859588",
    weekly: { resets_at: 1792368000, used_percent: 65 },
    window: { resets_at: 1791924691, used_percent: 95, window_duration_mins: 300 },
  },
});
const sse = (data = event()) => `event: response.subscription_usage\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
const encoder = new TextEncoder();
function bytes(text, size = 17) {
  const data = encoder.encode(text);
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < data.length; i += size) controller.enqueue(data.slice(i, i + size));
    controller.close();
  } });
}
function response(text = sse(), status = 200) {
  return new Response(bytes(text), { status, headers: { "Content-Type": "text/event-stream" } });
}
const connection = (snapshot = null, id = "account") => ({
  id, provider: "muse", accessToken: "LLM|synthetic", providerSpecificData: { museSubscriptionUsage: snapshot, museSubscriptionUsageCredential: museCredentialFingerprint("LLM|synthetic") },
});
let getMuseUsage;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  vi.resetModules();
  ({ getMuseUsage } = await import("../../open-sse/services/usage/muse.js"));
});
afterEach(() => vi.useRealTimers());

describe("Muse snapshot", () => {
  it("maps both windows, clamps percentages, rejects malformed fields", () => {
    const data = event();
    data.subscription.window.used_percent = 150;
    data.subscription.weekly.used_percent = -10;
    const snapshot = parseMuseSubscriptionUsage(data);
    expect(snapshot).toEqual({
      tier: "27681393394859588", window: { usedPercent: 100, resetsAt: 1791924691, durationMins: 300 },
      weekly: { usedPercent: 0, resetsAt: 1792368000 }, capturedAt: NOW,
    });
    expect(validateMuseSubscriptionSnapshot(snapshot)).toEqual(snapshot);
    for (const invalid of [null, "95", NaN, Infinity, {}, true]) {
      const malformed = event();
      malformed.subscription.window.used_percent = invalid;
      expect(parseMuseSubscriptionUsage(malformed)).toBeNull();
    }
    for (const invalid of [null, 0, -1, Infinity, "1791924691", 1e20]) {
      const malformed = event();
      malformed.subscription.weekly.resets_at = invalid;
      expect(parseMuseSubscriptionUsage(malformed)).toBeNull();
    }
    expect(parseMuseSubscriptionUsage({ ...event(), type: "other" })).toBeNull();
    expect(parseMuseSubscriptionUsage({ type: "response.subscription_usage" })).toBeNull();
    expect(parseMuseSubscriptionUsage({ ...event(), subscription: { ...event().subscription, tier: {} } })).toBeNull();
    const malformed = event();
    malformed.subscription.window.window_duration_mins = 0;
    expect(parseMuseSubscriptionUsage(malformed)).toBeNull();
  });

  it.each(["responses", "chat"])("captures %s trailer, preserves every client byte", async (format) => {
    const terminal = format === "responses"
      ? 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
      : 'data: {"choices":[{"delta":{"content":"é"},"finish_reason":"stop"}]}\n\n';
    const text = terminal + sse() + "data: [DONE]\n\n";
    const capture = vi.fn();
    const output = await new Response(captureMuseSubscriptionUsage(bytes(text, 1), "muse", capture)).arrayBuffer();
    expect(new Uint8Array(output)).toEqual(encoder.encode(text));
    expect(capture).toHaveBeenCalledExactlyOnceWith(parseMuseSubscriptionUsage(event()));
  });

  it("other providers are untouched, including no reader acquisition", () => {
    const stream = bytes(sse());
    expect(captureMuseSubscriptionUsage(stream, "codex", vi.fn())).toBe(stream);
    expect(stream.locked).toBe(false);
  });

  it("ignores malformed/oversized events; handles multiline JSON and missing final newline", async () => {
    const capture = vi.fn();
    const multiline = JSON.stringify(event(), null, 2).split("\n").map((line) => `data: ${line}`).join("\n");
    const text = `event: response.subscription_usage\ndata: invalid\n\n${sse({ ...event(), subscription: null })}` +
      `event: response.subscription_usage\ndata: ${"x".repeat(70000)}\n\n` +
      `event: response.subscription_usage\n${multiline}`;
    expect(await new Response(captureMuseSubscriptionUsage(bytes(text), "muse", capture)).text()).toBe(text);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("drains a delayed trailer after terminal cancellation, without client writes", async () => {
    let upstream;
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { upstream = controller; }, cancel });
    const capture = vi.fn();
    const reader = captureMuseSubscriptionUsage(body, "muse", capture).getReader();
    upstream.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed"}\n\n'));
    await reader.read();
    const cancelled = reader.cancel();
    upstream.enqueue(encoder.encode(sse()));
    await cancelled;
    expect(capture).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await reader.read()).done).toBe(true);
  });

  it("mid-stream cancellation immediately cancels upstream, no trailer drain", async () => {
    let upstream;
    const cancel = vi.fn();
    const capture = vi.fn();
    const reader = captureMuseSubscriptionUsage(new ReadableStream({ start(controller) { upstream = controller; }, cancel }), "muse", capture).getReader();
    upstream.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
    await reader.read();
    await reader.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });

  it("trailer drain stops within 2s and leaves no timer", async () => {
    vi.useFakeTimers();
    let upstream;
    const cancel = vi.fn();
    const reader = captureMuseSubscriptionUsage(new ReadableStream({ start(controller) { upstream = controller; }, cancel }), "muse", vi.fn()).getReader();
    upstream.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
    await reader.read();
    const cancelled = reader.cancel();
    await vi.advanceTimersByTimeAsync(2001);
    await cancelled;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("trailer drain stops at 16KB or DONE", async () => {
    for (const text of ["x".repeat(16384), "data: [DONE]\n\n"]) {
      let upstream;
      const cancel = vi.fn();
      const capture = vi.fn();
      const reader = captureMuseSubscriptionUsage(new ReadableStream({ start(controller) { upstream = controller; }, cancel }), "muse", capture).getReader();
      upstream.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
      await reader.read();
      const cancelled = reader.cancel();
      upstream.enqueue(encoder.encode(text));
      await cancelled;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(capture).not.toHaveBeenCalled();
    }
  });

  it.each([() => { throw Error("capture failed"); }, () => Promise.reject(Error("capture failed"))])("capture failures never break client bytes", async (capture) => {
    expect(await new Response(captureMuseSubscriptionUsage(bytes(sse()), "muse", capture)).text()).toBe(sse());
  });
});

describe("Muse usage service", () => {
  it("registry enables OAuth/API-key usage and fixes probe URL/model", () => {
    expect(muse.features).toEqual({ usage: true, usageApikey: true });
    expect(muse.transport.usage.url).toBe("https://api.meta.ai/v1/responses");
    expect(muse.transport.usage.probeModel).toBe("muse-spark-1.3-contributor");
  });

  it("fresh snapshot avoids fetching, shows age and normalized UI rows", async () => {
    const usage = await getMuseUsage(connection(parseMuseSubscriptionUsage(event(), NOW - 60000)));
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(usage.plan).toBe("Muse Code (tier 27681393394859588)");
    expect(usage.message).toContain("Snapshot 1 minute old");
    expect(usage.capturedAt).toBe(new Date(NOW - 60000).toISOString());
    expect(usage.quotas["Session (5h)"]).toEqual({ used: 95, total: 100, remainingPercentage: 5, resetAt: "2026-10-13T20:51:31.000Z", unlimited: false });
    expect(parseQuotaData("muse", usage)).toEqual([
      { name: "Session (5h)", used: 95, total: 100, remainingPercentage: 5, resetAt: "2026-10-13T20:51:31.000Z" },
      { name: "Weekly (7d)", used: 65, total: 100, remainingPercentage: 35, resetAt: "2026-10-19T00:00:00.000Z" },
    ]);
  });

  it("stale snapshot probes once, reads past response.completed, persists via callback", async () => {
    proxyAwareFetch.mockResolvedValue(response('event: response.completed\ndata: {"type":"response.completed"}\n\n' + sse() + "data: [DONE]\n\n"));
    const save = vi.fn();
    const conn = connection(parseMuseSubscriptionUsage(event(), NOW - 600001));
    const proxy = { connectionProxyEnabled: false };
    const usage = await getMuseUsage(conn, proxy, { onSnapshot: save });
    expect(save).toHaveBeenCalledExactlyOnceWith(parseMuseSubscriptionUsage(event()));
    expect(usage.capturedAt).toBe(new Date(NOW).toISOString());
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, options, proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://api.meta.ai/v1/responses");
    expect(options.redirect).toBe("error");
    expect(options.headers.Authorization).toBe("Bearer LLM|synthetic");
    expect(options.headers["x-api-version"]).toBe("1.0.0");
    expect(JSON.parse(options.body)).toEqual({ model: "muse-spark-1.3-contributor", input: "Reply OK.", stream: true });
    expect(proxyOptions).toBe(proxy);
    await getMuseUsage(conn); // cache wins over the old DB snapshot
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("single-flight per connection, independent across connections", async () => {
    let release;
    proxyAwareFetch.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = getMuseUsage(connection());
    const second = getMuseUsage(connection());
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    release(response());
    expect(await first).toEqual(await second);
    proxyAwareFetch.mockResolvedValue(response());
    await getMuseUsage(connection(null, "another"));
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("pay-as-you-go gets a message; repeated page polls do not spend again", async () => {
    proxyAwareFetch.mockResolvedValue(response('event: response.completed\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n'));
    const conn = { ...connection(), accessToken: null, apiKey: "synthetic-payg" };
    expect(await getMuseUsage(conn)).toEqual({ message: "No Muse Code subscription on this key (pay-as-you-go)." });
    await getMuseUsage(conn);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch.mock.calls[0][1].headers["x-api-version"]).toBeUndefined();
    vi.setSystemTime(NOW + 600001);
    proxyAwareFetch.mockResolvedValue(response('event: response.completed\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n'));
    await getMuseUsage(conn);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 500])("HTTP %s fails open, preserves stale bars, never echoes raw body", async (status) => {
    proxyAwareFetch.mockResolvedValue(response("synthetic-secret", status));
    const usage = await getMuseUsage(connection(parseMuseSubscriptionUsage(event(), NOW - 700000)));
    expect(usage.quotas["Weekly (7d)"].used).toBe(65);
    expect(usage.message).toContain(status === 401 ? "Reconnect" : `(${status})`);
    expect(usage.message).not.toContain("synthetic-secret");
    await getMuseUsage(connection());
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("network failure preserves stale snapshot; credential replacement invalidates cache", async () => {
    proxyAwareFetch.mockRejectedValue(Error("secret proxy password"));
    const conn = connection(parseMuseSubscriptionUsage(event(), NOW - 700000));
    const result = await getMuseUsage(conn);
    expect(result.quotas).toBeDefined();
    expect(result.message).not.toContain("secret proxy password");
    proxyAwareFetch.mockResolvedValue(response());
    await getMuseUsage({ ...conn, accessToken: "replacement-synthetic-key", providerSpecificData: {} });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("missing/malformed keys never fetch; malformed snapshots trigger a probe", async () => {
    expect((await getMuseUsage({ id: "missing" })).message).toContain("Reconnect");
    await getMuseUsage({ ...connection(), accessToken: "bad\nkey" });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    proxyAwareFetch.mockResolvedValue(response());
    await getMuseUsage(connection({ capturedAt: NOW }));
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("persistence failure returns quota plus warning", async () => {
    proxyAwareFetch.mockResolvedValue(response());
    const result = await getMuseUsage(connection(), null, { onSnapshot: () => Promise.reject(Error("DB error")) });
    expect(result.quotas).toBeDefined();
    expect(result.message).toContain("could not be saved");
  });

  it("replacement key cannot reuse a fresh stored snapshot", async () => {
    const conn = connection(parseMuseSubscriptionUsage(event()));
    proxyAwareFetch.mockResolvedValue(response());
    await getMuseUsage({ ...conn, accessToken: "replacement" });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'event: error\ndata: {"error":{"message":"synthetic"}}\n\n',
    'event: response.failed\ndata: {"type":"response.failed"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    'data: [DONE]\n\n',
  ])("failed/truncated streams are not mistaken for pay-as-you-go %#", async (text) => {
    proxyAwareFetch.mockResolvedValue(response(text));
    const usage = await getMuseUsage(connection(parseMuseSubscriptionUsage(event(), NOW - 700000)));
    expect(usage.message).toContain("Muse quota refresh failed");
    expect(usage.message).not.toContain("pay-as-you-go");
    expect(usage.quotas["Weekly (7d)"].used).toBe(65);
  });

  it("whole-stream timeout cancels a stuck reasoning stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    proxyAwareFetch.mockImplementation(async (_url, options) => new Response(new ReadableStream({
      start(controller) { options.signal.addEventListener("abort", () => controller.error(Error("aborted"))); },
    }), { headers: { "Content-Type": "text/event-stream" } }));
    const pending = getMuseUsage(connection());
    await vi.advanceTimersByTimeAsync(120001);
    expect((await pending).message).toContain("probe failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
