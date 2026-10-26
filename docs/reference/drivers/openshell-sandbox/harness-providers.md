# OpenShell Harness providers and exposure

How the [OpenShell SandboxDriver](../openshell-sandbox.md) attaches credential
sources and each Agent revision's runtime provider to a Sandbox, and how
dedicated Codex exposes its app-server.

## Credential attachments

For an Agent revision that uses a [credential source](../../credential-sources.md),
Compute passes one attachment per source in `credentialAttachments`. The Driver
appends each attachment's provider name to the static `providers` list in
`SandboxSpec`, rejecting a name outside the OCC `oce-cs-` provider shape or one
that repeats a static provider. Startup rejects
static `providers` entries that use the OCC shape, so operator-configured
providers cannot impersonate a credential source. After the Harness is ready,
Compute requires every attachment to report `ready` before activation.

<span id="dedicated-codex-runtime-provider"></span>

For external ChatGPT authentication, the Sandbox stores account metadata but
omits static `CODEX_ACCESS_TOKEN`. Only the attached OpenShell provider supplies
its bound alias. Withdrawal therefore leaves no placeholder on restart, and the
Harness holds its authentication failure without starting Codex or using cached state.

## Dedicated runtime providers

Each Agent revision's runtime providers use `oce-codex-runtime` or `oce-openclaw-runtime` profiles.
Both expose node-enrollment and Gateway CA files after the Agent Gateway issues
setup. Codex requires nonsecret `runtime.json` and
`config.toml`, each at most 65,536 UTF-8 bytes, addressed through `OPENCLAW_PLUGIN_RUNTIME_MANIFEST` and
`OPENCLAW_PLUGIN_CODEX_CONFIG_TOML`; native OpenClaw rejects them. Ordinary
Secret-backed environment projections remain unsupported.

The expiring setup token is visible inside the Sandbox, without a production
credential guarantee. Policy limits node egress to the Gateway and executable.
Codex waits for its provider route; native OpenClaw connects outbound. Renewal
updates `node_setup_json` only if the provider's resource version still matches;
endpoint, TLS fingerprint, runtime files, CA, and identity labels must also match.
Native startup reads the envelope; the Codex
supervisor rereads it before node retries and retains valid setup during projection
gaps. The raw app-server token stays outside the provider. Plugins and repository
broker configuration fail before creation.

Agent revision cleanup deletes the Sandbox before its Git and runtime providers; Namespace
cleanup removes leftover Git providers and unused profiles. Adoption requires matching
Namespace, Agent, and Agent revision IDs and nonsecret configuration,
except when renewing an expired setup envelope. Failed or timed-out Sandbox creation may complete remotely. The provider remains
for normal Agent revision cleanup with the Sandbox.

## Create-time app-server exposure

For dedicated Codex, `CreateSandbox` includes one unnamed exposure for Compute's
literal `APP_SERVER_PORT`. The UUID from the Agent revision ID is the first `request_id`.
With no Sandbox,
[create retries](../../../flows/openshell-sandbox-provisioning.md#4-call-the-versioned-gateway-contract)
after unresolved refusals use at most 16 request IDs. Adoption requires an
exact Sandbox and, before enrollment, exposure. The client keeps a normalized control URL and the
advertised workload URL, which `harnessEndpoint` returns
as a WebSocket origin.

Compute supplies only `APP_TOKEN_SHA`, never the raw token; bearer passthrough
forwards the header Codex, or a native held failure, authenticates. Other
exposures keep OpenShell's authorization-stripping default. A Sandbox without a
replayable Create receipt must be removed, not mutated by `ExposeService`.

Compute replaces the fail-closed Gateway target and omits its direct Agent
Service and Harness route. Drivers without provider transport retain Kubernetes transport.

A native worker's node opens its Gateway connection. Its exposure serves
only Compute's held-failure read before enrollment; OpenShell routes it
unauthenticated, so once the node enrolls the Driver deletes it
(`DeleteService`, fail closed); adoption or recreation has none. A missing
service, Sandbox or credential attachment is gone only if `GetWorkspace` answers
and a second read still misses it (OpenShell hides unauthorized Sandboxes as
missing); a refusal fails with `SANDBOX_GATEWAY_UNAUTHORIZED`. The worker's
sweep covers Agent revisions without a current reconciliation pass and failed candidates.
