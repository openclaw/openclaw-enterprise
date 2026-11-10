---
created: "2026-11-10"
updated: 2026-11-10
last_updated_session: authoring-run/a802f6ce-4398-4469-a79b-cc18fe9219a9
---

# Authorize model credentials per request

## Overview

A dedicated Codex Agent receives a placeholder instead of an OpenAI key.
For each admitted HTTPS Responses request, the OpenShell supervisor obtains
one approval from OpenClaw Control Plane (OCC), redeems it once, and injects the
current key outside the guest. This flow describes the implementation; it does
not establish qualification of an installed OpenShell and Codex pair.
The [Driver contract](../../reference/drivers/credential-proxy.md#online-model-requests)
defines the guarantee. Existing strict exchanges retain their
[separate flow](../credential-source-egress.md).

## Entry Points

- `packages/occ/src/index.ts:createCredentialSource` selects an explicitly
  requested `authorization: "online-request"` provider after source and Secret
  permission checks. Omission selects the strict profile.
- `packages/occ/src/index.ts:admitProxyPlan` records the selected profile, source,
  grant and execution. The operator and Agent need source `operate` permission.
- `apps/controller/src/drivers/egress-proxy/openshell-request-credential.ts:authorizeOpenShellRequest`
  handles the authenticated supervisor's pre-credential request.

## Flow

```mermaid
graph TD
  A["Supervisor captures<br/>HTTPS model request"] --> B{"Current route, model<br/>and permission?"}
  B -->|No| X["Refuse credential"]
  B -->|Yes| C["OCC stores<br/>one-use approval"]
  C --> D["Supervisor redeems<br/>with JWT-SVID"]
  D --> E{"Identity and approval<br/>match?"}
  E -->|No| X
  E -->|Yes| F["Consume approval<br/>and recheck authority"]
  F --> G["Read Secret twice<br/>and compare versions"]
  G --> H{"Current authority<br/>and matching material?"}
  H -->|No| X
  H -->|Yes| I["Release key to supervisor<br/>for this request"]
  I --> J["Inject bearer<br/>and relay response"]
```

The diagram ends at the supervisor relay. This profile does not hold the full
response for OCC inspection or authorize an exact upstream dispatch.

## Execution Trace

### 1. Save and install the explicit profile

`packages/occ/src/index.ts:staticEgressProvider` selects by source type and
requested authorization profile. Updates retain the exact provider ID and
generation. The bundled adapter registers `openai-online-request`, generation 1,
separately from the strict provider. `admitProxyPlan` rejects mixed profiles and
records `authorization: "online-request"`. Admission version 8 covers the model
route; version 9 also requires independently authorized mandatory Git delivery.
`packages/contracts/src/drivers/credential-proxy/index.ts:assertExecutionAdmission`
refuses policy reduction for this profile. Binding removal may stop or redeploy
the execution through the existing lifecycle.

`apps/controller/src/drivers/sandbox/openshell-model-request-policy.ts:openShellModelRequestPolicy`
requires one dedicated Codex route at `/v1/responses`. It creates a provider with
no stored key, no credential environment mapping and an explicit zero-cache token
grant. The guest receives a placeholder. The existing Gateway source owner
remains metadata; it receives no model-key copy or attachment for this path.

`verifyModelRequestProfile` and `verifyModelRequestPolicy` in that file check the
provider, token endpoint, audience, mandatory middleware and actual admitted
policy. Overlapping model routes and a missing required hook refuse release.
Git has its own provider and disjoint route. Compute releases the Harness only
after current installation checks. Codex uses the existing custom Responses
provider with WebSockets disabled; an API-key selection alone does not establish
that transport.

### 2. Approve the captured request

`openshell-request-credential.ts:authorizeOpenShellRequest` authenticates the
Gateway-signed supervisor identity, reads the installed binding, and passes the
captured method, target, headers and body to OCC. Malformed binding configuration
is denied. `packages/occ/src/index.ts:checkRequestCredential` verifies the current
recipient, installation, revision, source, route, provider and IAM permission,
then classifies the actual request against the admitted model grant.

OCC stores a nonsecret approval in PostgreSQL, correlated with recipient,
request ID, binding, execution, Driver, policy digest and deadline. It stores no
request body or key. The approval lifetime is at most 30 seconds. Approval alone
does not permit credential release after a subsequent withdrawal.

### 3. Redeem once against current authority

`apps/controller/src/drivers/egress-proxy/openshell-token-grant.ts:bindOpenShellTokenGrant`
independently verifies a SPIFFE JWT-SVID against the configured trust bundle and
exact token-endpoint audience. Its subject identifies the Sandbox. Request ID and
binding are separately correlated protocol fields, not signed SVID claims.
The supervisor's Workload API socket and registration must be inaccessible to
the guest; a guest able to mint the same SVID could redeem an approval itself.

`packages/occ/src/credential-proxy.ts:resolveRequestCredential` consumes the
approval once and rechecks authority. Through the selected Secret Driver, it
performs two authoritative reads outside the policy transaction. Different
versions, material identities or values refuse release. It validates material
and performs a final current-authority check before returning the key. Expiry,
withdrawal, cancellation, stale installation and ambiguous outcomes fail closed;
a consumed approval is not retried.

The token endpoint returns a short release lease with `Cache-Control: no-store`.
Its `expires_in` does not describe the provider key's lifetime. OpenShell must
retain `cache_ttl: 0`, inject the bearer outside the guest, and request a new
approval for the next operation. Rotation or withdrawal after the final release
cannot recall material already released. Such a request may finish, including
its streamed response.

## Debugging and Verification

Inspect the selected source's provider ID/generation and the saved revision's
profile before diagnosing transport. A ready source is not proof of installed
enforcement. Middleware refusal reports `request_credential_denied`; token
redemption can return `invalid_client` or `invalid_grant`. Do not log assertions
or response material while collecting these errors.

Follow the [operator checks](../../guides/credential-proxy/model-requests.md#verify-the-installed-path).
Local source and controlled-origin proof do not replace an installed test of
actual Codex HTTPS/SSE traffic, isolated supervisor identity, required middleware,
zero-cache grants, source withdrawal and absence of a direct route. Independently
revoke each path's IAM grant to check that the denied path cannot reach its origin
while the other authorized path remains usable in the same Sandbox. This check
does not remove bindings or establish continuity during binding removal.

## Related docs

- [Credential Proxy contract](../../reference/drivers/credential-proxy.md)
- [Threat model](../../reference/security/credential-proxy.md)
- [Model request setup](../../guides/credential-proxy/model-requests.md)
- [Source withdrawal](../../reference/credential-sources/withdrawal.md)

## Manual Notes

None.

## Changelog

- 2026-11-10 02:57: Distinguish independent IAM denial from binding-removal lifecycle. (authoring-run/a802f6ce-4398-4469-a79b-cc18fe9219a9 - a6ebd816924d1669911a07e09ecdebc3d8b3176e)

- 2026-11-10 02:54: Trace explicit model approval and single-use credential release in the accompanying implementation. (authoring-run/a802f6ce-4398-4469-a79b-cc18fe9219a9 - a6ebd816924d1669911a07e09ecdebc3d8b3176e)
