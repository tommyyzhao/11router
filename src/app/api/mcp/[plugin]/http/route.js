import { NextResponse } from "next/server";
import { findPlugin, isInternal } from "@/lib/mcp/stdioSseBridge";
import { loadInternalHandler } from "@/lib/mcp/internalPlugins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stateless Streamable-HTTP MCP endpoint (no SSE session).
 *
 * Unlike sse/ (one long-lived stream per client, severed by every gateway
 * restart), each POST here is an independent JSON-RPC exchange: initialize,
 * tools/list and tools/call carry no server-side session, so a gateway
 * redeploy can only fail an in-flight call (ordinary retryable tool error)
 * and never latch clients into "server disconnected".
 *
 * Auth is inherited from the dashboardGuard proxy: /api/mcp/9router-web/*
 * requires loopback + the scoped x-9r-mcp-token.
 */
export async function POST(request, { params }) {
  const { plugin } = await params;
  if (!findPlugin(plugin) || !isInternal(plugin)) {
    return NextResponse.json({ error: `Unknown plugin: ${plugin}` }, { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Single JSON-RPC object required" } },
      { status: 400 },
    );
  }

  const handlerMod = await loadInternalHandler(plugin);
  if (!handlerMod?.handleJsonRpc) {
    return NextResponse.json({ error: `No handler for ${plugin}` }, { status: 500 });
  }

  let response;
  try {
    response = await handlerMod.handleJsonRpc(body);
  } catch (e) {
    response = {
      jsonrpc: "2.0",
      id: body?.id ?? null,
      error: { code: -32603, message: e?.message || "Internal error" },
    };
  }
  // Notifications (no id) get a bare 202 — same as the SSE bridge ACK.
  if (!response) return new Response(null, { status: 202 });
  return NextResponse.json(response);
}
