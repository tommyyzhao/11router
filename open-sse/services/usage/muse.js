import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";

const FALLBACK_URL = "https://api.meta.ai/v1/models";

function planFor(providerSpecificData) {
  const tier = providerSpecificData?.subscriptionTier;
  return tier ? `Muse Code (${tier})` : "Muse (Meta Model API)";
}

export async function getMuseUsage(token, providerSpecificData = null, proxyOptions = null) {
  if (!token || typeof token !== "string" || !token.trim()) {
    return { message: "Muse credentials not available. Reconnect to view usage." };
  }
  const plan = planFor(providerSpecificData);
  const url = U("muse").url || FALLBACK_URL;
  try {
    const response = await proxyAwareFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" },
    }, proxyOptions);
    if (response.status === 401 || response.status === 403) {
      return { plan, message: "Muse authentication failed. Reconnect or re-login to view usage." };
    }
    if (!response.ok) {
      return { plan, message: `Muse usage error (${response.status})` };
    }
    await response.text().catch(() => {});
    return {
      plan,
      localSpend: true,
      message: "Meta does not expose subscription usage percentages over HTTP; showing spend routed through 9Router.",
      quotas: {},
    };
  } catch (error) {
    return { message: `Muse usage error: ${error.message}` };
  }
}
