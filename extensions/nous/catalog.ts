import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { NOUS_INFERENCE_BASE_URL } from "./endpoints.js";

export async function fetchNousCatalog(
  access: string,
  signal?: AbortSignal,
  assertCurrent?: () => void,
) {
  assertCurrent?.();
  const catalog = await buildOpenAICompatibleLiveModelProviderConfig({
    providerId: "nous",
    providerConfig: { baseUrl: NOUS_INFERENCE_BASE_URL, api: "openai-completions", models: [] },
    discoveryApiKey: access,
    signal,
    discoveryMode: "strict",
    fetchGuard: (params) =>
      fetchWithSsrFGuard({
        ...params,
        beforeRequest: assertCurrent,
        requireHttps: true,
        policy: { hostnameAllowlist: ["inference-api.nousresearch.com"] },
      }),
  });
  assertCurrent?.();
  return catalog;
}
