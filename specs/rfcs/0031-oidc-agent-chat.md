---
status: Proposed
implementation_status: Implemented
author: kevinlin-openai
---

# Proposal: OIDC sessions and operator access to Agent chat

- **ID:** RFC-0031
- **Created:** 2026-11-09
- **Implementation plan:** [RFC-0031 delivery](../plans/0031-oidc-agent-chat.md)
- **Source baseline:** OCE `8b9b105b6398`; pinned OpenClaw `513c12703ad9`.

## Summary

Allow an enrolled person to sign in through OIDC, open an authorized Agent,
and chat in its browser UI using that OCE session. Remove the rejection of OIDC
with native administration and use one automatically derived shared session cookie.
Extend exact-Agent `operate` to include browser chat. Keep full native
administration behind exact-Agent `administer`.

This proposal changes the session trust boundary and the required meaning of
an IAM action. It is a successor to the relevant restrictions in
[RFC-0001](0001-oidc-sign-in.md),
[RFC-0007](0007-human-federated-sign-in/index.md), and the
[native admin pilot](../plans/31-agent-native-admin-ui.md). Those historical
records remain unchanged. This RFC remains under human review. Implementation
was authorized separately and is recorded below.

<a id="motivation-and-current-behavior"></a>

## Motivation and baseline behavior

At the source baseline, the [OIDC profile](../../docs/guides/deploy/oidc-sign-in.md)
authenticated existing accounts. Production and development composition rejected
OIDC when native administration was enabled; authentication also rejected a shared
cookie domain. The native UI used that shared cookie to authenticate on Agent
hosts. An installation therefore could not combine OIDC sign-in and Agent
browser access.

The baseline native proxy required `administer` and its private route supplied
`occ-workspace-files` with `operator.admin`. Broadening only the OCC admission
check would expose full native administration. Creator ownership from
[PR #4231](https://github.com/openclaw/openclaw-enterprise/pull/4231) lets ordinary
users manage their own resources, but does not create a chat-only native path.

## Scope

Required outcomes:

- An existing OIDC-enrolled account signs in once, opens its Agent and sends,
  streams, stops and resumes chat without entering an OCE password or using a
  deployment-owned session proxy.
- A person with exact-Agent `operate`, but no `administer`, can use chat and
  cannot use native administrative APIs, even through direct requests.
- An ordinary resource owner can enable browser access through the supported
  create, configure and deploy workflow, without Installation administration.
- Existing full native administration and machine workspace access retain their
  authorization and lifecycle behavior.

Automatic account creation, identity attachment, group synchronization, personal
Namespace provisioning and new chat permissions are excluded. Existing account
and IAM provisioning remain prerequisites. Per-person conversation privacy,
personal native identities, IdP-driven logout and new Compute implementations
are excluded. GitHub/Google native-UI qualification is separate work; their
existing composition restrictions remain. OIDC plus local recovery sign-in is
the external-sign-in configuration qualified here.

## Shared OIDC session

OCE browser sessions always use shared-domain cookies. There is no cookie mode
or cookie-domain setting. Remove `agentNativeAdmin.sharedCookieDomain` and
`OCC_AUTH_COOKIE_DOMAIN` from the supported configuration; explicitly reject
these retired inputs instead of silently ignoring an attempted override.

Derive the cookie domain from the configured Console origin and Agent domain:
normalize both DNS names and select their longest common suffix on DNS-label
boundaries. For `console.oce.example.com` and `agents.oce.example.com`, use
`oce.example.com`. Never widen it to `example.com`. Reject IP literals, public
suffixes, an absent common registrable domain, or a missing hostname at startup.
Require HTTPS. Console and Agent DNS names remain deployment inputs, even when
browser access is disabled; disabling access does not change cookie scope.
Local browser development uses HTTPS DNS names with a valid shared suffix.

Account admission, provider-instance checks,
session lifetime, recovery-only password policy, duplicate-cookie rejection and
revocation retain their existing rules.

Use the existing shared session name,
`__Secure-openclaw_occ_shared.session_token`, with `Secure`, `HttpOnly`,
`SameSite=Lax`, `Path=/` and the validated `Domain`. A shared cookie cannot use
`__Host-`. OIDC attempt, receipt and known-device cookies stay host-only on the
Console origin; only the OCE session needs to reach Agent hosts. The callback,
session reader and logout must agree on the active name and scope. Logout
revokes the current session and expires its shared cookie. Do not retain cleanup
for obsolete cookie names or scopes. If stale cookies cause a duplicate-cookie
refusal, the person clears the OCE browser cookies and signs in again. Keep
duplicate-cookie rejection; do not choose one ambiguous cookie.

The shared domain expands trust to every endpoint that receives the cookie.
All matching hosts must terminate at trusted OCE ingress. Agent content remains
on separate origins; preview content remains outside the shared domain. OCC
strips session cookies and native `Set-Cookie` from upstream traffic and retains
the existing service-worker restrictions. Shared-domain cookies lose the
browser-enforced sibling-cookie protection of `__Host-`; exact Origin checks
and duplicate rejection do not restore that property. This is an explicit
deployment boundary, not a claim of equivalent isolation. Operators control it
through the Console and Agent hostnames, not a separate cookie override.

Console login, callback/result handling and account mutations keep their exact
Console-origin rules. Agent HTTP mutations and WebSocket upgrades require their
exact derived Agent origin. Same-site siblings are not interchangeable trusted
origins. Adapt native-host session admission without adding Agent origins to
the Console mutation allowlist or bypassing guarded PostgreSQL session checks.

## Agent authorization and native enforcement

The selected IAM Driver remains the authority for exact resource permissions
and Restrictions. No new action or automatic grant is introduced. Existing
`operate` grants intentionally gain chat access; operators must assess those
grants before enabling browser access.

| Exact-Agent authorization       | Browser access                           | Effective native scope ceiling  |
| ------------------------------- | ---------------------------------------- | ------------------------------- |
| `administer`                    | Full native UI, including chat           | Existing administrative profile |
| `operate`, without `administer` | Chat and supported conversation controls | `operator.sessions.write`       |
| Neither; including `read` alone | Denied                                   | None                            |

Namespace/Agent discovery retain their existing read checks. Direct Agent-host
admission uses the exact action above and grants no other OCE resource access.
If both actions are allowed, select administration. An unavailable IAM decision
fails closed; it is not permission to try a weaker path.

OCC selects the access mode and trusted private endpoint after authenticating
the person. Add optional
`ComputeDriver.getGatewayChatEndpoint(revision): string | undefined` beside
`getGatewayEndpoint`. The new member returns an exact private WSS base whose
HTTP equivalent serves the same restricted UI. It is available only for a
revision with qualified chat enforcement. Undefined means unsupported; callers
must never substitute the administrative endpoint. The existing endpoint and
machine callers keep their meaning.

Kubernetes Compute owns the additional private route and native configuration.
Use a route prefix disjoint from administrative routes, map it only to the
selected Agent, and retain the existing service-key and network admission.
The route overwrites identity and scope headers with the existing shared native
identity and a ceiling of `operator.sessions.write`. The administrative route
retains its current ceiling. Both routes require the scope header at the native
listener. Browser headers, `connect.scopes`, paired-device grants and native
credentials must not widen the route's ceiling, including on HTTP endpoints.

The pinned runtime documents
[session scopes](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/docs/gateway/operator-scopes.md).
Reuse its scope-aware UI and server enforcement instead of a new raw-WebSocket
method filter. Qualification must establish effective scope intersection,
not merely header delivery. An image that lacks this enforcement is unsupported
for chat access; do not fall back to `operator.write` or `operator.admin`.

Session writing includes conversation history and supported session controls.
It does not grant general diagnostics, configuration changes, credential
management, pairing, approvals or Gateway-wide tool invocation. Chat still runs
the Agent's configured tools and can cause their authorized effects; this is
not a read-only Agent. Native session features such as permitted workspace
operations retain their native policy. The shared identity means this proposal
does not promise private conversations between people sharing an Agent.

## Browser workflow and lifecycle

The Console shows **Open chat** to an operator and **Open Agent UI** to an
administrator, based on server-reported access. Status, copied-link recovery,
HTTP admission and WebSocket admission use the same mode selection. UI hiding
is presentation; native scope enforcement is the boundary.

Expose only the non-secret browser-access capabilities needed by an ordinary
Agent creator. Enabling access in a draft uses existing Configuration/Agent
write and deploy permissions. Derive hosts, routes and authentication settings
on the server. `operate` alone cannot configure, provision or deploy an Agent;
its existing permission to stop an Agent is unchanged. Do not broaden every
guided-provisioning operation merely to enable UI.

Bind each socket permanently to its admitted OCE session, Principal, Agent,
revision and access mode. Keep the existing 25-second renewal and 5-second
failure timeout. Close within 30 seconds after the admitted session becomes
invalid, including logout or account disablement, or after permission removal,
mode change, revision change or access disablement. Replacing a browser cookie
alone does not invalidate that socket's original session. Reconnect authenticates
the current cookie and selects a new mode; an open socket cannot silently switch
sessions or become a chat socket. Chat does not refresh the OCE session lifetime.
Disconnect does not promise cancellation of already accepted model work.

Admission and closure audits record the real OCE Principal, Agent, revision,
access mode and reason. Cookies, service keys and chat payloads stay out of
those records. Native logs still see the shared identity; this does not claim
per-command human attribution.

## Delivery and review

This RFC was submitted for human review in
[PR #5136](https://github.com/openclaw/openclaw-enterprise/pull/5136) before the
Compute and IAM contract changes. The implementation now follows the current
[Agent browser access](../../docs/reference/agent-native-admin.md) and
[authentication](../../docs/reference/authentication.md) references.

The [plan](../plans/0031-oidc-agent-chat.md#delivery-record) records verification.
Real Keycloak sign-in, ordinary-owner creation and deployment, operator model
replies, streaming, Stop, reconnect and administrative denials passed. Pinned
native-runtime checks also passed, including HTTP, WebSocket and device scope
ceilings. No authorized PingFederate environment was available; that provider
remains unqualified.

Review the derived shared-domain trust boundary, extension of all existing
Agent `operate` grants, and the shared conversation identity. A separate
Agent-scoped session exchange would preserve host-only Console cookies, but is
outside the selected shared-cookie design. A broad native `operator.write`
grant or a UI-only restriction would not provide the selected boundary.

## Manual Notes

[keep this for the user to add notes. do not change between edits]
