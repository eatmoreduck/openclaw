import fs from "node:fs";
import path from "node:path";
import {
  configureAiTransportHost,
  createApiRegistry,
  createLlmRuntime,
  getAiTransportHost,
} from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/provider-auth";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineAuthProfileCredentialSchema } from "../../src/agents/auth-profiles/credential-schema.js";
import { ensureAuthProfileStore } from "../../src/agents/auth-profiles/store-runtime.js";
import { runProviderPluginAuthMethodUnpersisted } from "../../src/plugins/provider-auth-method.js";
import { persistProviderAuthProfilesAfterLogin } from "../../src/plugins/provider-auth-persistence.js";
import { closeOpenClawAgentDatabasesForTest } from "../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import nousPlugin from "./index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const { guardedFetch, release } = vi.hoisted(() => ({
  guardedFetch: vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
  release: vi.fn(async () => {}),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guardedFetch,
}));

function reply(payload: unknown, status = 200) {
  guardedFetch.mockResolvedValueOnce({
    response: Response.json(payload, { status }),
    release,
    finalUrl: "https://portal.nousresearch.com/api/oauth/token",
  });
}
function device(overrides: Record<string, unknown> = {}) {
  reply({
    device_code: "test-device-secret",
    user_code: "TEST-CODE",
    verification_uri: "https://portal.nousresearch.com/device",
    verification_uri_complete: "https://portal.nousresearch.com/device?user_code=TEST-CODE",
    expires_in: 120,
    interval: 2,
    ...overrides,
  });
}
function token(overrides: Record<string, unknown> = {}) {
  reply({
    access_token: "test-access",
    refresh_token: "test-refresh",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "inference:invoke",
    inference_base_url: "https://inference-api.nousresearch.com/v1",
    ...overrides,
  });
}
function context(overrides: Partial<ProviderAuthContext> = {}): ProviderAuthContext {
  return {
    config: {},
    credentialOnly: true,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: createWizardPrompter({ deviceCode: vi.fn(async () => {}) }),
    isRemote: true,
    openUrl: vi.fn(async () => {}),
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected callback flow");
      },
    },
    ...overrides,
  };
}
async function start(ctx = context()) {
  const provider = await registerSingleProviderPlugin(nousPlugin);
  const method = provider.auth.find((entry) => entry.id === "device");
  if (!method) {
    throw new Error("Nous device method is not registered");
  }
  return await runProviderPluginAuthMethodUnpersisted({ ...ctx, method });
}
function request(index: number) {
  const call = guardedFetch.mock.calls[index];
  if (!call) {
    throw new Error(`Missing request ${index}`);
  }
  return call[0];
}

function form(index: number) {
  const body = request(index).init?.body;
  if (!(body instanceof URLSearchParams)) {
    throw new Error("Expected an OAuth form request");
  }
  return body;
}

beforeAll(async () => {
  await import("./oauth.js");
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
  guardedFetch.mockReset();
  release.mockClear();
  clearLiveCatalogCacheForTests();
});
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("registered Nous device sign-in", () => {
  it("presents a typed destination and code, honors polling intervals, and returns saveable credentials", async () => {
    device();
    reply({ error: "authorization_pending" }, 400);
    reply({ error: "slow_down" }, 400);
    token({ token_type: "bearer" });
    const ctx = context();
    const result = start(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.openUrl).toHaveBeenCalledWith(
      "https://portal.nousresearch.com/device?user_code=TEST-CODE",
    );
    expect(ctx.prompter.deviceCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TEST-CODE", expiresInMinutes: 2 }),
    );
    expect(ctx.prompter.note).not.toHaveBeenCalled();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3999);
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(guardedFetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(6999);
    expect(guardedFetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    const auth = await result;
    expect(auth.defaultModel).toBeUndefined();
    expect(auth.configPatch).toBeUndefined();
    expect(inlineAuthProfileCredentialSchema.parse(auth.profiles[0]?.credential)).toMatchObject({
      type: "oauth",
      provider: "nous",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 3540000,
    });
    expect(form(0)).toEqual(
      new URLSearchParams({ client_id: "hermes-cli", scope: "inference:invoke" }),
    );
    expect(request(0).url).toBe("https://portal.nousresearch.com/api/oauth/device/code");
    expect(request(1).url).toBe("https://portal.nousresearch.com/api/oauth/token");
    expect(form(1).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(release).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["access_denied", "denied"],
    ["expired_token", "expired"],
    ["invalid_grant", "Sign in again"],
  ])("stops on %s without exposing response text", async (code, message) => {
    device();
    reply({ error: code, error_description: "secret-response" }, 400);
    const result = expect(start()).rejects.toThrow(message);
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it("expires before the next server interval without polling early", async () => {
    device({ expires_in: 1, interval: 2 });
    const result = expect(start()).rejects.toThrow("expired");
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("cancels while waiting and never polls or returns credentials", async () => {
    device();
    const controller = new AbortController();
    const result = expect(start(context({ signal: controller.signal }))).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await result;
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects lost caller authority after the token response", async () => {
    device();
    let current = true;
    guardedFetch.mockImplementationOnce(async (params) => {
      params.beforeRequest?.();
      current = false;
      return {
        response: Response.json({
          access_token: "test-access",
          refresh_token: "test-refresh",
          expires_in: 3600,
        }),
        release,
        finalUrl: params.url,
      };
    });
    const result = expect(
      start(
        context({
          assertCurrent: () => {
            if (!current) {
              throw new Error("Owner changed");
            }
          },
        }),
      ),
    ).rejects.toThrow("Owner changed");
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it("carries cancellation into the request and rejects a late successful reply", async () => {
    device();
    const controller = new AbortController();
    guardedFetch.mockImplementationOnce(async (params) => {
      expect(params.signal).toBe(controller.signal);
      controller.abort();
      return {
        response: Response.json({
          access_token: "test-access",
          refresh_token: "test-refresh",
          expires_in: 3600,
        }),
        release,
        finalUrl: params.url,
      };
    });
    const result = expect(start(context({ signal: controller.signal }))).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(2000);
    await result;
  });

  it.each([
    "https://attacker.example/device",
    "https://portal.nousresearch.com.attacker.example/device",
    "https://user@portal.nousresearch.com/device",
  ])("rejects an untrusted verification destination %s", async (url) => {
    device({ verification_uri_complete: url });
    const ctx = context();
    await expect(start(ctx)).rejects.toThrow("verification URL");
    expect(ctx.openUrl).not.toHaveBeenCalled();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://welcome-api.nousresearch.com/v1",
    "https://attacker.example/v1",
    "https://inference-api.nousresearch.com/v1?other=1",
  ])("rejects unsupported inference routing %s before returning credentials", async (url) => {
    device();
    token({ inference_base_url: url });
    const result = expect(start()).rejects.toThrow("unsupported model endpoint");
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it("chooses a real discovered model for setup and keeps secrets out of catalog configuration", async () => {
    device();
    token();
    reply({
      data: [{ id: "vendor/account-model", context_length: 64000, max_output_tokens: 4096 }],
    });
    const result = start(context({ credentialOnly: false }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toMatchObject({ defaultModel: "nous/vendor/account-model" });
    const provider = await registerSingleProviderPlugin(nousPlugin);
    const catalog = await runSingleProviderCatalog(provider, {
      resolveProviderAuth: () => ({
        apiKey: "nous-oauth",
        discoveryApiKey: "test-access",
        mode: "oauth",
        source: "profile",
      }),
    });
    expect(catalog).toMatchObject({
      baseUrl: "https://inference-api.nousresearch.com/v1",
      api: "openai-completions",
      apiKey: "nous-oauth",
      models: [{ id: "vendor/account-model", contextWindow: 64000, maxTokens: 4096 }],
    });
    expect(JSON.stringify(catalog)).not.toContain("test-access");
    expect(request(2).url).toBe("https://inference-api.nousresearch.com/v1/models");
    expect(new Headers(request(2).init?.headers).get("Authorization")).toBe("Bearer test-access");
    const modelsPath = path.join(tempDirs.make("nous-models-"), "models.json");
    fs.writeFileSync(modelsPath, JSON.stringify({ providers: { nous: catalog } }));
    const model = ModelRegistry.create(AuthStorage.inMemory(), modelsPath).find(
      "nous",
      "vendor/account-model",
    );
    if (!model) {
      throw new Error("Missing Nous chat model");
    }
    const previousHost = getAiTransportHost();
    const requests: Request[] = [];
    const inferenceFetch: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        [
          'data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"Connected"},"finish_reason":null}]}',
          'data: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          "data: [DONE]",
        ].join("\n\n") + "\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    configureAiTransportHost({ buildModelFetch: () => inferenceFetch });
    try {
      const registry = createApiRegistry();
      registerBuiltInApiProviders(registry);
      const stream = createLlmRuntime(registry).streamSimple(
        model,
        { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
        { apiKey: "test-access" },
      );
      expect(await stream.result()).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "Connected" }],
      });
      expect(requests[0]?.url).toBe("https://inference-api.nousresearch.com/v1/chat/completions");
      expect(requests[0]?.headers.get("Authorization")).toBe("Bearer test-access");
    } finally {
      configureAiTransportHost(previousHost);
    }
  });

  it("does not invent a setup model for an empty account catalog", async () => {
    device();
    token();
    reply({ data: [] });
    const result = expect(start(context({ credentialOnly: false }))).rejects.toThrow(
      "returned no models",
    );
    await vi.advanceTimersByTimeAsync(2000);
    await result;
  });
});

it.each(["nous", "NoUs"])(
  "preserves an explicit %s proxy without resolving or sending its key to Nous",
  async (providerId) => {
    const provider = await registerSingleProviderPlugin(nousPlugin);
    const config: ProviderAuthContext["config"] = {
      models: {
        providers: {
          [providerId]: {
            baseUrl: "https://proxy.example/v1",
            apiKey: "test-proxy-key",
            models: [],
          },
        },
      },
    };
    const before = structuredClone(config);
    const resolveAuth = vi.fn(() => {
      throw new Error("Custom proxy auth must not reach Nous discovery");
    });
    expect(
      await provider.catalog?.run({
        config,
        env: {},
        resolveProviderAuth: resolveAuth,
        resolveProviderApiKey: resolveAuth,
      }),
    ).toBeNull();
    expect(resolveAuth).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
    expect(config).toEqual(before);
  },
);

it("refreshes through the registered hook using the Nous header and replaces the rotated token", async () => {
  const provider = await registerSingleProviderPlugin(nousPlugin);
  device();
  token();
  const login = start();
  await vi.advanceTimersByTimeAsync(2000);
  const result = await login;
  vi.useRealTimers();
  const stateDir = tempDirs.make("nous-auth-");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    await persistProviderAuthProfilesAfterLogin({
      profiles: result.profiles,
      config: {},
      env,
      stateDir,
      agentDir,
    });
    const read = () =>
      ensureAuthProfileStore(agentDir, { readOnly: true, syncExternalCli: false }).profiles[
        "nous:default"
      ];
    const credential = read();
    if (!credential || credential.type !== "oauth" || !provider.refreshOAuth) {
      throw new Error("Missing saved Nous credential");
    }
    token({ access_token: "test-new-access", refresh_token: "test-new-refresh" });
    const refreshed = await provider.refreshOAuth(credential);
    await persistProviderAuthProfilesAfterLogin({
      profiles: [{ profileId: "nous:default", credential: refreshed }],
      config: {},
      env,
      stateDir,
      agentDir,
    });
    expect(read()).toMatchObject({ access: "test-new-access", refresh: "test-new-refresh" });
    expect(new Headers(request(2).init?.headers).get("x-nous-refresh-token")).toBe("test-refresh");
    expect(form(2).toString()).not.toContain("test-refresh");
    token({ inference_base_url: "https://welcome-api.nousresearch.com/v1" });
    await expect(provider.refreshOAuth(refreshed)).rejects.toThrow("unsupported model endpoint");
    expect(read()).toMatchObject({ access: "test-new-access", refresh: "test-new-refresh" });
  });
});
