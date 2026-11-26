---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Test experimental OpenShell OAuth

Use an owned, disposable environment for account verification. The current
TokenService path is described below. The earlier Gateway OAuth image and
synthetic refresh procedure belongs to a retired development profile; use the
[historical verification guide](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/testing/openshell-oauth.md)
with its matching release.

## TokenService Codex account verification

`device-authorization-api.test.ts` and `openshell-device-authorization-api.test.ts`
exercise the production Fastify, IAM, and selected TokenService device-login path
with a controlled issuer. PostgreSQL coverage exercises persisted session and Source settlement. These
controlled checks do not prove a real user grant, Worker activation, or native
bearer substitution. Earlier isolated live runs are recorded in
[the merged cutover verification](https://github.com/openclaw/openclaw-enterprise/pull/7224);
they do not qualify every later commit.

Full account qualification requires an approved Codex account and device-login
interaction, a disposable application-role PostgreSQL database, and a qualified
stock Codex/OpenShell runtime with selected Compute and Credential Proxy. Verify
the real login, Agent model turn, retained Provider, renewal and Proxy update,
then required-model withdrawal and Source cleanup. Also check native behavior that
requires issuer-signed claims; the launcher supplies unsigned local metadata.

<a id="prepare-images-and-trust"></a>
<a id="run-the-synthetic-refresh-proof"></a>
<a id="receiver-fixtures-and-full-stack-qualification"></a>
