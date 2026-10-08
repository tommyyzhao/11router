import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
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
    expect((await executor.execute(args)).response.status).toBe(502);
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
