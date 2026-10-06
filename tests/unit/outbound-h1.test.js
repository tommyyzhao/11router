// 2026-10-06: Node's bundled fetch negotiated h2 and shared one session per origin; when it died,
// every request to that origin failed with ERR_HTTP2_INVALID_SESSION. Direct egress must stay H1.
import { describe, expect, it, afterAll } from "vitest";
import http2 from "node:http2";
import selfsigned from "selfsigned";

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 1 });
// http2 secure server advertises h2 via ALPN; a default Node fetch would answer "2.0" here.
const server = http2.createSecureServer({ key: pems.private, cert: pems.cert, allowHTTP1: true }, (req, res) => {
  res.end(req.httpVersion);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `https://localhost:${server.address().port}/`;
const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed test cert

afterAll(() => {
  if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
  server.close();
});

describe("direct provider egress", () => {
  it("uses HTTP/1.1 even when the upstream offers h2", async () => {
    const res = await proxyAwareFetch(url, { method: "POST", body: "{}" });
    expect(await res.text()).toBe("1.1");
  });
});
