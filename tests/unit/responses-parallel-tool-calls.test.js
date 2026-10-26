// Parallel function_calls from a Responses upstream must stay on separate
// chat tool_calls indices. Regression: response/openai-responses.js attributed
// every arguments delta to the positional toolCallIndex (advanced only on
// output_item.done), so all-added-then-deltas ordering concatenated N JSON
// payloads into index 0 and clients failed with InputValidationError.
import { describe, expect, it, vi } from "vitest";
// Stream integration must never touch local usage files or the DB.
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: async () => {} }));
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import "../translator/registerAll.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { clampResponsesCallId, coerceResponsesOutput, MAX_RESPONSES_CALL_ID_LEN } from "../../open-sse/translator/formats/responsesApi.js";
import { initState, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const added = (id, call_id, name, type = "function_call") => ({
  type: "response.output_item.added",
  item: { id, type, call_id, name, arguments: "" },
});
const delta = (item_id, text) => ({
  type: "response.function_call_arguments.delta",
  item_id,
  delta: text,
});
const done = (id, call_id, name) => ({
  type: "response.output_item.done",
  item: { id, type: "function_call", call_id, name },
});

// Reassemble translated chunks the way an OpenAI client accumulator does.
function accumulate(calls, chunks) {
  for (const chunk of chunks) {
    if (!chunk) continue;
    for (const tc of chunk.choices?.[0]?.delta?.tool_calls || []) {
      const slot = (calls[tc.index] ??= { id: null, name: "", args: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
  }
  return calls;
}

function runStream(events) {
  const state = {};
  const chunks = [];
  for (const ev of events) {
    const out = openaiResponsesToOpenAIResponse(ev, state);
    if (out) chunks.push(out);
  }
  const flush = openaiResponsesToOpenAIResponse(null, state);
  if (flush) chunks.push(flush);
  return { state, chunks };
}

const PAYLOADS = [
  '{"file_path":"/docs/PRODUCT.md"}',
  '{"file_path":"/docs/ROADMAP.md"}',
  '{"file_path":"/docs/openapi.custom.yaml"}',
  '{"file_path":"/docs/.gitignore"}',
];

function hostileOrdering() {
  const events = PAYLOADS.map((_, i) => added(`fc_${i}`, `call_${i}`, "read_file"));
  // Interleaved deltas AFTER all addeds — the ordering that used to merge all
  // four payloads into index 0.
  PAYLOADS.forEach((p, i) => events.push(delta(`fc_${i}`, p.slice(0, 20)), delta(`fc_${i}`, p.slice(20))));
  PAYLOADS.forEach((_, i) => events.push(done(`fc_${i}`, `call_${i}`, "read_file")));
  return events;
}

describe("responses parallel tool calls keep their own index", () => {
  it("all-added-then-deltas ordering yields 4 separately parseable calls", () => {
    const { chunks } = runStream(hostileOrdering());
    const calls = accumulate({}, chunks);
    expect(Object.keys(calls)).toHaveLength(4);
    PAYLOADS.forEach((p, i) => {
      expect(calls[i].id).toBe(`call_${i}`);
      expect(calls[i].name).toBe("read_file");
      expect(JSON.parse(calls[i].args)).toEqual(JSON.parse(p));
    });
  });

  it("sequential ordering still yields indices 0,1 in order", () => {
    const events = [
      added("fc_0", "call_0", "read_file"),
      delta("fc_0", PAYLOADS[0]),
      done("fc_0", "call_0", "read_file"),
      added("fc_1", "call_1", "read_file"),
      delta("fc_1", PAYLOADS[1]),
      done("fc_1", "call_1", "read_file"),
    ];
    const { chunks } = runStream(events);
    const calls = accumulate({}, chunks);
    expect(Object.keys(calls)).toEqual(["0", "1"]);
    expect(JSON.parse(calls[0].args)).toEqual(JSON.parse(PAYLOADS[0]));
    expect(JSON.parse(calls[1].args)).toEqual(JSON.parse(PAYLOADS[1]));
  });

  it("done carrying full arguments (no deltas) emits them once", () => {
    const state = {};
    const out1 = openaiResponsesToOpenAIResponse(added("fc_9", "call_9", "read_file"), state);
    const out2 = openaiResponsesToOpenAIResponse({
      type: "response.output_item.done",
      item: { id: "fc_9", type: "function_call", call_id: "call_9", name: "read_file", arguments: PAYLOADS[0] },
    }, state);
    const calls = accumulate({}, [out1, out2]);
    expect(JSON.parse(calls[0].args)).toEqual(JSON.parse(PAYLOADS[0]));
  });

  it("identity-free deltas retain single-call legacy compatibility", () => {
    const events = [
      added("fc_0", "call_0", "read_file"),
      { type: "response.function_call_arguments.delta", delta: PAYLOADS[0] },
      done("fc_0", "call_0", "read_file"),
    ];
    const { chunks } = runStream(events);
    const calls = accumulate({}, chunks);
    expect(JSON.parse(calls[0].args)).toEqual(JSON.parse(PAYLOADS[0]));
  });
});

const indexedAdded = (i, type = "function_call") => ({ ...added(`fc_${i}`, `call_${i}`, "tool", type), output_index: i + 2 });
const canonicalDone = (i, args, type = "function_call") => ({
  type: "response.output_item.done", output_index: i + 2,
  item: { id: `fc_${i}`, call_id: `call_${i}`, type, ...(type === "custom_tool_call" ? { input: args } : { arguments: args }) },
});

describe("Responses tool correlation fails closed", () => {
  it("routes missing item_id by output_index, not the latest added", () => {
    const { chunks } = runStream([
      indexedAdded(0), indexedAdded(1),
      { ...delta(undefined, PAYLOADS[0]), output_index: 2 },
      { ...delta(undefined, PAYLOADS[1]), output_index: 3 },
      canonicalDone(0, PAYLOADS[0]), canonicalDone(1, PAYLOADS[1]),
    ]);
    expect(Object.values(accumulate({}, chunks)).map(c => c.args)).toEqual(PAYLOADS.slice(0, 2));
    expect(chunks.some(c => c.error)).toBe(false);
  });

  it.each([
    ["unknown item even with a known index", { ...delta("unknown", "secret-arguments"), output_index: 2 }],
    ["conflicting known item and index", { ...delta("fc_0", "secret-arguments"), output_index: 3 }],
    ["known item and unmapped index", { ...delta("fc_0", "secret-arguments"), output_index: 9 }],
    ["unknown item without index", delta("unknown", "secret-arguments")],
    ["missing ambiguous identity", delta(undefined, "secret-arguments")],
  ])("rejects %s, suppresses later completion", (_, fragment) => {
    const { state, chunks } = runStream([
      indexedAdded(0), indexedAdded(1), fragment,
      delta("fc_0", PAYLOADS[0]), canonicalDone(0, PAYLOADS[0]),
      { type: "response.completed" },
    ]);
    expect(chunks.filter(c => c.error)).toHaveLength(1);
    expect(JSON.stringify(state.error)).not.toContain("secret-arguments");
    expect(state.respToolCorrelationMismatchCount).toBe(1);
    expect(chunks.some(c => c.choices?.[0]?.finish_reason)).toBe(false);
    expect(Object.values(accumulate({}, chunks)).every(c => !c.args)).toBe(true);
  });

  it("duplicate added does not replay identity/name or allocate a new block", () => {
    const { chunks } = runStream([indexedAdded(0), indexedAdded(0), delta("fc_0", PAYLOADS[0]), canonicalDone(0, PAYLOADS[0])]);
    expect(chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls || []).filter(c => c.id)).toHaveLength(1);
    expect(accumulate({}, chunks)[0].args).toBe(PAYLOADS[0]);
  });

  it.each([PAYLOADS[0], PAYLOADS[0].slice(0, 12)])("canonical done completes prefix without replay: %s", prefix => {
    const { chunks } = runStream([
      indexedAdded(0), delta("fc_0", prefix),
      { type: "response.function_call_arguments.done", item_id: "fc_0", output_index: 2, arguments: PAYLOADS[0] },
      canonicalDone(0, PAYLOADS[0]), canonicalDone(0, PAYLOADS[0]),
    ]);
    expect(accumulate({}, chunks)[0].args).toBe(PAYLOADS[0]);
    expect(chunks.some(c => c.error)).toBe(false);
  });

  it("rejects canonical done inconsistent with streamed arguments", () => {
    const { chunks } = runStream([indexedAdded(0), delta("fc_0", PAYLOADS[0]), canonicalDone(0, PAYLOADS[1])]);
    expect(chunks.filter(c => c.error)).toHaveLength(1);
    expect(chunks.some(c => c.choices?.[0]?.finish_reason)).toBe(false);
  });

  it("rejects a late delta after done rather than replaying bytes", () => {
    const { chunks } = runStream([indexedAdded(0), canonicalDone(0, PAYLOADS[0]), delta("fc_0", PAYLOADS[0])]);
    expect(accumulate({}, chunks)[0].args).toBe(PAYLOADS[0]);
    expect(chunks.filter(c => c.error)).toHaveLength(1);
  });

  it.each([false, true])("custom input stays separate, wrapped once; deltas=%s", useDeltas => {
    const events = [indexedAdded(0, "custom_tool_call"), indexedAdded(1, "custom_tool_call")];
    const inputs = ["first program", "second program"];
    if (useDeltas) inputs.forEach((input, i) => events.push({ type: "response.custom_tool_call_input.delta", output_index: i + 2, delta: input }));
    inputs.forEach((input, i) => {
      events.push({ type: "response.custom_tool_call_input.done", item_id: `fc_${i}`, input });
      events.push(canonicalDone(i, input, "custom_tool_call"));
    });
    const { chunks } = runStream(events);
    expect(Object.values(accumulate({}, chunks)).map(c => JSON.parse(c.args))).toEqual(inputs.map(input => ({ input })));
    expect(chunks.some(c => c.error)).toBe(false);
  });

  it.each([null, { type: "response.completed" }, { type: "response.done" }])("pending custom input rejects terminal %j", terminal => {
    const { chunks } = runStream([indexedAdded(0, "custom_tool_call"),
      { type: "response.custom_tool_call_input.delta", item_id: "fc_0", delta: "program" }, terminal]);
    expect(chunks.filter(c => c.error)).toHaveLength(1);
    expect(chunks.some(c => c.choices?.[0]?.finish_reason)).toBe(false);
    expect(accumulate({}, chunks)[0].args).toBe("");
  });

  it.each(["error", "response.failed"])("custom upstream %s stays the only terminal error", type => {
    const error = { type: "server_error", message: "Upstream failure" };
    const { chunks } = runStream([indexedAdded(0, "custom_tool_call"),
      { type: "response.custom_tool_call_input.delta", item_id: "fc_0", delta: "program" },
      { type, error }, { type: "response.completed" }, null]);
    expect(chunks.filter(c => c.error)).toEqual([{ error }]);
    expect(chunks.some(c => c.choices?.[0]?.finish_reason)).toBe(false);
  });

  it("canonical empty custom input emits its valid wrapper", () => {
    const { chunks } = runStream([indexedAdded(0, "custom_tool_call"), canonicalDone(0, "", "custom_tool_call")]);
    expect(JSON.parse(accumulate({}, chunks)[0].args)).toEqual({ input: "" });
    expect(chunks.some(c => c.error)).toBe(false);
  });

  it.each(["response.function_call_arguments.delta", "response.custom_tool_call_input.delta"])("rejects nonstring delta for %s", type => {
    const { state, chunks } = runStream([indexedAdded(0, type.includes("custom") ? "custom_tool_call" : "function_call"),
      { type, item_id: "fc_0", delta: { secret: "never expose" } }]);
    expect(chunks.filter(c => c.error)).toHaveLength(1);
    expect(JSON.stringify(state.error)).not.toContain("never expose");
    expect(chunks.some(c => c.choices?.[0]?.finish_reason)).toBe(false);
  });

  it.each([null, {}, 42])("rejects nonstring canonical done arguments %j", value => {
    for (const type of ["function_call", "custom_tool_call"]) {
      const event = canonicalDone(0, value, type);
      const { chunks } = runStream([indexedAdded(0, type), event]);
      expect(chunks.filter(c => c.error)).toHaveLength(1);
      expect(accumulate({}, chunks)[0].args).toBe("");
      expect(chunks.some(c => c.choices?.[0]?.finish_reason)).toBe(false);
    }
  });

  it("custom done without input or buffered deltas cannot invent empty input", () => {
    const event = canonicalDone(0, undefined, "custom_tool_call");
    delete event.item.input;
    const { chunks } = runStream([indexedAdded(0, "custom_tool_call"), event]);
    expect(chunks.filter(c => c.error)).toHaveLength(1);
    expect(accumulate({}, chunks)[0].args).toBe("");
  });

  it("custom fragments also reject conflicting correlation", () => {
    const { chunks } = runStream([indexedAdded(0, "custom_tool_call"), indexedAdded(1, "custom_tool_call"),
      { type: "response.custom_tool_call_input.delta", item_id: "fc_0", output_index: 3, delta: "program" }]);
    expect(chunks.filter(c => c.error)).toHaveLength(1);
  });
});

describe("responses → claude end-to-end keeps parallel tool_use blocks separate", () => {
  it("correlation failure reaches Claude as error, never completes buffered tools", () => {
    const state = initState(FORMATS.CLAUDE);
    const events = [indexedAdded(0), indexedAdded(1), delta("fc_0", PAYLOADS[0]),
      { ...delta("fc_0", PAYLOADS[1]), output_index: 3 },
      canonicalDone(0, PAYLOADS[0]), { type: "response.completed" }, null];
    const out = events.flatMap(ev => translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, ev, state));
    expect(out.filter(r => r.type === "error")).toEqual([{ type: "error", error: state.error }]);
    expect(out.some(r => r.type === "message_stop" || r.type === "content_block_stop" || r.delta?.type === "input_json_delta")).toBe(false);
  });

  it("SSE pipeline emits event:error without closing or completing tools", async () => {
    const events = [indexedAdded(0), indexedAdded(1), delta("fc_0", PAYLOADS[0]),
      { ...delta("fc_0", PAYLOADS[1]), output_index: 3 },
      canonicalDone(0, PAYLOADS[0]), { type: "response.completed" }];
    const input = new ReadableStream({ start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    } });
    const stream = input.pipeThrough(createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE));
    const wire = await new Response(stream).text();
    expect(wire.match(/event: error/g)).toHaveLength(1);
    expect(wire).toContain('"code":"tool_call_correlation_error"');
    expect(wire).not.toMatch(/input_json_delta|content_block_stop|message_stop|tool_use".*stop_reason/);
  });

  it("four read_file calls arrive as four parseable tool_use blocks", () => {
    const state = initState(FORMATS.CLAUDE);
    const out = [];
    for (const ev of hostileOrdering()) {
      for (const r of translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, ev, state)) out.push(r);
    }
    for (const r of translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, null, state)) out.push(r);

    const starts = out.filter((r) => r?.type === "content_block_start" && r?.content_block?.type === "tool_use");
    expect(starts).toHaveLength(4);
    const partials = out.filter((r) => r?.delta?.type === "input_json_delta");
    expect(partials).toHaveLength(4);
    const bodies = partials.map((r) => JSON.parse(r.delta.partial_json).file_path).sort();
    expect(bodies).toEqual([
      "/docs/.gitignore",
      "/docs/PRODUCT.md",
      "/docs/ROADMAP.md",
      "/docs/openapi.custom.yaml",
    ]);
  });
});

describe("fallback call_ids stay unique within a batch", () => {
  it("same-millisecond fallbacks never collide", () => {
    const ids = new Set(Array.from({ length: 50 }, () => clampResponsesCallId(undefined)));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id.startsWith("call_")).toBe(true);
      expect(id.length).toBeLessThanOrEqual(MAX_RESPONSES_CALL_ID_LEN);
    }
    expect(new Set([clampResponsesCallId(""), clampResponsesCallId(null)]).size).toBe(2);
  });
});

describe("output coercion stays fail-soft on unstringifiable values", () => {
  it("never throws on BigInt/circular array elements", () => {
    const circular = {};
    circular.self = circular;
    const input = [1n, circular, { text: "ok" }];
    expect(() => coerceResponsesOutput(input)).not.toThrow();
    const out = coerceResponsesOutput(input);
    expect(typeof out).toBe("string");
    expect(out).toContain("ok");
  });
});
