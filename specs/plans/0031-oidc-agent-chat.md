---
rfc: ../rfcs/0031-oidc-agent-chat.md
---

# Implementation plan: OIDC sign-in through Agent chat

- **ID:** RFC-0031
- **Delivery status:** Implemented
- **Authority:** [OIDC sessions and operator chat](../rfcs/0031-oidc-agent-chat.md)
- **Source baseline:** OCE `8b9b105b6398`; OpenClaw `513c12703ad9` from
  [the runtime pin](../../deploy/runtime/openclaw-source.json).

## Outcome and scope

Deliver the RFC's existing-account journey through the regular Console and
Agent lifecycle: OIDC sign-in, create/configure/deploy with existing grants,
open chat, stream a real reply, stop a turn and reconnect. The implementation
must distinguish `operate` chat from `administer` native administration.
Automatic account creation and the RFC's other exclusions remain out of scope.

Implementation started after the user approved execution and the RFC was
submitted for human review in PR #5136.

## Contract and source touchpoints

| Owner          | Existing source                                                                                                                                                                                                                          | Work                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Authentication | [auth/index.ts](../../apps/controller/src/auth/index.ts), [auth/github.ts](https://github.com/openclaw/openclaw-enterprise/blob/5cf15141c6e52d387bd8e2a83cc39542291bf916/apps/controller/src/auth/github.ts), [admission](../../apps/controller/src/admission/admission-verifier.ts)                                             | Shared OIDC session name, scope, callback and guarded native-host admission     |
| Startup        | [production](../../apps/controller/src/composition/production.ts), [development PostgreSQL](../../apps/controller/src/composition/development-postgres.ts), [Helm helpers](../../deploy/helm/openclaw-enterprise/templates/_helpers.tpl) | Remove OIDC pair rejection consistently with profile rendering                  |
| Platform/IAM   | [controller](../../packages/occ/src/index.ts), [IAM contract](../../packages/contracts/src/drivers/iam/index.ts)                                                                                                                         | Exact-Agent mode selection and `operate` semantics                              |
| Compute        | [contract](../../packages/contracts/src/drivers/compute/index.ts), [Kubernetes implementation](../../apps/controller/src/drivers/compute/kubernetes/index.ts)                                                                            | Restricted endpoint capability, lifecycle route generation and native scope cap |
| Browser proxy  | [native-admin HTTP](../../apps/controller/src/http/native-admin.ts), [transport](../../apps/controller/src/gateway/native-admin-proxy.ts), [configuration support](../../apps/controller/src/gateway/native-admin.ts)                    | Same access decision for status, return links, HTTP, upgrades and renewal       |
| Console        | [native UI launcher](../../apps/controller/src/console/agents/native-admin.mts), [Agent creation](../../apps/controller/src/console/agents/create.mts)                                                                                   | Chat entry, owner setup and capability-aware errors                             |

## Implementation

### 1. Qualify the native chat boundary

Submit the RFC before contract implementation. Start from the pinned runtime's
session scope and HTTP/WS enforcement. Extend the real-runtime coverage in
[runtime-image-native-listener](../../tests/integration/runtime-image-native-listener.test.mjs)
to prove that a route cap of `operator.sessions.write` restricts the current
administrative service identity and every device grant it can present.
Exercise the native UI's actual startup and chat traffic. Inventory its session
features and confirm that credentials, configuration and administrative events
are not exposed through another HTTP path or subscription.

If scope intersection or the UI does not meet the RFC, fix and qualify the
owning OpenClaw implementation before exposing the capability in OCE. Record
the exact image digest and source. A header-only fixture or a successful chat
request does not establish administrative denial. Any image change follows the
repository's image-verification workflow; no image publication is part of
writing this plan.

### 2. Add restricted routing through Compute

Add and curate the RFC's optional `getGatewayChatEndpoint` member through the
top-level contracts export. Update Driver contract checks and test adapters
that implement the changed contract; do not make unsupported Drivers advertise
chat support.

Kubernetes Compute adds private chat rules to the existing managed HTTPRoute
for the same Agent Service. Use an exact base and segment-bounded prefix beneath a new disjoint
prefix, such as `/native-chat/namespaces/<namespaceId>/agents/<agentId>`.
Administrative fallback must be impossible if that route is absent. Reuse
service-key authentication, suffix validation, TLS trust and network isolation.
Overwrite both identity and scope headers for HTTP and WS. Require explicit
scopes at the native listener and retain native device-scope safeguards.

Render and reconcile the route with the Agent revision. Stop/delete, revision
replacement and failed provisioning must not leave a route to a different
Agent or revision. Advertise support only when saved native configuration and
the selected runtime satisfy the qualified contract. Preserve workspace-file,
Harness and existing full-admin traffic.

### 3. Compose OIDC with shared sessions

Remove the OIDC/native-admin rejection from production and development
composition, Helm and installation-profile validation. Remove the public
`agentNativeAdmin.sharedCookieDomain`, `OCC_AUTH_COOKIE_DOMAIN` and
`OCC_DEVELOPMENT_AUTH_COOKIE_DOMAIN` inputs, including examples, profile output
and chart schema entries; reject supplied retired inputs with an actionable
configuration error. Update their development producers and consumers in
`internal/occdev/up.go`, `compose.go`, `gateway_k3d.go` and `openshell_k3d.go`,
plus development and browser fixtures. Derive the shared domain
once from the configured Console and Agent DNS names using the RFC's rule,
and pass the derived value internally to authentication and proxy validation.
Keep the same scope with browser access enabled or disabled. Validate required
HTTPS hostnames, DNS-label boundaries and public suffixes at startup; adapt
local browser setup to HTTPS DNS names. Keep the RFC's
GitHub/Google boundary explicit; do not accidentally advertise broader support.

Use one shared session name and Domain attribute, independent of provider or
browser-access enablement. Update Better Auth configuration, OIDC session issuance,
readers and logout together. Revoke the current session and expire its shared
cookie on logout. Do not retain obsolete-cookie cleanup. Document manual
browser-cookie cleanup and fresh sign-in for duplicate-cookie refusals.
Keep attempt/receipt cookies host-only, and preserve PostgreSQL
account/method/session checks and recovery-only password behavior.

Handle Agent-origin session reads at the native admission boundary. Console
mutations still require the Console origin. Reject duplicate sessions, forged
forwarded hosts and sibling origins. Preserve session binding in the Console;
do not send its session key or cookie upstream. The shared session is
installation-wide and includes local recovery sign-in, not an alternate
OIDC-only session store.

### 4. Integrate permission selection and the Console

Centralize exact-Agent mode selection through the selected IAM Driver, honoring
Restrictions and distinguishing a denial from dependency failure. Preserve
existing full-admin behavior, add `operate` chat admission and select only the
corresponding Compute endpoint. Apply the decision to native-host requests,
availability/status and copied-link recovery. Add mode to the status response
and update its schema, generated OpenAPI and API cheat sheet.

Capture the original session, Principal, Agent, revision and mode on upgrade.
Renew them through guarded authentication and IAM. Close when the original
session becomes invalid or its authorization, revision or mode changes.
Browser-cookie replacement alone leaves the original socket bound to its
original session; reconnect authenticates the current cookie. Never silently
retarget a socket. Extend audit admission/closure details without logging chat
or credentials.

Expose **Open chat** to operators and retain **Open Agent UI** for
administrators. Return an actionable unsupported message if the restricted
route or runtime is unavailable. A read-only viewer sees no usable chat action.
Native administrative controls must remain denied even if a caller opens their
URLs or sends requests without the Console.

Let creators read sanitized browser-access capabilities and enable access in
the ordinary Agent draft/create/deploy path with existing write/deploy grants.
Reuse server-derived host and native settings. Do not require Installation read
or grant unrestricted guided provisioning. `operate` alone enables chat on an
already configured Agent; it does not confer setup permissions.

### 5. Update current documentation and proof

Update the owning authentication, OIDC, native UI, gateway-routing, IAM and
Kubernetes Compute references, the native UI deployment guide, Console guides,
and the existing [native UI flow](../../docs/flows/agent-native-admin.md).
Update the permission cheat sheet for the expanded `operate` meaning and the
environment-variable sheet to remove the cookie-domain override. Document the
derived domain and required hostname relationship in deployment guides. Use the
OpenAPI generator for API inventory changes. Add no migration guide.

The architectural claim affected is
[the native admin pilot exception](../../docs/design.md#native-admin-pilot-exception):
browser access will no longer always require `administer` or carry native admin
authority. Update that claim concisely when implementation ships and link to
the native-access reference. Reference/flow changes alone would leave that
architecture claim false. Preserve historical RFCs and plans.

## Verification

The table defines the required proof. Observed results and remaining limits
are recorded in the [delivery record](#delivery-record).

| Outcome                  | Required proof                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OIDC startup and cookies | Extend `postgres-oidc-sign-in` and `postgres-oidc-tab-binding`; validate Helm, profile and development setup parity. Prove automatic narrowest-domain derivation, invalid-hostname and retired-input refusal, unchanged scope when access is disabled, shared session attributes, host-only attempt/receipt cookies, current-session logout, duplicate rejection and Console tab binding. |
| Permission split         | Extend `native-admin-access` and `native-admin-session-postgres`: `operate` succeeds only through chat; `administer` retains admin access; read-only, sibling-Agent and unprovisioned callers fail. Real PostgreSQL verifies account and session changes.                                                                                                                                 |
| Native enforcement       | Real pinned gateway: new conversation, history, streaming, stop and reconnect succeed. Direct config/credential/pairing/approval/Gateway-tool requests and admin event subscriptions fail over HTTP and WS. Repeat with forged scope/identity headers, elevated `connect` claims and previously paired admin device credentials.                                                          |
| Lifecycle and revocation | Remove `operate`, remove `administer` while keeping `operate`, invalidate the admitted session, disable the account, stop the Agent and replace its revision. Prove closure within 30 seconds and State/IAM outage closure. Separately replace only the browser cookie: the original socket keeps its original session and authority; reconnect authenticates the new cookie.             |
| Complete user journey    | Extend `native-admin-k3d-real` and register an `oidc-agent-chat` scenario in `qa-matrix-real.test.mjs` / `qa-selection.mjs`. Pre-provision an OIDC account and owner/operator grants; use real Keycloak browser sign-in, owner setup/deploy, then a genuine model turn on the Agent. Prove another Agent and administrative methods are denied.                                           |
| Customer IdP             | Repeat the existing-account sign-in-to-chat flow against an authorized PingFederate deployment. Record issuer configuration and outcome without credentials. Keycloak proof alone does not establish PingFederate qualification.                                                                                                                                                          |
| Console experience       | Update launcher and create-page Storybook states for operator, administrator, read-only, unsupported, loading and errors. Inspect rebuilt desktop previews, capture screenshots and a short interaction video; distinguish fixture UI from the real journey.                                                                                                                              |

Use the repository's PostgreSQL roles and disposable k3d setup, enforcing
NetworkPolicies, approved digest-pinned runtime images and existing authorized
model credentials. Prove the private listener is inaccessible by bypassing OCC,
and the native gateway never receives the OCE cookie. Missing dependencies leave
the selected proof incomplete; no fake runtime or skipped case establishes it.

Register new integration files as `*.test.ts` in their owning CI lanes. Update
`scripts/ci/test-suites/qa-matrix.json`, hosted credential selection if needed,
and the advisory QA workflow so the new scenario is actually selected. Keep IdP
and model secrets in their owning processes. Follow test-audit when authoring
the tests. Run lint, typecheck, workspace isolation, scoped formatting, OpenAPI
generation/checks and documentation checks for the eventual implementation.

## Delivery record

The working implementation includes automatic shared cookies, OIDC/native
composition, exact-Agent access modes, restricted Compute routing, socket
revalidation and ordinary-owner browser setup. Current behavior is documented
in [Agent browser access](../../docs/reference/agent-native-admin.md) and
[authentication](../../docs/reference/authentication.md).

Verification used the pinned OpenClaw source `513c12703ad9`, a controller image
checked against the implementation source, and disposable local arm64 k3d,
PostgreSQL and Keycloak fixtures. It does not establish a production deployment
or qualify an arbitrary released runtime image.

- Real Keycloak sign-in: 6 passed. PostgreSQL OIDC: 11 passed; Console tab binding:
  5 passed; guarded shared-cookie browser proof: 1 passed.
- Exact-Agent access: 15 passed. PostgreSQL session, revocation and dependency
  behavior: 14 passed. Pinned native HTTP, WebSocket and device scope ceilings:
  3 passed, with no skips.
- The complete `oidc-agent-chat-k3d-real.test.ts` journey passed without skips:
  owner and operator Keycloak sign-in, ordinary create/deploy, real model replies,
  incremental streaming, Stop with abort acknowledgement, persisted-session
  reconnect/resume, administrative denials and sibling-Agent denial.
- Existing dedicated and shared embedded native-browser workflows: 2 passed,
  with no failures or skips, including selective withdrawal and session expiry.
- Rebuilt Console stories and a setup walkthrough were inspected. Native GitHub
  screenshots and video provide simulated UI proof; the real journey above
  supplies backend and runtime proof.

Independent code, documentation, dead-code and simplification reviews completed;
accepted findings were fixed and the affected changes reviewed again. See
[PR #5136](https://github.com/openclaw/openclaw-enterprise/pull/5136)
for final verification and PR checks.

No authorized PingFederate test deployment was available; provider qualification
remains unverified. Automatic account creation remains out of scope.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-09: Drafted the OIDC/shared-session and exact-Agent chat plan for human
  review against OCE `8b9b105b6398`; automatic account creation excluded.
- 2026-11-09: Made shared session cookies mandatory, removed cookie configuration,
  and specified automatic domain derivation from Console and Agent hostnames.
- 2026-11-09: Clarified original-session socket binding, limited automatic cookie
  clearance to known scopes, and included development cookie producers in removal.
