---
summary: "Use regular Nous Portal model access with device sign-in"
read_when:
  - You want to connect a Nous Portal account
  - You need help with Nous sign-in or model discovery
title: "Nous Portal"
---

[Nous Portal](https://portal.nousresearch.com) provides access to models through a
Nous account. The bundled `nous` plugin supports regular Portal inference access.
It requests model access only.

## Sign in

In **Models**, select **Connect provider**, then **Nous Portal**. Open the sign-in
page and enter the displayed code if requested. The browser can run on another
machine from the Gateway.

From the command line:

```bash
openclaw models auth login --provider nous --method device
```

For onboarding:

```bash
openclaw onboard --auth-choice nous
```

OpenClaw saves the credentials in its auth profiles and refreshes them when
needed. Do not share the same refresh token with another application: Nous
refresh tokens can rotate after use.

## Choose a model

```bash
openclaw models list --provider nous --refresh
```

Choose a model from that list in Models, or pass its full `nous/` reference to
`openclaw models set`. Available models depend on your account. The plugin reads
the account catalog; it does not ship a fixed list of model IDs.

Regular Portal requests use `https://inference-api.nousresearch.com/v1` with the
OpenAI-compatible chat completions format. Model details that the catalog omits
use OpenClaw's shared conservative discovery defaults.

If you already configured `nous` with another base URL, the plugin preserves that
connection and skips Portal catalog discovery. It does not send that connection's
credential to Nous.

## Supported accounts and troubleshooting

This integration accepts the regular Portal inference endpoint. If the sign-in
or refresh response selects another endpoint, OpenClaw reports an unsupported
model endpoint and stops. Check your account's model access in Portal before
trying again. The anonymous welcome endpoint, guest-account creation, Tool
Gateway, and billing management are outside this integration.

If the device code expires, start sign-in again to get a new code. If you deny
access, the attempt stops. You can also cancel while OpenClaw waits for approval.

If no models appear, check your account's model access in Portal and refresh the
list. If the refresh token has expired or was revoked, sign in again.

See [model authentication](/concepts/oauth) and [model providers](/providers/index).
