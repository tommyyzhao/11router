import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";

const replacements = {
  minimax: "MiniMax-M3.1-Flash",
  "minimax-cn": "MiniMax-M3.1-Flash",
  "minimax-code": "MiniMax-M3.1-Flash-Preview",
  "minimax-code-global": "MiniMax-M3.1-Flash-Preview",
  clinepass: "cline-pass/minimax-m3.1-flash",
  "opencode-go": "minimax-m3.1-flash",
  nvidia: "minimaxai/minimax-m3.1-flash",
  ollama: "minimax-m3.1-flash",
  "opencode-zen": "minimax-m3.1-flash-free",
};
const retired = ["bazaarlink", "codebuddy-cn", "codebuddy-intl", "commandcode", "kimchi", "qoder", "qoder-cn", "trae"];
const legacy = /minimax[- /]*m3(?![.\d])/i;

describe("MiniMax M3.1 Flash catalog migration", () => {
  it("removes legacy IDs and names from every active registry definition", async () => {
    const directory = new URL("../../open-sse/providers/registry/", import.meta.url);
    for (const file of readdirSync(directory).filter(file => file.endsWith(".js") && file !== "index.js")) {
      const { default: provider } = await import(new URL(file, directory).href);
      for (const model of provider.models || []) {
        for (const field of [model.id, model.name, model.upstreamModelId]) {
          expect(legacy.test(field || ""), `${provider.id}: ${field}`).toBe(false);
        }
      }
    }
  });

  it("uses verified wire IDs exactly once, retaining coding Preview and unrelated models", () => {
    for (const [provider, id] of Object.entries(replacements)) {
      const models = getModelsByProviderId(provider);
      expect(models.filter(model => model.id === id), provider).toHaveLength(1);
      const ids = models.map(model => model.id);
      expect(new Set(ids).size, provider).toBe(ids.length);
      expect(models.find(model => model.id === id).name).toContain("MiniMax M3.1 Flash");
    }
    for (const provider of ["minimax", "minimax-cn"]) {
      const models = getModelsByProviderId(provider);
      expect(models.find(model => model.id === replacements[provider]).targetFormat).toBe("claude");
      for (const id of ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1"]) {
        expect(models.some(model => model.id === id)).toBe(true);
      }
    }
    expect(getModelsByProviderId("opencode-go").find(model => model.id === replacements["opencode-go"]))
      .toMatchObject({ targetFormat: "claude", supportedFormats: ["openai", "claude"] });
    expect(getModelsByProviderId("opencode-zen").find(model => model.id === replacements["opencode-zen"]))
      .toMatchObject({ supportedFormats: ["openai"] });
  });

  it("retires unsupported M3 without inventing replacements or emptying providers", async () => {
    for (const provider of retired) {
      const { default: { models } } = await import(`../../open-sse/providers/registry/${provider}.js`);
      expect(models.length, provider).toBeGreaterThan(0);
      expect(models.some(model => /minimax[- /]*m3|^mmodel$/i.test(`${model.id} ${model.name}`)), provider).toBe(false);
    }
  });
});
