import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_STALL_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { TRANSIENT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import * as streamHandler from "../../open-sse/utils/streamHandler.js";
import * as transport from "../../open-sse/utils/proxyFetch.js";
import { checkFallbackError, isModelLockActive } from "../../open-sse/services/accountFallback.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { initState, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { markAccountUnavailable } from "../../src/sse/services/auth.js";

const db = vi.hoisted(() => ({ getProviderConnections: vi.fn(), updateProviderConnection: vi.fn() }));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({ pickProxyPoolId: vi.fn(), resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn().mockResolvedValue(), saveUsage: vi.fn(),
  saveRequestDetail: vi.fn().mockResolvedValue(),
}));
// Keep this offline Codex integration independent of unrelated provider executors.
vi.mock("../../open-sse/executors/index.js", async () => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
  return { getExecutor: () => new CodexExecutor() };
});
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn(),
  }),
}));

const encoder = new TextEncoder();
const args = { model: "gpt-6.1-sol", body: { input: "hello" }, stream: true, credentials: {} };
const cyberMessage = "This content was flagged for possible cybersecurity risk.";
function event(type, data = { type }) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
function sse(text) {
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}
function executorWith(text) {
  const executor = new CodexExecutor();
  executor.config = { ...executor.config, retry: { 503: { attempts: 2, delayMs: 0 } } };
  const execute = vi.spyOn(BaseExecutor.prototype, "execute").mockImplementation(async () => ({ response: sse(text) }));
  return { executor, execute };
}

beforeEach(() => {
  db.getProviderConnections.mockResolvedValue([{ id: "codex-a", provider: "codex", backoffLevel: 0 }]);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("Codex SSE errors before output", () => {
  it("retries unknown-code overloaded wording, then returns 503", async () => {
    const { executor, execute } = executorWith(event("error", { code: "unknown", message: "Our servers are currently overloaded. Please try again later." }));
    const { response } = await executor.execute(args);
    expect(response.status).toBe(503);
    expect(execute).toHaveBeenCalledTimes(3);
    expect((await response.json()).error.message).toContain("currently overloaded");
  });

  it.each([
    ["error", { message: cyberMessage }],
    ["response.failed", { response: { error: { code: "cyber_policy", message: "Refused" } } }],
    ["error", { error: { code: "content_policy", message: "Refused: rate limit capacity overloaded" } }],
  ])("fails over %s policy refusals without retry or cooldown", async (type, data) => {
    const { executor, execute } = executorWith(event(type, data));
    const { response } = await executor.execute(args);
    const message = (await response.json()).error.message;
    expect(response.status).toBe(400);
    expect(execute).toHaveBeenCalledOnce();
    expect(checkFallbackError(response.status, message, 0, "codex")).toEqual({ shouldFallback: true, cooldownMs: 0 });
    expect(checkFallbackError(400, "Codex content-policy refusal: Refused", 0, "openai").shouldFallback).toBe(false);

    expect(await markAccountUnavailable("codex-a", response.status, message, "cx", args.model)).toEqual({ shouldFallback: true, cooldownMs: 0 });
    const lock = db.updateProviderConnection.mock.calls[0][1];
    expect(isModelLockActive(lock, args.model)).toBe(false);
    expect(lock.backoffLevel).toBe(0);
  });

  it.each(["error", "response.failed"])("returns 502 for unknown %s", async type => {
    const { executor, execute } = executorWith(event(type, { error: { code: "unknown", message: "Unexpected failure" } }));
    const { response } = await executor.execute(args);
    expect(response.status).toBe(502);
    expect(execute).toHaveBeenCalledOnce();
    expect(checkFallbackError(502, (await response.json()).error.message).shouldFallback).toBe(true);
  });

  it("does not commit an empty output delta before an error", async () => {
    const { executor } = executorWith(event("response.output_text.delta", { type: "response.output_text.delta", delta: "" }) + event("error", { message: cyberMessage }));
    expect((await executor.execute(args)).response.status).toBe(400);
  });

  it("rotates capacity accounts without retry", async () => {
    const { executor, execute } = executorWith(event("error", { error: { code: "model_at_capacity", message: "Selected model is at capacity" } }));
    expect((await executor.execute(args)).response.status).toBe(503);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns 502 when the stream throws before output", async () => {
    const { executor, execute } = executorWith("");
    execute.mockImplementation(async () => ({ response: new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(event("response.created"))); },
      pull(controller) { controller.error(new Error("connection lost")); },
    }), { headers: { "Content-Type": "text/event-stream" } }) }));
    const { response } = await executor.execute(args);
    expect(response.status).toBe(502);
    const message = (await response.json()).error.message;
    expect(await markAccountUnavailable("codex-a", response.status, message, "codex", args.model))
      .toEqual({ shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS });
    expect(db.updateProviderConnection).toHaveBeenCalledWith("codex-a", expect.objectContaining({ testStatus: "unavailable", lastError: message }));
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["", event("response.created"), "data: [DONE]\n\n"])("returns 502 on incomplete stream %j", async text => {
    const { executor } = executorWith(text);
    expect((await executor.execute(args)).response.status).toBe(502);
  });

  it("detects split CRLF events by data type, not model-text substrings", async () => {
    const text = `data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "Unexpected failure" } } })}\r\n\r\n`;
    const response = new Response(new ReadableStream({ start(controller) {
      for (const char of text) controller.enqueue(encoder.encode(char));
      controller.close();
    } }));
    expect((await new CodexExecutor()._peekSseTransientError(response)).status).toBe(502);
  });

  it.each([
    event("response.output_text.delta", { type: "response.output_text.delta", delta: 'server_is_overloaded event: error "type":"response.failed"' }),
    event("response.output_item.done", { type: "response.output_item.done", item: { type: "function_call", arguments: "{}" } }),
    event("response.output_item.added", { type: "response.output_item.added", item: { type: "function_call", name: "Read" } }),
    event("response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", delta: "read" }),
    event("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "thinking" }),
    event("response.completed"),
    event("response.output_text.delta", { type: "response.output_text.delta", delta: "OK" }) + event("error", { message: cyberMessage }),
  ])("preserves output/completion and late errors verbatim %j", async text => {
    const { executor, execute } = executorWith(text);
    const { response } = await executor.execute(args);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("preserves compact JSON responses", async () => {
    const { executor, execute } = executorWith("");
    execute.mockResolvedValue({ response: new Response('{"output":[]}', { headers: { "Content-Type": "application/json" } }) });
    expect(await (await executor.execute(args)).response.text()).toBe('{"output":[]}');
  });

  it.each([
    event("error", { message: cyberMessage }),
    event("response.failed", { response: { error: { message: "Unexpected failure" } } }),
  ])("tries combo entry 2 after entry 1 SSE failure %j", async text => {
    const { executor } = executorWith(text);
    const handleSingleModel = vi.fn(async (_body, model) => model.startsWith("cx/")
      ? (await executor.execute(args)).response : new Response("fallback"));
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["cx/gpt-6.1-sol", "openai/gpt-4o-mini"], handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() }, comboStrategy: "fallback",
    });
    expect(await response.text()).toBe("fallback");
    expect(handleSingleModel.mock.calls.map(call => call[1])).toEqual(["cx/gpt-6.1-sol", "openai/gpt-4o-mini"]);
  });
});

describe("Codex pre-output deadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function pendingStream() {
    const cancel = vi.fn();
    let controller;
    const response = new Response(new ReadableStream({
      start(value) { controller = value; }, cancel,
    }), { headers: { "Content-Type": "text/event-stream" } });
    return { response, cancel, send: text => controller.enqueue(encoder.encode(text)) };
  }

  it.each([
    ["codex", 300000], ["fallback", 200000], ["override", 75],
  ])("bounds headers with no body using %s budget", async (mode, budget) => {
    const { executor, execute } = executorWith("");
    expect(STREAM_FIRST_CHUNK_TIMEOUT_MS).toBe(200000);
    expect(executor.config.firstChunkTimeoutMs).toBe(300000);
    expect(executor.config.firstChunkTimeoutMs).toBe(PROVIDERS.codex.firstChunkTimeoutMs);
    if (mode !== "codex") executor.config = { ...executor.config, firstChunkTimeoutMs: mode === "fallback" ? undefined : budget };
    const upstream = pendingStream();
    execute.mockResolvedValue({ response: upstream.response });
    const outcome = executor.execute(args).catch(error => error);
    await vi.advanceTimersByTimeAsync(budget - 1);
    expect(upstream.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ message: "time-to-first-token timeout" });
    expect((await outcome).name).not.toBe("AbortError");
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].signal.aborted).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails over immediately on the real chatCore timeout without persisting account state", async () => {
    const { execute } = executorWith("");
    const upstream = pendingStream();
    execute.mockResolvedValue({ response: upstream.response });
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    let failure;
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (!model.startsWith("cx/")) return new Response("fallback");
      failure = await handleChatCore({
        body: { model: `codex/${args.model}`, input: "hello", stream: true },
        modelInfo: { provider: "codex", model: args.model },
        credentials: {}, sourceFormatOverride: FORMATS.OPENAI_RESPONSES, log,
      });
      await markAccountUnavailable("codex-a", failure.status, failure.error, "cx", args.model);
      return failure.response;
    });
    const startedAt = Date.now();
    const outcome = handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["cx/gpt-6.1-sol", "openai/gpt-4o-mini"], handleSingleModel, log, comboStrategy: "fallback",
    });
    await vi.advanceTimersByTimeAsync(299999);
    expect(handleSingleModel).toHaveBeenCalledOnce();
    expect(upstream.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await outcome).text()).toBe("fallback");
    expect(failure).toMatchObject({ success: false, status: 502, error: "[502]: time-to-first-token timeout" });
    expect(checkFallbackError(failure.status, failure.error, 0, "codex"))
      .toEqual({ shouldFallback: false, cooldownMs: 0, requestScoped: true });
    expect(Date.now() - startedAt).toBe(300000);
    expect(handleSingleModel.mock.calls.map(call => call[1])).toEqual(["cx/gpt-6.1-sol", "openai/gpt-4o-mini"]);
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["Unexpected upstream failure", "connection lost"])("retains the account cooldown for ordinary 502: %s", async message => {
    expect(checkFallbackError(502, message, 2, "codex")).toEqual({ shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS });
    db.getProviderConnections.mockResolvedValue([{ id: "codex-a", backoffLevel: 2 }]);
    expect(await markAccountUnavailable("codex-a", 502, message, "codex", args.model))
      .toEqual({ shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS });
    expect(db.updateProviderConnection).toHaveBeenCalledWith("codex-a", expect.objectContaining({
      [`modelLock_${args.model}`]: new Date(Date.now() + TRANSIENT_COOLDOWN_MS).toISOString(),
      testStatus: "unavailable", lastError: message, errorCode: 502, backoffLevel: 2,
    }));
  });

  it.each([["codex", 300000], ["openai", 200000]])("passes the %s budget to generic streaming without changing the stall budget", async (provider, budget) => {
    const pipe = vi.spyOn(streamHandler, "pipeWithDisconnect").mockReturnValue(new ReadableStream({ start(controller) { controller.close(); } }));
    const providerResponse = sse("");
    const streamController = {};
    const result = await handleStreamingResponse({
      providerResponse, provider, model: args.model, sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES, body: {}, stream: true, requestStartTime: Date.now(), streamController,
    });
    expect(result.success).toBe(true);
    expect(pipe).toHaveBeenCalledWith(providerResponse, expect.any(TransformStream), streamController,
      expect.any(Function), STREAM_STALL_TIMEOUT_MS, budget);
    await result.response.body.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not renew the budget for metadata or heartbeats", async () => {
    const { executor, execute } = executorWith("");
    executor.config = { ...executor.config, firstChunkTimeoutMs: 100 };
    const upstream = pendingStream();
    execute.mockResolvedValue({ response: upstream.response });
    const outcome = executor.execute(args).catch(error => error);
    await vi.advanceTimersByTimeAsync(40);
    upstream.send(event("response.created"));
    await vi.advanceTimersByTimeAsync(40);
    upstream.send(": heartbeat\n\n");
    await vi.advanceTimersByTimeAsync(20);
    expect(await outcome).toMatchObject({ message: "time-to-first-token timeout" });
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("preserves caller abort while reading without retry", async () => {
    const { executor, execute } = executorWith("");
    const upstream = pendingStream();
    const caller = new AbortController();
    const reason = new DOMException("caller canceled", "AbortError");
    execute.mockResolvedValue({ response: upstream.response });
    const outcome = executor.execute({ ...args, signal: caller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["caller", "deadline"])("interrupts retry delay on %s without another request", async termination => {
    const { executor, execute } = executorWith(event("error", { message: "server overloaded" }));
    executor.config = { ...executor.config, firstChunkTimeoutMs: 100, retry: { 503: { attempts: 2, delayMs: 1000 } } };
    const caller = new AbortController();
    const outcome = executor.execute({ ...args, signal: caller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(10);
    if (termination === "caller") caller.abort();
    else await vi.advanceTimersByTimeAsync(90);
    expect(await outcome).toMatchObject(termination === "caller" ? { name: "AbortError" } : { message: "time-to-first-token timeout" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(execute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands off at the existing byte cap without a late peek timeout", async () => {
    const { executor, execute } = executorWith("");
    executor.config = { ...executor.config, firstChunkTimeoutMs: 100 };
    const upstream = pendingStream();
    execute.mockResolvedValue({ response: upstream.response });
    const pending = executor.execute(args);
    await vi.advanceTimersByTimeAsync(10);
    const metadata = `: ${"x".repeat(256 * 1024)}\n\n`;
    upstream.send(metadata);
    const { response } = await pending;
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(metadata);
    await vi.advanceTimersByTimeAsync(200);
    expect(execute.mock.calls[0][0].signal.aborted).toBe(false);
    upstream.send("tail");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("tail");
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears deadline after replay success, retaining caller signal", async () => {
    const text = event("response.created") + event("response.output_text.delta", { type: "response.output_text.delta", delta: "OK" });
    const { executor, execute } = executorWith("");
    executor.config = { ...executor.config, firstChunkTimeoutMs: 100 };
    const upstream = pendingStream();
    execute.mockResolvedValue({ response: upstream.response });
    const caller = new AbortController();
    const pending = executor.execute({ ...args, signal: caller.signal });
    await vi.advanceTimersByTimeAsync(10);
    upstream.send(text);
    const { response } = await pending;
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(text);
    await vi.advanceTimersByTimeAsync(200);
    expect(execute.mock.calls[0][0].signal.aborted).toBe(false);
    upstream.send("tail");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("tail");
    caller.abort();
    expect(execute.mock.calls[0][0].signal.aborted).toBe(true);
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("BaseExecutor retry cancellation", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup() {
    const fetch = vi.spyOn(transport, "proxyAwareFetch").mockImplementation(async () => new Response("unavailable", { status: 503 }));
    const executor = new BaseExecutor("test", { baseUrl: "https://unused.invalid", retry: { 503: { attempts: 1, delayMs: 1000 } } });
    return { fetch, executor };
  }

  it("rejects pre-aborted input without upstream attempts", async () => {
    const { fetch, executor } = setup();
    const caller = new AbortController();
    caller.abort();
    await expect(executor.execute({ ...args, signal: caller.signal })).rejects.toBe(caller.signal.reason);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels retry wait and leaves no listener or subsequent attempt", async () => {
    const { fetch, executor } = setup();
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, "addEventListener");
    const outcome = executor.execute({ ...args, signal: caller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(10);
    caller.abort();
    expect(await outcome).toBe(caller.signal.reason);
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("keeps ordinary retry success with signal=%s", async withSignal => {
    const { fetch, executor } = setup();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    fetch.mockImplementationOnce(async () => new Response("unavailable", { status: 503 }))
      .mockImplementationOnce(async () => new Response("ok"));
    const outcome = executor.execute({ ...args, signal: withSignal ? caller.signal : undefined });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await (await outcome).response.text()).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    if (withSignal) expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops BaseExecutor retry when the Codex deadline expires", async () => {
    const { fetch } = setup();
    const executor = new CodexExecutor();
    executor.config = { ...executor.config, firstChunkTimeoutMs: 100, retry: { 503: { attempts: 2, delayMs: 1000 } } };
    const outcome = executor.execute(args).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ message: "time-to-first-token timeout" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Responses translator late errors", () => {
  it.each([FORMATS.OPENAI, FORMATS.CLAUDE])("emits real errors, not successful finishes, for %s", async format => {
    const state = initState(format);
    translateResponse(FORMATS.OPENAI_RESPONSES, format, { type: "response.output_text.delta", delta: "partial" }, state);
    const error = { type: "server_error", message: "late failure" };
    const chunks = translateResponse(FORMATS.OPENAI_RESPONSES, format, { type: "response.failed", response: { error } }, state);
    expect([...chunks]).toEqual([format === FORMATS.CLAUDE ? { type: "error", error } : { error }]);
    expect(translateResponse(FORMATS.OPENAI_RESPONSES, format, { type: "error", error }, state)).toEqual([]);
    expect(translateResponse(FORMATS.OPENAI_RESPONSES, format, null, state)).toEqual([]);

    // Event-only errors also survive the stream parser and Claude pivot.
    const text = event("response.output_text.delta", { type: "response.output_text.delta", delta: "partial" }) + event("error", { code: "unknown", message: "late failure" });
    for (const wireText of [text, text.trimEnd()]) {
      const output = await new Response(sse(wireText).body.pipeThrough(createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, format))).text();
      expect(output).toContain('"error":');
      expect(output).toContain("late failure");
      expect(output).not.toContain("[Error]");
      expect(output).not.toContain('"finish_reason":"stop"');
      expect(output).not.toContain("event: message_stop");
      if (format === FORMATS.CLAUDE) expect(output).toContain("event: error\n");
    }
  });
});
