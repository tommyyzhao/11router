import { ROLE } from "../schema/index.js";

// Build OpenAI delta carrying reasoning_content (optional leading assistant role)
export function reasoningDelta(text, withRole = false) {
  return withRole
    ? { role: ROLE.ASSISTANT, reasoning_content: text }
    : { reasoning_content: text };
}

// Lazily add the canonical OpenAI reasoning field when an upstream streams the
// vendor aliases instead: `reasoning` (string) and `reasoning_details[]`
// (OpenRouter-style lanes). Only ever ADDS the field — the aliases stay intact
// for clients that read them — and never touches a delta that already carries
// reasoning_content. Without this, OpenAI-shaped clients see no thinking at all:
// reasoningDelta()/the SSE→JSON aggregator/usage tracking all read
// reasoning_content.
export function liftReasoningAliases(delta) {
  if (!delta || typeof delta !== "object") return delta;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) return delta;
  const text = extractReasoningText(delta);
  return text ? { ...delta, reasoning_content: text } : delta;
}

// Extract reasoning text from a streamed OpenAI-compatible delta across vendor shapes:
//   - reasoning_content (GLM, Qwen, DeepSeek, Kimi, Step, Hunyuan)
//   - reasoning (some compat layers)
//   - reasoning_details[] (MiniMax reasoning_split=true): [{ text|content }]
// Returns concatenated reasoning string, or "" when none.
export function extractReasoningText(delta) {
  if (!delta || typeof delta !== "object") return "";
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) return delta.reasoning_content;
  if (typeof delta.reasoning === "string" && delta.reasoning) return delta.reasoning;
  const details = delta.reasoning_details;
  if (Array.isArray(details)) {
    return details.map((d) => (typeof d === "string" ? d : d?.text || d?.content || "")).join("");
  }
  return "";
}

// Mistral's reasoning chat models (mistral-large-4 et al.) stream/return
// thinking inside their proprietary content-block array instead of a native
// reasoning field:
//   content: [
//     { type: "thinking", thinking: [{ type: "text", text }], closed: true },
//     { type: "text", text },
//   ]
// Lift those blocks into the canonical lanes — reasoning_content from the
// thinking parts plus a plain string content from the text parts — so every
// consumer (response translators, SSE→JSON aggregation, usage accounting,
// OpenAI-shaped clients) sees the same shape as vendors that emit
// reasoning_content natively. Strictly shape-gated: an array without any
// thinking part (plain OpenAI text-part arrays, multimodal parts) is returned
// untouched, and so is every non-array content.
export function liftThinkingBlocks(target) {
  const content = target?.content;
  if (!Array.isArray(content) || content.length === 0) return target;
  let sawThinking = false;
  let thinkingText = "";
  let text = "";
  for (const part of content) {
    if (!part || typeof part !== "object") return target;
    if (part.type === "thinking") {
      sawThinking = true;
      for (const seg of part.thinking || []) {
        if (typeof seg?.text === "string") thinkingText += seg.text;
      }
    } else if (part.type === "text" && typeof part.text === "string") {
      text += part.text;
    } else {
      // Unknown part type — not Mistral's block shape, leave the array alone.
      return target;
    }
  }
  if (!sawThinking) return target;
  const next = { ...target, content: text };
  if (thinkingText) {
    next.reasoning_content =
      (typeof target.reasoning_content === "string" ? target.reasoning_content : "") + thinkingText;
  }
  return next;
}
