import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), completion: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute: mocks.execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {}, logError() {} }) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: async () => {}, saveRequestDetail: async () => {}, saveRequestUsage: async () => {} }));
// Keep bytes unchanged here; exercise the real chatCore/streamingHandler callback plumbing.
vi.mock("../../open-sse/utils/stream.js", () => ({
  createPassthroughStreamWithLogger: () => new TransformStream(),
  createSSETransformStreamWithLogger: () => new TransformStream(),
}));
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
const data = { type: "response.subscription_usage", subscription: { tier: "1", window: { used_percent: 95, resets_at: 1791924691, window_duration_mins: 300 }, weekly: { used_percent: 65, resets_at: 1792368000 } } };
const trailer = `event: response.subscription_usage\ndata: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`;

it.each(["openai", "openai-responses"])("chatCore captures %s upstream trailer without altering the stream", async (format) => {
  const text = format === "openai"
    ? 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n' + trailer
    : 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n' + trailer;
  mocks.execute.mockResolvedValue({ response: new Response(text, { headers: { "content-type": "text/event-stream" } }), url: "https://api.meta.ai/v1/responses", headers: {}, transformedBody: null });
  const capture = vi.fn();
  const body = format === "openai" ? { messages: [{ role: "user", content: "hi" }], stream: true } : { input: "hi", stream: true };
  const result = await handleChatCore({
    body, modelInfo: { provider: "muse", model: "muse-spark-1.3-contributor" },
    credentials: { accessToken: "synthetic" }, connectionId: "account", sourceFormatOverride: format,
    onSubscriptionUsage: capture, log: { debug() {}, info() {}, warn() {} },
  });
  expect(result.success).toBe(true);
  expect(await result.response.text()).toBe(text);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture.mock.calls[0][0].window.usedPercent).toBe(95);
});

it("Responses client cancellation retains only a bounded terminal trailer drain", async () => {
  vi.useFakeTimers();
  let upstream;
  const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { upstream = controller; }, cancel });
  mocks.execute.mockResolvedValue({ response: new Response(body, { headers: { "content-type": "text/event-stream" } }), url: "https://api.meta.ai/v1/responses", headers: {} });
  const capture = vi.fn();
  const result = await handleChatCore({ body: { input: "hi", stream: true }, modelInfo: { provider: "muse", model: "muse-spark-1.3-contributor" }, credentials: { accessToken: "synthetic" }, sourceFormatOverride: "openai-responses", onSubscriptionUsage: capture });
  const reader = result.response.body.getReader();
  upstream.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));
  await reader.read();
  await reader.cancel();
  await vi.advanceTimersByTimeAsync(600); // ordinary disconnect would already abort
  upstream.enqueue(new TextEncoder().encode(trailer));
  await vi.advanceTimersByTimeAsync(0);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
