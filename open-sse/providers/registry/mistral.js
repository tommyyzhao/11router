/**
 * Mistral — api.mistral.ai (OpenAI-compatible chat/completions + embeddings).
 *
 * Tracks the Mistral Vibe CLI 3.1 catalog (same API key, same endpoint):
 *   mistral-large-4, zai-glm-5-3, zai-glm-5-3-flash, mistral-medium-3.5,
 *   plus the medium aliases mistral-vibe-cli-latest / mistral-medium-latest.
 * `mistral-medium-latest`, `mistral-vibe-cli-latest` resolve to Medium 3.5
 * upstream (reasoning: high only). `mistral-large-4` is the reasoning
 * flagship (low/medium/high, 1M context); the GLM 5.3 models take
 * low/high/max and reject `medium` with a 400. Reasoning arrives as
 * `reasoning_effort` (Mistral accepts the OpenAI field verbatim).
 * Source of truth: live /v1/models + mistral-vibe 3.1.x known_models + CLIProxyAPI.
 */
export default {
  id: "mistral",
  priority: 80,
  alias: "mistral",
  aliases: ["mistral-ai"],
  display: {
    name: "Mistral",
    icon: "air",
    color: "#FF7000",
    textIcon: "MI",
    website: "https://mistral.ai",
    notice: {
      apiKeyUrl: "https://console.mistral.ai/api-keys",
    },
  },
  category: "apikey",
  thinkingConfig: {
    options: ["low", "medium", "high", "max"],
    defaultMode: "high",
  },
  features: {
    usage: true,
    usageApikey: true,
  },
  transport: {
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    validateUrl: "https://api.mistral.ai/v1/models",
    quirks: {
      dropClientMetadata: true,
      // mistral-large-4 streams thinking as content-block arrays in delta.content
      // (not reasoning_content) — the passthrough lane lifts them so
      // OpenAI-shaped clients see canonical reasoning_content + string content.
      reasoningAliasFields: true,
    },
  },
  models: [
    // ── Mistral Vibe CLI 3.1 catalog (subscription / La Plateforme key) ──
    {
      id: "mistral-large-4",
      name: "Mistral Large 4",
      contextLength: 1048576,
    },
    {
      id: "zai-glm-5-3",
      name: "GLM 5.3 (Z.ai)",
      contextLength: 1048576,
    },
    {
      id: "zai-glm-5-3-flash",
      name: "GLM 5.3 Flash (Z.ai)",
      contextLength: 1048576,
    },
    {
      id: "mistral-medium-3.5",
      name: "Mistral Medium 3.5",
      contextLength: 262144,
    },
    {
      // Medium 3.5 alias: the id the Vibe CLI addresses Medium 3.5 with.
      id: "mistral-vibe-cli-latest",
      name: "Mistral Vibe (Medium 3.5)",
      contextLength: 262144,
    },
    {
      id: "mistral-medium-latest",
      name: "Mistral Medium (3.5)",
      contextLength: 262144,
    },
    // ── Core public API catalog ──
    { id: "mistral-large-latest", name: "Mistral Large 3", contextLength: 256000 },
    { id: "codestral-latest", name: "Codestral", contextLength: 256000 },
    { id: "mistral-embed", name: "Mistral Embed", kind: "embedding" },
  ],
  serviceKinds: ["llm", "imageToText", "embedding"],
  embeddingConfig: {
    baseUrl: "https://api.mistral.ai/v1/embeddings",
    authType: "apikey",
    authHeader: "bearer",
  },
};
