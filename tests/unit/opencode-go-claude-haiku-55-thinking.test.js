// OpenCode Go's claude-haiku-5-5 rejects budget-shaped thinking:
//   400 "thinking.type.enabled" is not supported for this model.
//       Use "thinking.type.adaptive" and "output_config.effort" to control thinking
// The provider-scoped capability override (capabilities.js PROVIDER_CAPABILITIES["opencode-go"])
// switches it to claude-adaptive, which emits exactly that pair. These tests drive the
// real applyThinking() so a regression in the capability entry shows up as the old shape.
import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// A Claude-wire request asking for thinking on (what Claude Code sends).
const claudeWireBody = () => ({
  model: "claude-haiku-5-5",
  max_tokens: 4096,
  thinking: { type: "enabled", budget_tokens: 8000 },
  messages: [{ role: "user", content: "hi" }],
});

describe("opencode-go claude-haiku-5-5 thinking shape", () => {
  it("provider override and global Haiku 5 support select adaptive", () => {
    expect(getCapabilitiesForModel("opencode-go", "claude-haiku-5-5").thinkingFormat).toBe("claude-adaptive");
    expect(getCapabilitiesForModel(undefined, "claude-haiku-5-5").thinkingFormat).toBe("claude-adaptive");
  });

  it("emits thinking.type=adaptive + output_config.effort (never type=enabled)", () => {
    const body = applyThinking("claude", "claude-haiku-5-5", claudeWireBody(), "opencode-go");

    expect(body.thinking?.type).toBe("adaptive");
    expect(body.thinking).not.toHaveProperty("budget_tokens");
    expect(body.output_config?.effort).toBeTruthy();
  });

  it("preserves adaptive thinking on the native Claude provider", () => {
    const body = applyThinking("claude", "claude-haiku-5-5", claudeWireBody(), "claude");

    expect(body.thinking?.type).toBe("adaptive");
    expect(body.thinking).not.toHaveProperty("budget_tokens");
    expect(body.output_config?.effort).toBeTruthy();
  });
});
