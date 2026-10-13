import { getLocalSpendForConnection } from "@/lib/db/repos/usageRepo.js";

export const LOCAL_SPEND_QUOTA_PROVIDERS = new Set(["muse"]);

function spendQuotaRow(used) {
  const safeUsed = Math.max(0, Number(used) || 0);
  return {
    used: safeUsed,
    total: 0,
    remainingPercentage: 100,
    resetAt: null,
    unlimited: true,
  };
}

export function buildLocalSpendQuotas(spend) {
  const quotas = {};
  if (!spend) return quotas;

  const windows = [
    ["7d", spend.d7],
    ["30d", spend.d30],
  ];

  for (const [label, w] of windows) {
    if (!w) continue;
    quotas[`Requests (${label})`] = spendQuotaRow(w.requests);
    quotas[`Prompt tokens (${label})`] = spendQuotaRow(w.promptTokens);
    quotas[`Completion tokens (${label})`] = spendQuotaRow(w.completionTokens);
  }

  const cost = Number(spend.d30?.cost) || 0;
  if (cost > 0) {
    quotas["Est. cost (30d, USD)"] = spendQuotaRow(cost);
  }

  return quotas;
}

export async function enrichUsageWithLocalSpend(usage, connection) {
  if (!connection?.id || !LOCAL_SPEND_QUOTA_PROVIDERS.has(connection.provider)) {
    return usage;
  }

  try {
    const spend = await getLocalSpendForConnection(connection.id);
    const localQuotas = buildLocalSpendQuotas(spend);
    if (Object.keys(localQuotas).length === 0) return usage;

    const next = { ...(usage || {}) };
    next.localSpend = true;
    next.quotas = { ...(next.quotas || {}), ...localQuotas };
    if (Object.keys(next.quotas).length > 0) delete next.message;
    if (!next.plan) {
      next.plan = "Muse (Meta Model API)";
    }
    return next;
  } catch {
    return usage;
  }
}
