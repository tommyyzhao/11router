import { describe, expect, it } from "vitest";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

// OpenCode Go's /anthropic wire 400s "reasoning_effort: requires a native Anthropic Messages
// target" for DeepSeek; its claude-adaptive thinking shape uses thinking.type=adaptive instead.
const transport = (format) => ({ runtimeTransport: PROVIDERS["opencode-go"].transports.find((t) => t.format === format) });

function prepared(format) {
  const body = { model: "deepseek-v4.1-flash", max_tokens: 2048, messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budget_tokens: 4096 } };
  applyThinking(format, "deepseek-v4.1-flash(high)", body, "opencode-go");
  return new OpenCodeGoExecutor().transformRequest("deepseek-v4.1-flash", body, true, transport(format));
}

describe("opencode-go claude wire thinking", () => {
  it("drops reasoning_effort on /anthropic and uses adaptive thinking", () => {
    const out = prepared("claude");
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("keeps reasoning_effort on the chat wire", () => {
    expect(prepared("openai").reasoning_effort).toBe("high");
  });
});
