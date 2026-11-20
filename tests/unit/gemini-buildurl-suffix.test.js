import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("gemini-format buildUrl", () => {
  const ex = new DefaultExecutor("gemini");
  const base = "https://generativelanguage.googleapis.com/v1beta/models";

  it("strips the (thinking) annotation from the URL model", () => {
    expect(ex.buildUrl("gemini-3.6-flash(high)", true)).toBe(
      `${base}/gemini-3.6-flash:streamGenerateContent?alt=sse`
    );
    expect(ex.buildUrl("gemini-3.6-flash(high)", false)).toBe(`${base}/gemini-3.6-flash:generateContent`);
  });

  it("leaves plain ids untouched", () => {
    expect(ex.buildUrl("gemini-2.5-pro", true)).toBe(`${base}/gemini-2.5-pro:streamGenerateContent?alt=sse`);
  });
});
