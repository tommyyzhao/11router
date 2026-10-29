import { describe, expect, it, vi } from "vitest";
import Ajv from "ajv";

// Translator registration imports the signature store; never load its live DB.
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({ makeKv: () => ({}) }));
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const schema = {
  type: "object",
  properties: {
    description: { type: "string" },
    prompt: { type: "string" },
    subagent_type: { type: "string" },
    model: { type: "string" },
    isolation: { type: "string", enum: ["worktree", "remote"] },
  },
  required: ["description", "prompt"],
  additionalProperties: false,
};
const fourFields = {
  description: "Synthetic task",
  prompt: "No provider call",
  subagent_type: "general-purpose",
  model: "sonnet",
};
const ajv = new Ajv();
const model = "muse-spark-1.3-contributor-free";

function translate(source, strict) {
  const flag = strict === undefined ? {} : { strict };
  const tools = source === FORMATS.CLAUDE
    ? [{ name: "Agent", description: "Synthetic Agent", input_schema: structuredClone(schema), ...flag }]
    : [{ type: "function", function: { name: "Agent", description: "Synthetic Agent", parameters: structuredClone(schema), ...flag } }];
  return translateRequest(source, FORMATS.OPENAI_RESPONSES, model, {
    messages: [{ role: "user", content: "Synthetic test" }], tools,
  }, true);
}

function normalize(executor, body) {
  return executor.transformRequest(model, body, true, { providerSpecificData: {} });
}

const executors = [OpenCodeExecutor, CodexExecutor];

describe("tool strictness across the Claude/Chat Responses boundary", () => {
  it.each([FORMATS.CLAUDE, FORMATS.OPENAI])("%s defaults translated tools to non-strict without widening required", (source) => {
    const translated = translate(source);
    expect(JSON.parse(JSON.stringify(translated)).tools[0].strict).toBe(false);
    for (const Executor of executors) {
      const body = normalize(new Executor(), structuredClone(translated));
      const tool = JSON.parse(JSON.stringify(body)).tools.find(t => t.name === "Agent");
      expect(tool.strict).toBe(false);
      expect(tool.parameters).toEqual(schema);
      expect(tool.parameters.required).toEqual(["description", "prompt"]);
      const validate = ajv.compile(tool.parameters);
      expect(validate({ description: "Minimal", prompt: "Only required fields" })).toBe(true);
      expect(validate(fourFields)).toBe(true);
      expect(validate({ ...fourFields, isolation: "worktree" })).toBe(true);
      expect(validate({ ...fourFields, isolation: null })).toBe(false);
    }
  });

  it.each([true, false])("preserves explicit strict:%s through real translation and executor paths", (strict) => {
    for (const source of [FORMATS.CLAUDE, FORMATS.OPENAI]) {
      const translated = translate(source, strict);
      expect(translated.tools[0].strict).toBe(strict);
      for (const Executor of executors) {
        const body = normalize(new Executor(), structuredClone(translated));
        const tool = body.tools.find(t => t.name === "Agent");
        expect(JSON.parse(JSON.stringify(tool)).strict).toBe(strict);
        expect(tool.parameters).toEqual(schema);
      }
    }
  });

  it.each([true, false])("preserves explicit nested Chat strict:%s in executors", (strict) => {
    for (const Executor of executors) {
      const body = normalize(new Executor(), {
        input: "Synthetic test",
        tools: [{ type: "function", function: { name: "Agent", parameters: structuredClone(schema), strict } }],
      });
      const tool = body.tools.find(t => t.name === "Agent");
      expect(tool.strict).toBe(strict);
      expect(tool.parameters).toEqual(schema);
    }
  });

  it("leaves native Responses omission absent through passthrough and executors", () => {
    const body = { input: "Synthetic test", tools: [{ type: "function", name: "Agent", parameters: structuredClone(schema) }] };
    // Also exercise the translator's already-Responses early return.
    for (const source of [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES]) {
      const translated = translateRequest(source, FORMATS.OPENAI_RESPONSES, model, structuredClone(body), true);
      expect(translated.tools[0]).not.toHaveProperty("strict");
      for (const Executor of executors) {
        const result = normalize(new Executor(), structuredClone(translated));
        const tool = JSON.parse(JSON.stringify(result)).tools.find(t => t.name === "Agent");
        expect(tool).not.toHaveProperty("strict");
        expect(tool.parameters).toEqual(schema);
      }
    }
  });
});
