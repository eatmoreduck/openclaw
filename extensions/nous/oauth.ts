import {
  MAX_TIMER_TIMEOUT_MS,
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { ProviderAuthContext, OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import { throwIfOAuthLoginAborted } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { sleep } from "openclaw/plugin-sdk/text-utility-runtime";
import { isNousInferenceBaseUrl } from "./endpoints.js";

const PORTAL_URL = "https://portal.nousresearch.com";
const CLIENT_ID = "hermes-cli";

class NousOAuthError extends Error {
  readonly code: string | undefined;

  constructor(code: unknown, status: number) {
    super(`Nous Portal sign-in request failed (HTTP ${status}). Sign in again.`);
    this.code =
      typeof code === "string" &&
      ["authorization_pending", "slow_down", "access_denied", "expired_token"].includes(code)
        ? code
        : undefined;
  }
}

async function postOAuthForm(
  endpoint: "device/code" | "token",
  fields: Record<string, string>,
  options: { signal?: AbortSignal; assertCurrent?: () => void; refreshToken?: string } = {},
): Promise<Record<string, unknown>> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${PORTAL_URL}/api/oauth/${endpoint}`,
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        ...(options.refreshToken ? { "x-nous-refresh-token": options.refreshToken } : {}),
      },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
    },
    signal: options.signal,
    beforeRequest: options.assertCurrent,
    timeoutMs: 30_000,
    requireHttps: true,
    policy: { hostnameAllowlist: ["portal.nousresearch.com"] },
    auditContext: `nous.oauth.${endpoint}`,
  });
  try {
    const payload = await readProviderJsonObjectResponse(response, "Nous Portal sign-in", {
      // Suppress parser causes that can contain credential bytes.
      requestHeaders: {},
    });
    if (!response.ok || payload.error !== undefined) {
      throw new NousOAuthError(payload.error, response.status);
    }
    return payload;
  } finally {
    await release();
  }
}

function parseToken(payload: Record<string, unknown>, previousRefresh?: string): OAuthCredential {
  const lifetimeMs = positiveSecondsToSafeMilliseconds(payload.expires_in);
  const expires =
    lifetimeMs === undefined
      ? undefined
      : resolveExpiresAtMsFromDurationMs(lifetimeMs, {
          bufferMs: Math.min(60_000, Math.floor(lifetimeMs / 2)),
        });
  const refresh = payload.refresh_token ?? previousRefresh;
  if (
    typeof payload.access_token !== "string" ||
    !payload.access_token.trim() ||
    typeof refresh !== "string" ||
    !refresh.trim() ||
    expires === undefined ||
    (payload.token_type !== undefined &&
      (typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer")) ||
    (payload.scope !== undefined &&
      (typeof payload.scope !== "string" || !payload.scope.split(" ").includes("inference:invoke")))
  ) {
    throw new Error("Nous Portal returned invalid model credentials. Sign in again.");
  }
  if (
    payload.inference_base_url !== undefined &&
    !isNousInferenceBaseUrl(payload.inference_base_url)
  ) {
    throw new Error(
      "This Nous Portal account uses an unsupported model endpoint. Check your account's model access before signing in again.",
    );
  }
  return { type: "oauth", provider: "nous", access: payload.access_token, refresh, expires };
}

function verificationUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Nous Portal returned an invalid verification URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Nous Portal returned an invalid verification URL.");
  }
  if (url.origin !== PORTAL_URL || url.username || url.password) {
    throw new Error("Nous Portal returned an invalid verification URL.");
  }
  return url.href;
}

function parseDevice(payload: Record<string, unknown>) {
  const lifetimeMs = positiveSecondsToSafeMilliseconds(payload.expires_in);
  const expiresAt =
    lifetimeMs === undefined ? undefined : resolveExpiresAtMsFromDurationMs(lifetimeMs);
  const intervalMs = positiveSecondsToSafeMilliseconds(payload.interval ?? 5);
  if (
    typeof payload.device_code !== "string" ||
    !payload.device_code.trim() ||
    typeof payload.user_code !== "string" ||
    !payload.user_code.trim() ||
    expiresAt === undefined ||
    intervalMs === undefined ||
    intervalMs > MAX_TIMER_TIMEOUT_MS
  ) {
    throw new Error("Nous Portal returned an invalid device authorization response.");
  }
  const verificationUri = verificationUrl(payload.verification_uri);
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri:
      payload.verification_uri_complete === undefined
        ? verificationUri
        : verificationUrl(payload.verification_uri_complete),
    expiresAt,
    intervalMs,
  };
}

export async function loginNousOAuth(ctx: ProviderAuthContext): Promise<OAuthCredential> {
  const assertCurrent = () => {
    throwIfOAuthLoginAborted(ctx.signal);
    ctx.assertCurrent?.();
  };
  assertCurrent();
  const payload = await postOAuthForm(
    "device/code",
    { scope: "inference:invoke" },
    {
      signal: ctx.signal,
      assertCurrent,
    },
  );
  assertCurrent();
  const device = parseDevice(payload);
  await ctx.openUrl(device.verificationUri);
  assertCurrent();
  if (ctx.prompter.deviceCode) {
    await ctx.prompter.deviceCode({
      title: "Nous Portal sign-in",
      code: device.userCode,
      expiresInMinutes: Math.ceil((device.expiresAt - Date.now()) / 60_000),
      message: "Enter this one-time code to sign in to Nous Portal.",
    });
  } else {
    await ctx.prompter.note(
      `Open ${device.verificationUri} and enter code ${device.userCode} to sign in to Nous Portal.`,
      "Nous Portal sign-in",
    );
  }
  assertCurrent();
  const progress = ctx.prompter.progress("Waiting for Nous Portal approval…");
  let completed = false;
  try {
    let intervalMs = device.intervalMs;
    while (Date.now() < device.expiresAt) {
      await sleep(Math.min(intervalMs, device.expiresAt - Date.now()), ctx.signal);
      assertCurrent();
      if (Date.now() >= device.expiresAt) {
        break;
      }
      try {
        const token = await postOAuthForm(
          "token",
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.deviceCode,
          },
          { signal: ctx.signal, assertCurrent },
        );
        assertCurrent();
        if (Date.now() >= device.expiresAt) {
          break;
        }
        const credential = parseToken(token);
        completed = true;
        return credential;
      } catch (error) {
        assertCurrent();
        if (!(error instanceof NousOAuthError)) {
          throw error;
        }
        switch (error.code) {
          case "authorization_pending":
            break;
          case "slow_down":
            intervalMs = Math.min(intervalMs + 5_000, MAX_TIMER_TIMEOUT_MS);
            break;
          case "access_denied":
            throw new Error("Nous Portal sign-in was denied. Sign in again when ready.", {
              cause: error,
            });
          case "expired_token":
            throw new Error("Nous Portal device code expired. Start sign-in again.", {
              cause: error,
            });
          default:
            throw error;
        }
      }
    }
    throw new Error("Nous Portal device code expired. Start sign-in again.");
  } finally {
    progress.stop(completed ? "Nous Portal sign-in complete" : "Nous Portal sign-in stopped");
  }
}

export async function refreshNousOAuthCredential(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  if (!credential.refresh.trim()) {
    throw new Error("Nous Portal refresh token is missing. Sign in again.");
  }
  const payload = await postOAuthForm(
    "token",
    { grant_type: "refresh_token" },
    {
      refreshToken: credential.refresh,
    },
  );
  return { ...credential, ...parseToken(payload, credential.refresh) };
}
