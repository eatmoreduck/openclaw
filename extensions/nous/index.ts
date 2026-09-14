import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import { resolveOAuthApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { isNousInferenceBaseUrl } from "./endpoints.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const loadOAuth = createLazyRuntimeModule(() => import("./oauth.js"));
const loadCatalog = createLazyRuntimeModule(() => import("./catalog.js"));

export default defineSingleProviderPluginEntry({
  id: "nous",
  name: "Nous Portal Provider",
  description: "Nous Portal model access with device sign-in",
  manifest,
  provider: {
    label: "Nous Portal",
    docsPath: "/providers/nous",
    extraAuth: [
      {
        id: "device",
        label: "Nous Portal",
        hint: "Sign in with a Nous Portal account",
        kind: "device_code",
        wizard: {
          choiceId: "nous",
          choiceLabel: "Nous Portal",
          groupId: "nous",
          groupLabel: "Nous Portal",
          groupHint: "Device sign-in",
        },
        run: async (ctx) => {
          const credentials = await (await loadOAuth()).loginNousOAuth(ctx);
          const result: ProviderAuthResult = {
            profiles: [{ profileId: "nous:default", credential: credentials }],
          };
          if (!ctx.credentialOnly) {
            const catalog = await (
              await loadCatalog()
            ).fetchNousCatalog(credentials.access, ctx.signal, ctx.assertCurrent);
            const model = catalog.models[0];
            if (!model) {
              throw new Error("Nous Portal returned no models. Check your account's model access.");
            }
            result.defaultModel = `nous/${model.id}`;
          }
          ctx.signal?.throwIfAborted();
          ctx.assertCurrent?.();
          return result;
        },
      },
    ],
    catalog: {
      order: "profile",
      run: async (ctx) => {
        const configured = resolveMergedModelProviderConfig(ctx.config, "nous");
        if (configured && !isNousInferenceBaseUrl(configured.baseUrl)) {
          return null;
        }
        const { apiKey, discoveryApiKey, profileId } = ctx.resolveProviderAuth("nous", {
          oauthMarker: resolveOAuthApiKeyMarker("nous"),
        });
        if (!discoveryApiKey) {
          return null;
        }
        return await runLiveProviderCatalog({
          providerId: "nous",
          profileId,
          run: async () => ({
            provider: {
              ...(await (await loadCatalog()).fetchNousCatalog(discoveryApiKey)),
              apiKey,
            },
          }),
        });
      },
    },
    refreshOAuth: async (credential) => (await loadOAuth()).refreshNousOAuthCredential(credential),
  },
});
