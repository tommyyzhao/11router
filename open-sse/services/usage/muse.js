import { DefaultExecutor } from "../../executors/default.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { createMuseSubscriptionObserver, validateMuseSubscriptionSnapshot, museCredentialFingerprint } from "../../utils/museSubscriptionUsage.js";
import { U, parseResetTime } from "./shared.js";

const cache = new Map();
const flights = new Map();
const MAX_CACHE_ENTRIES = 256;
const MAX_ERROR_BYTES = 8192;
const NO_SUBSCRIPTION = "No Muse Code subscription on this key (pay-as-you-go).";

function usageFromSnapshot(snapshot, message = null) {
  if (!snapshot) return { message: message || NO_SUBSCRIPTION };
  const quota = (value) => ({
    used: value.usedPercent, total: 100, remainingPercentage: 100 - value.usedPercent,
    resetAt: parseResetTime(value.resetsAt), unlimited: false,
  });
  return {
    quotas: { "Session (5h)": quota(snapshot.window), "Weekly (7d)": quota(snapshot.weekly) },
  };
}

function exhaustedUsage(snapshot, resetsAt) {
  const resetAt = parseResetTime(resetsAt);
  if (!snapshot) return {
    quotas: { "Subscription (exhausted)": { used: 100, total: 100, remainingPercentage: 0, resetAt, unlimited: false } },
  };
  const usage = usageFromSnapshot(snapshot);
  const row = snapshot.weekly.resetsAt === resetsAt ? "Weekly (7d)" : "Session (5h)";
  usage.quotas[row] = { ...usage.quotas[row], used: 100, remainingPercentage: 0, resetAt };
  return usage;
}

async function probe(connection, proxyOptions, onSnapshot) {
  const config = U("muse");
  const controller = new AbortController();
  // Whole-stream deadline, not just response headers; reasoning must finish first.
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let reader;
  try {
    const response = await proxyAwareFetch(config.url, {
      method: "POST",
      headers: new DefaultExecutor("muse").buildHeaders(connection, true),
      body: JSON.stringify({ model: config.probeModel, input: "Reply OK.", stream: true }),
      signal: controller.signal,
      redirect: "error", // never forward the key to another host
    }, proxyOptions);
    if (!response.ok) {
      if (response.status === 429 && response.body) {
        try {
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let size = 0;
          let text = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              const error = JSON.parse(text + decoder.decode())?.error;
              if (error?.code === "rate_limit_exceeded" && Number.isFinite(error.resets_at) && error.resets_at > 0 &&
                  Number.isFinite(new Date(error.resets_at * 1000).getTime())) {
                return { exhaustedUntil: error.resets_at };
              }
              break;
            }
            size += value.byteLength;
            if (size > MAX_ERROR_BYTES) break;
            text += decoder.decode(value, { stream: true });
          }
        } catch { /* Malformed error bodies keep the generic status message. */ }
      }
      if (!reader) await response.body?.cancel().catch(() => {});
      return { message: response.status === 401
        ? "Muse authentication expired (401). Reconnect this connection."
        : `Muse quota probe failed (${response.status}).` };
    }
    if (!response.body || !(response.headers.get("content-type") || "").includes("text/event-stream")) {
      await response.body?.cancel().catch(() => {});
      return { message: "Muse quota probe returned an invalid stream." };
    }
    let snapshot = null;
    let terminal = false;
    let failed = false;
    let doneSeen = false;
    const observer = createMuseSubscriptionObserver((value) => { snapshot = value; }, {
      onTerminal: () => { terminal = true; },
      onFailure: () => { failed = true; },
      onDone: () => { doneSeen = true; },
    });
    reader = response.body.getReader();
    while (!snapshot && !failed && !doneSeen) {
      const { done, value } = await reader.read();
      if (done) { observer.finish(); break; }
      observer.push(value);
    }
    if (failed || (!snapshot && !terminal)) return { message: "Muse quota refresh failed. Showing the last snapshot if available." };
    if (!snapshot) return { message: NO_SUBSCRIPTION };
    let message = null;
    try { await onSnapshot?.(snapshot); }
    catch { message = "Quota refreshed, but the snapshot could not be saved."; }
    return { snapshot, message };
  } catch {
    // Never echo fetch errors: proxy/transport messages can contain credentials.
    return { message: "Muse quota probe failed. Showing the last snapshot if available." };
  } finally {
    clearTimeout(timer);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export async function getMuseUsage(connection, proxyOptions = null, { onSnapshot } = {}) {
  const token = connection.apiKey || connection.accessToken;
  if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) {
    return { message: "Muse key not available. Reconnect this connection." };
  }
  const key = connection.id || connection.connectionId;
  const fingerprint = museCredentialFingerprint(token);
  const metadata = connection.providerSpecificData;
  const stored = metadata?.museSubscriptionUsageCredential === fingerprint
    ? validateMuseSubscriptionSnapshot(metadata.museSubscriptionUsage) : null;
  const cached = key ? cache.get(key) : null;
  const matching = cached?.fingerprint === fingerprint ? cached : null;
  const snapshot = matching?.snapshot && (!stored || matching.snapshot.capturedAt > stored.capturedAt)
    ? matching.snapshot : stored;
  const now = Date.now();
  const ttl = U("muse").cacheTtlMs;
  // Exhaustion ends at its reset, or earlier if live traffic captured a newer snapshot.
  if (matching?.exhaustedUntil && now - matching.checkedAt <= ttl && now < matching.exhaustedUntil * 1000 &&
      !(snapshot && snapshot.capturedAt > matching.checkedAt)) return exhaustedUsage(snapshot, matching.exhaustedUntil);
  if (snapshot && now >= snapshot.capturedAt && now - snapshot.capturedAt <= ttl) return usageFromSnapshot(snapshot);
  // Negative results/failures get the same cooldown: the dashboard polls every minute.
  if (matching && now - matching.checkedAt <= ttl) return usageFromSnapshot(snapshot, matching.message);
  const flight = key ? flights.get(key) : null;
  if (flight && flight.fingerprint === fingerprint) return flight.promise;
  const promise = (async () => {
    const result = await probe(connection, proxyOptions, onSnapshot);
    const refreshed = result.snapshot || snapshot;
    if (key) {
      cache.delete(key);
      cache.set(key, { fingerprint, checkedAt: Date.now(), snapshot: refreshed, message: result.message, exhaustedUntil: result.exhaustedUntil });
      while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    }
    return result.exhaustedUntil ? exhaustedUsage(refreshed, result.exhaustedUntil) : usageFromSnapshot(refreshed, result.message);
  })();
  if (key) flights.set(key, { fingerprint, promise });
  try { return await promise; }
  finally { if (key && flights.get(key)?.promise === promise) flights.delete(key); }
}
