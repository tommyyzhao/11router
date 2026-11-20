/**
 * Mistral content-block thinking — mistral-large-4 streams/returns thinking inside
 * delta.content as proprietary content-block arrays:
 *   [{ type: "thinking", thinking: [{ type: "text", text }], closed }, { type: "text", text }]
 * liftThinkingBlocks() turns those into reasoning_content + string content.
 * Run: cd tests && npx vitest run unit/mistral-thinking-blocks.test.js
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { liftThinkingBlocks, extractReasoningText } from "../../open-sse/translator/concerns/reasoning.js";

const MISTRAL_DELTA = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: [{ type: "text", text: "Step one." }], closed: true },
    { type: "text", text: "OK" },
  ],
};

describe("liftThinkingBlocks", () => {
  it("lifts mistral thinking/text blocks into canonical lanes", () => {
    const lifted = liftThinkingBlocks(MISTRAL_DELTA);
    expect(typeof lifted.content).toBe("string");
    expect(lifted.content).toBe("OK");
    expect(lifted.reasoning_content).toBe("Step one.");
    expect(lifted.role).toBe("assistant");
  });

  it("handles a thinking-only delta", () => {
    const lifted = liftThinkingBlocks({
      content: [{ type: "thinking", thinking: [{ type: "text", text: "Hmm." }], closed: true }],
    });
    expect(lifted.content).toBe("");
    expect(lifted.reasoning_content).toBe("Hmm.");
  });

  it("concatenates multiple thinking segments and text parts", () => {
    const lifted = liftThinkingBlocks({
      content: [
        { type: "thinking", thinking: [{ type: "text", text: "a" }, { type: "text", text: "b" }], closed: true },
        { type: "thinking", thinking: [{ type: "text", text: "c" }], closed: true },
        { type: "text", text: "x" },
        { type: "text", text: "y" },
      ],
    });
    expect(lifted.reasoning_content).toBe("abc");
    expect(lifted.content).toBe("xy");
  });

  it("appends to an existing reasoning_content lane", () => {
    const lifted = liftThinkingBlocks({
      reasoning_content: "pre-",
      content: [{ type: "thinking", thinking: [{ type: "text", text: "post" }], closed: true }],
    });
    expect(lifted.reasoning_content).toBe("pre-post");
  });

  it("leaves plain text-part arrays untouched (no thinking part)", () => {
    const delta = { content: [{ type: "text", text: "hi" }] };
    expect(liftThinkingBlocks(delta)).toBe(delta);
  });

  it("leaves unknown part types untouched", () => {
    const delta = {
      content: [
        { type: "thinking", thinking: [{ type: "text", text: "x" }], closed: true },
        { type: "image_url", image_url: { url: "data:..." } },
      ],
    };
    expect(liftThinkingBlocks(delta)).toBe(delta);
  });

  it("returns non-array content untouched", () => {
    const delta = { content: "plain string" };
    expect(liftThinkingBlocks(delta)).toBe(delta);
    const delta2 = { };
    expect(liftThinkingBlocks(delta2)).toBe(delta2);
    expect(liftThinkingBlocks(null)).toBe(null);
  });

  it("streams through extractReasoningText after the lift", () => {
    const lifted = liftThinkingBlocks(MISTRAL_DELTA);
    expect(extractReasoningText(lifted)).toBe("Step one.");
  });
});

describe("SSE→JSON aggregation of a mistral-large-4 stream", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("aggregates thinking + text from content-block deltas", async () => {
    // parseSSEToOpenAIResponse lives in sseToJsonHandler which imports the
    // usage DB module — stub its writers so no SQLite path is touched.
    vi.doMock("../../src/lib/usageDb.js", () => ({
      saveRequestDetail: vi.fn(),
      appendRequestLog: vi.fn(async () => {}),
    }));
    const { parseSSEToOpenAIResponse } = await import(
      "../../open-sse/handlers/chatCore/sseToJsonHandler.js"
    );
    const rawSSE = [
      'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
      'data: {"id":"x","choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"Think "}],"closed":true}]}}]}',
      'data: {"id":"x","choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"hard."}],"closed":true}]}}]}',
      'data: {"id":"x","choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"done."}],"closed":true},{"type":"text","text":"OK"}]},"finish_reason":null}]}',
      'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":9,"total_tokens":19}}',
      "data: [DONE]",
    ].join("\n");
    const parsed = parseSSEToOpenAIResponse(rawSSE, "mistral-large-4");
    expect(parsed).toBeTruthy();
    expect(parsed.choices[0].message.reasoning_content).toBe("Think hard.done.");
    expect(parsed.choices[0].message.content).toBe("OK");
    expect(parsed.choices[0].finish_reason).toBe("stop");
  });
});
