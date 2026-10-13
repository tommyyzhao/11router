import { createHash } from "node:crypto";

export const museCredentialFingerprint = (key) => createHash("sha256").update(key).digest("hex");

// Muse emits subscription quota after the response terminal event, before [DONE].
// Observe raw bytes, not translated/completed output: clients can close on the terminal.
export const MUSE_SUBSCRIPTION_USAGE_EVENT = "response.subscription_usage";
const MAX_EVENT_CHARS = 65536;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function resetTime(value) {
  return finite(value) && value > 0 && value * 1000 <= 8640000000000000;
}

export function validateMuseSubscriptionSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.tier !== "string" || !/^[\w.-]{1,100}$/.test(snapshot.tier)) return null;
  const { window, weekly, capturedAt } = snapshot;
  if (!finite(capturedAt) || capturedAt <= 0 || capturedAt > 8640000000000000 ||
      !finite(window?.usedPercent) || !resetTime(window?.resetsAt) ||
      !finite(window?.durationMins) || window.durationMins <= 0 ||
      !finite(weekly?.usedPercent) || !resetTime(weekly?.resetsAt)) return null;
  const clamp = (value) => Math.max(0, Math.min(100, value));
  return {
    tier: snapshot.tier,
    window: { usedPercent: clamp(window.usedPercent), resetsAt: window.resetsAt, durationMins: window.durationMins },
    weekly: { usedPercent: clamp(weekly.usedPercent), resetsAt: weekly.resetsAt },
    capturedAt,
  };
}

export function parseMuseSubscriptionUsage(data, capturedAt = Date.now()) {
  if (data?.type !== MUSE_SUBSCRIPTION_USAGE_EVENT) return null;
  const subscription = data.subscription;
  return validateMuseSubscriptionSnapshot({
    tier: subscription?.tier,
    window: {
      usedPercent: subscription?.window?.used_percent,
      resetsAt: subscription?.window?.resets_at,
      durationMins: subscription?.window?.window_duration_mins,
    },
    weekly: { usedPercent: subscription?.weekly?.used_percent, resetsAt: subscription?.weekly?.resets_at },
    capturedAt,
  });
}

// Bounded SSE observer shared by normal traffic and quota probes; never changes bytes.
export function createMuseSubscriptionObserver(onSnapshot, { onTerminal, onFailure, onDone } = {}) {
  const decoder = new TextDecoder();
  let buffer = "";
  let droppingLine = false;
  let event = "";
  let data = "";
  let oversized = false;
  const dispatch = () => {
    if (!oversized) {
      try {
        if (data.trim() === "[DONE]") onDone?.();
        else {
          const parsed = JSON.parse(data);
          if (parsed?.error || parsed?.type === "response.failed" || parsed?.type === "response.incomplete" || event === "error") onFailure?.();
          if (parsed?.type === "response.completed" || parsed?.choices?.some((choice) => choice.finish_reason)) onTerminal?.();
          if (!event || event === MUSE_SUBSCRIPTION_USAGE_EVENT) {
            const snapshot = parseMuseSubscriptionUsage(parsed);
            if (snapshot) Promise.resolve(onSnapshot(snapshot)).catch(() => {});
          }
        }
      } catch { /* malformed event / capture failure: fail-open */ }
    }
    event = "";
    data = "";
    oversized = false;
  };
  const line = (value) => {
    const text = value.endsWith("\r") ? value.slice(0, -1) : value;
    if (!text) { dispatch(); return; }
    if (text.startsWith("event:")) event = text.slice(6).trim();
    if (text.startsWith("data:")) {
      const payload = text.slice(5).replace(/^ /, "");
      if (data.length + payload.length > MAX_EVENT_CHARS) oversized = true;
      else if (!oversized) data += (data ? "\n" : "") + payload;
    }
  };
  const feed = (text) => {
    for (const part of text.split(/(?<=\n)/)) {
      const ended = part.endsWith("\n");
      if (!droppingLine) {
        if (buffer.length + part.length > MAX_EVENT_CHARS) {
          buffer = "";
          droppingLine = true;
          oversized = true;
        } else buffer += part;
      }
      if (ended) {
        if (!droppingLine) line(buffer.slice(0, -1));
        buffer = "";
        droppingLine = false;
      }
    }
  };
  return {
    push(chunk) { feed(decoder.decode(chunk, { stream: true })); },
    finish() { feed(decoder.decode()); if (buffer && !droppingLine) line(buffer); dispatch(); },
  };
}

export function captureMuseSubscriptionUsage(body, provider, onSnapshot, lifecycle = {}) {
  if (provider !== "muse" || !body || !onSnapshot) return body;
  const reader = body.getReader();
  let terminal = false;
  let captured = false;
  let doneSeen = false;
  let cancelled = false;
  let trailerBytes = 0;
  let timer = null;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* already released */ }
    if (cancelled) lifecycle.onDrainComplete?.();
  };
  const observer = createMuseSubscriptionObserver((snapshot) => {
    captured = true;
    return onSnapshot(snapshot);
  }, { onTerminal: () => { terminal = true; }, onDone: () => { doneSeen = true; } });
  lifecycle.shouldDrainOnDisconnect = () => terminal && !captured && !doneSeen && !stopped;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          observer.finish();
          stopped = true;
          clearTimeout(timer);
          reader.releaseLock();
          if (!cancelled) controller.close();
          return;
        }
        if (cancelled) trailerBytes += value.byteLength;
        if (!cancelled || trailerBytes <= 16384) {
          try { observer.push(value); } catch { /* capture must not break traffic */ }
        }
        if (!cancelled) controller.enqueue(value);
        if (cancelled && (captured || doneSeen || trailerBytes >= 16384)) await stop();
      } catch (error) { if (!cancelled) controller.error(error); await stop(); }
    },
    async cancel() {
      cancelled = true;
      if (!lifecycle.shouldDrainOnDisconnect()) { await stop(); return; }
      // Only a completed response gets a short, bounded trailer drain.
      timer = setTimeout(stop, 2000);
      try {
        while (!stopped && !captured && !doneSeen && trailerBytes < 16384) {
          const { done, value } = await reader.read();
          if (done) { observer.finish(); break; }
          trailerBytes += value.byteLength;
          if (trailerBytes <= 16384) observer.push(value);
        }
      } catch { /* trailer is optional */ }
      await stop();
      reader.releaseLock();
    },
  });
}
