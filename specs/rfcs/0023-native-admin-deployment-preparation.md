---
status: Proposed
implementation_status: Implemented
author: miguelbranco80
---

# Proposal: Prepare enabled native administration at deployment admission

- **ID:** RFC-0023
- **Created:** 2026-10-17
- **RFC and implementation PR:** [#2259](https://github.com/openclaw/openclaw-enterprise/pull/2259)
- **Related:** [scope-cut RFC #898](https://github.com/openclaw/openclaw-enterprise/pull/898), [trusted-operator pilot #256](https://github.com/openclaw/openclaw-enterprise/pull/256), [issue #2257](https://github.com/openclaw/openclaw-enterprise/issues/2257)

## Decision requested

Let the selected Compute Driver prepare an Agent-specific deployment copy before
immutable revision admission. For the enabled Kubernetes native-admin pilot,
prepare the exact Agent origin and existing administrator device policy when the
Agent already enables Control UI. Keep Installation opt-in, explicit Agent
opt-outs and exact-Agent human authorization.

RFC #898 owns the broader scope-cut and dedicated execution-boundary decisions.
This proposal makes #2259's optional Compute contract explicit without changing
that RFC or claiming its decisions are accepted. The candidate implementation
predates the submission-before-code rule; this clarification is submitted before
refreshing that implementation. Submitting this RFC does not resolve
the native-admin-owner hold.

## Implementation and decision status

The candidate implementation is present in #2259: the Compute contract, API and
worker admission paths, Kubernetes preparation, opt-outs and conflict handling.
`Implemented` records that scoped source delivery, not owner acceptance, a merged
release or installed-runtime qualification. The decision remains **Proposed**.
Current evidence and verification limits are recorded in the RFC index and PR;
genuine current-image Kubernetes/Envoy/model qualification remains unrun.

## Problem and owner

Standard OpenClaw and Standard Codex already enable Control UI. On main, operators
still discover the allocated Agent origin, edit reusable Configuration JSON and
redeploy before opening an enabled UI. A reusable Configuration cannot know each
Agent's server-allocated identity.

OCC owns Agent allocation, deployment admission and immutable revisions. Compute
owns native gateway policy. Sandbox already transforms its own configuration
before admission; it should not own the gateway's browser administration policy.

## Proposed contract

Add an optional member to the curated Compute Driver interface:

```ts
configureAgent?(
  configuration: Readonly<OpenClawConfigurationDocument>,
  context: { readonly nativeAdminOrigin?: string },
): OpenClawConfigurationDocument;
```

The operation is synchronous and side-effect-free. OCC calls it with a frozen,
Sandbox-adjusted deployment copy and a trusted Installation-derived origin when
the Installation enables native administration. Origins come from Installation,
Namespace and allocated Agent identity, never request headers or Agent input.
OCC applies logging, validates the result and freezes the admitted Configuration.
The separate `admitRevision` hook continues to record opaque Compute metadata;
it does not transform Configuration. Agent-save validation does not call the
new hook. Drivers omitting it retain their current behavior.

Kubernetes prepares its existing machine trusted-proxy identity, exact Agent
`allowedOrigins`, `publicOrigin` and `operator.admin` device auto-approval only
with private routing and an enabled Agent UI. Installation disablement, absent or
disabled UI, and explicit device-approval disablement leave policy unprepared.
Conflicting authentication, approval scopes, public origin or isolated-domain
origins refuse admission with a setting-specific error. Do not broaden the
trusted origin set or overwrite authored policy to make admission succeed.

API deployment and guided worker provisioning use the same transformation. Keep
reusable Configuration values/generations and historical revisions unchanged.
Existing Agents adopt the policy only on their next explicit deployment. API and
worker require matching Installation origin settings; malformed enabled settings
fail startup. No database migration or automatic rollout is proposed.

## Authority and limits

This remains full native administrator authority under the existing pilot:
private routing, trusted shared-cookie ingress, human session and exact Agent
`administer` admission. Preserve the existing bounded WebSocket authorization
lease. Do not claim immediate cancellation of already accepted commands.
Presets, IAM grants, sign-in compatibility, default enablement, native terminal
policy and the pilot label remain unchanged.

The candidate accepts only the existing machine identity. It does not silently
combine administrator device approval with additional human identities. Open
[#2596](https://github.com/openclaw/openclaw-enterprise/pull/2596) and
[#906](https://github.com/openclaw/openclaw-enterprise/pull/906) require separate
role/identity integration before their human paths can use this preparation.

## Alternatives and delivery

Keeping manual per-Agent JSON preparation avoids a new contract but retains the
first-deployment problem. Putting Kubernetes policy in OCC violates Driver
ownership. Reusing `admitRevision` would change its metadata-only contract.

Keep delivery in #2259 with the owning [reference](../../docs/reference/agent-native-admin.md)
and [flow](../../docs/flows/agent-native-admin.md). Verify first deployment and
worker handoff/replay through existing HTTP/IAM/State integration paths; preserve
Configuration/history and test opt-outs, conflicts and denied callers. Installed
Gateway/browser proof and genuine Kubernetes/model qualification have different
scopes; report their tested revisions and remaining gaps separately.

**Open owner decision:** approve or reject automatic administrator preparation
within the enabled pilot and this optional Compute contract. The proposal remains
unaccepted; refreshing and testing the candidate does not resolve that decision.
