// Offline routing matrix for opencode-go models.
//
// Drives the REAL handleChatCore guard + targetFormat resolution (open-sse/handlers/chatCore.js:86-94)
// end-to-end; only the executor's HTTP response is mocked. The assertion target is
// credentials.runtimeTransport — the exact field DefaultExecutor.buildUrl/buildHeaders read
// (open-sse/executors/default.js:106,150) to pick the endpoint and auth scheme — so a wrong
// guard decision shows up as the wrong baseUrl here, same as it would on the wire.
//
// Cells:
//   - deepseek × {openai, claude, openai-responses} × {bare, (max)} — the endpoint matrix
//     under dispute in #3278/#3332. Bare and suffixed cells must resolve identically.
//   - glm/kimi (chat-only) + (max) — regression cells: with the thinking suffix, the guard
//     is bypassed on master (suffix isn't stripped before the registry lookup) and these get
//     routed to /messages, which the upstream does not serve for them.
//   - minimax + (max) + claude — suffix must NOT block a genuinely declared format.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock, fetchMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  fetchMock: vi.fn(),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";
import { getAppPackageVersion } from "../../open-sse/config/appConstants.js";

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", async (importOriginal) => ({
  ...await importOriginal(),
  COLORS: { red: "", reset: "" },
}));

vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

// image.js imports Agent from "undici" (not installed in some dev envs); the
// prefetch path is irrelevant to routing assertions.
vi.mock("../../open-sse/translator/concerns/image.js", () => ({
  encodeDataUri: (mimeType, base64) => `data:${mimeType};base64,${base64}`,
  parseDataUri: (url) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    return m ? { mimeType: m[1], base64: m[2] } : null;
  },
  fetchImageAsBase64: async () => null,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const BASE = "https://opencode.ai/inference/go";
const ENDPOINTS = {
  openai: `${BASE}/openai/v1/chat/completions`,
  claude: `${BASE}/anthropic/v1/messages`,
  "openai-responses": `${BASE}/openai/v1/responses`,
};

// Minimal non-stream provider JSON per target format — the mocked executor's response.
const RESPONSE_BY_FORMAT = {
  claude: {
    id: "msg_1", type: "message", role: "assistant", model: "test",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  openai: {
    id: "chatcmpl-1", object: "chat.completion", model: "test",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
  "openai-responses": {
    id: "resp_1", object: "response", created_at: 0, status: "completed", model: "test",
    output: [{
      type: "message", id: "msg_1", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }],
  },
};

async function route(model, sourceFormat) {
  executeMock.mockResolvedValueOnce({
    response: new Response(JSON.stringify(RESPONSE_BY_FORMAT[sourceFormat === "openai" ? "openai" : sourceFormat] || RESPONSE_BY_FORMAT.openai), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    url: ENDPOINTS[sourceFormat] || ENDPOINTS.openai,
    headers: {},
    transformedBody: null,
  });

  const credentials = { apiKey: "test-key", providerSpecificData: {} };
  const result = await handleChatCore({
    body: {
      model: `opencode-go/${model}`,
      stream: false,
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    },
    modelInfo: { provider: "opencode-go", model },
    credentials,
    connectionId: "ocg-route-test",
    sourceFormatOverride: sourceFormat,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });

  const { credentials: creds } = executeMock.mock.calls.at(-1)[0];
  return { result, runtimeTransport: creds.runtimeTransport ?? null };
}

describe("opencode-go DeepSeek endpoint matrix (via real handleChatCore)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    for (const suffix of ["", "(max)"]) {
      const id = model + suffix;
      for (const [fmt, expectedUrl] of Object.entries(ENDPOINTS)) {
        it(`routes ${id} + ${fmt}-format client to ${expectedUrl}`, async () => {
          const { result, runtimeTransport } = await route(id, fmt);
          expect(result.success).toBe(true);
          expect(runtimeTransport?.baseUrl).toBe(expectedUrl);
        });
      }
    }
  }
});

describe("opencode-go thinking-suffix guard (regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT route chat-only glm-5.2(max) to /messages on a claude-format request", async () => {
    const { result, runtimeTransport } = await route("glm-5.2(max)", "claude");
    expect(result.success).toBe(true);
    expect(runtimeTransport).toBeNull(); // guard must block; falls back to chat/completions
  });

  it("does NOT route chat-only kimi-k2.6(max) to /responses on a responses-format request", async () => {
    const { result, runtimeTransport } = await route("kimi-k2.6(max)", "openai-responses");
    expect(result.success).toBe(true);
    expect(runtimeTransport).toBeNull();
  });

  it("still routes minimax-m3(max) + claude-format client to /messages", async () => {
    const { result, runtimeTransport } = await route("minimax-m3(max)", "claude");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS.claude);
  });

  it("translates minimax-m3(max) from Responses to its documented Claude default", async () => {
    const { result, runtimeTransport } = await route("minimax-m3(max)", "openai-responses");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.format).toBe("claude");
    expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS.claude);
  });
});

describe("OpenCode Go Gemini through real chatCore, translator and executor", () => {
  for (const [sourceFormat, stream] of [["openai", false], ["openai", true], ["claude", false], ["claude", true]]) {
    it(`translates Gemini ${stream ? "SSE" : "JSON"} to ${sourceFormat} without leaking client auth`, async () => {
      vi.clearAllMocks();
      const native = {
        candidates: [{ content: { role: "model", parts: [{ text: "Gemini says hello" }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
      };
      fetchMock.mockResolvedValueOnce(new Response(stream ? `data: ${JSON.stringify(native)}\n\n` : JSON.stringify(native), {
        headers: { "content-type": stream ? "text/event-stream" : "application/json" },
      }));
      executeMock.mockImplementationOnce(args => new OpenCodeGoExecutor().execute(args));
      const credentials = { apiKey: "go-test-key", rawHeaders: { authorization: "client-secret", "x-api-key": "client-secret", "anthropic-beta": "client-beta" } };
      const result = await handleChatCore({
        body: { model: "opencode-go/gemini-4-argon-contributor", stream, max_tokens: 16, messages: [{ role: "user", content: "hello" }] },
        modelInfo: { provider: "opencode-go", model: "gemini-4-argon-contributor" },
        credentials,
        clientRawRequest: { headers: { ...credentials.rawHeaders, "user-agent": "opencode/spoof" } },
        sourceFormatOverride: sourceFormat,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      });
      expect(result.success).toBe(true);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE}/google/v1beta/models/gemini-4-argon-contributor:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`);
      expect(options.headers["User-Agent"]).toBe(`9router/${getAppPackageVersion()}`);
      expect(options.headers["anthropic-beta"]).toBeUndefined();
      expect(options.headers["x-goog-api-key"]).toBe("go-test-key");
      expect(JSON.stringify(options.headers)).not.toContain("client-secret");
      expect(options.headers["Authorization"]).toBeUndefined();
      expect(options.headers["x-api-key"]).toBeUndefined();
      expect(JSON.parse(options.body).contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
      const output = await result.response.text();
      expect(output).toContain("Gemini says hello");
      expect(output).not.toContain("candidates");
      if (sourceFormat === "claude" && stream) {
        const events = output.split(/\r?\n\r?\n/).filter(Boolean).map(frame => {
          const event = frame.split(/\r?\n/).find(line => line.startsWith("event: "))?.slice(7);
          const data = JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith("data: ")).slice(6));
          expect(event).toBe(data.type);
          return data;
        });
        expect(events[0]).toMatchObject({ type: "message_start", message: { type: "message", role: "assistant", content: [] } });
        expect(events.find(event => event.type === "content_block_start")).toMatchObject({ index: 0, content_block: { type: "text" } });
        expect(events.filter(event => event.type === "content_block_delta").map(event => event.delta.text || "").join("")).toBe("Gemini says hello");
        expect(events.find(event => event.type === "content_block_stop")).toMatchObject({ index: 0 });
        expect(events.at(-2)).toMatchObject({ type: "message_delta", delta: { stop_reason: "end_turn" } });
        expect(events.at(-1)).toEqual({ type: "message_stop" });
        expect(output).not.toContain("[DONE]");
      } else if (sourceFormat === "claude") {
        expect(JSON.parse(output)).toMatchObject({
          type: "message", role: "assistant",
          content: [{ type: "text", text: "Gemini says hello" }],
          // Existing nonstream handler adds a 2000-token input buffer.
          stop_reason: "end_turn", usage: { input_tokens: 2002, output_tokens: 3 },
        });
      } else if (stream) expect(output).toContain("data:");
      else expect(JSON.parse(output).choices[0].message.content).toBe("Gemini says hello");
    });
  }
});

// claude-haiku-5-5 is /messages-only upstream: /chat/completions answers
// "ModelProtocolUnsupported". Every client wire must therefore land on /messages —
// claude directly, openai/responses through the declared targetFormat fallback.
describe("opencode-go claude-haiku-5-5 is pinned to /messages for every client wire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const fmt of ["claude", "openai", "openai-responses"]) {
    it(`routes a ${fmt}-format client to ${ENDPOINTS.claude}`, async () => {
      const { result, runtimeTransport } = await route("claude-haiku-5-5", fmt);
      expect(result.success).toBe(true);
      expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS.claude);
    });
  }
});
