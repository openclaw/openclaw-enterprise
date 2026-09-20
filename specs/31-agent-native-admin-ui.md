# Feature Spec: Agent native admin UI pilot

**Date:** 2026-09-19
**Status:** Implemented and locally verified — trusted-operator pilot remains disabled by default; PR review and CI pending.
**Owner:** OCC console, authentication and gateway access; Kubernetes Compute Driver.

## Problem and Decision

Operators need to open an Agent's stock OpenClaw Control UI from OCE. Today the console has no browser access flow; its default configuration disables the UI. Existing private gateway routing serves OCC workspace-file operations using a privileged service identity, not a browser session.

Add **Open native admin UI** for trusted pilot operators. Open the unchanged upstream UI in a new tab on an isolated Agent origin, through an OCC-authorized HTTP/WebSocket proxy. Grant full native operator administration after exact-Agent admission. A visible warning asks operators to manage configuration through OCE; it does not technically prevent native changes.

This is a user-approved pilot exception to the [platform design's per-operation OCC authorization](../docs/design.md): OCC authorizes entering and retaining the admin session, not each native command. OCE still owns its Configuration and immutable AgentRevision records, but native runtime changes may diverge from those records. Do not claim full design conformance, configuration synchronization, per-command platform audit, or differentiated native permissions.

## Scope

- Kubernetes deployments with a verified compatible gateway image, private gateway routing, and separately configured wildcard Agent DNS/TLS.
- Native UI assets, built-in HTTP endpoints and WebSocket traffic needed for the full stock admin experience; no native RPC allowlist or UI fork.
- Existing human OCE sessions, exact-Agent administrator admission, isolated origins, session expiry/revocation, and access-session audit.
- Deferred: ordinary user/read-only access, private conversations, native-to-OCE configuration import, drift detection, non-Kubernetes drivers, external SSO implementation, changes to harness identity, and automatic recovery from arbitrary native modifications.

## Contract

### Admission and user experience

1. An installation operator explicitly enables the pilot and configures its public Agent domain. It is disabled by default. Enabling it grants no user permission and does not silently convert existing Agent configurations.
2. The Agent page shows **Open native admin UI** only when the caller has the existing IAM action `administer` on that exact Agent. The server independently checks the human session, Installation/Namespace admission, selected IAM Driver and applicable Restrictions. `read`, `operate`, possession of an Agent URL, and native device credentials are insufficient.
3. Require an active revision, `desiredRuntimeState: running`, and a supported private gateway endpoint. These establish intended state, not observed readiness: the current console has no serving-status API. Fail closed with an actionable unavailable response if the gateway cannot be reached. Unsupported driver, missing UI/auth configuration, explicitly stopped Agent, denied access or unavailable authorization also fails closed. Do not add a readiness service for this pilot.
4. Before launch, show: **“Native admin access can change this gateway outside OCE. Do not change configuration here; use OCE. Native changes are not recorded in AgentRevisions and may be overwritten by deployment. You can access the conversations and credentials available to this gateway.”** The explicit launch action acknowledges this warning; do not add a durable acknowledgement resource.
5. No per-user session privacy is promised inside the gateway. Native admin can inspect and operate the Agent's exposed conversations, tools and integrations. It does not grant access to another OCE Agent or platform IAM.

### Origin and browser session

OCC derives an opaque host from immutable Installation/Namespace/Agent identity under the configured Agent domain, distinct from the console origin. Hosts are never recycled for another Agent identity, including deletion/recreation. One wildcard listener can serve all hosts. The browser cannot select a target URL, Service, namespace or port. Open at `/` with `noopener`; retain upstream framing protections.

The new Agent-origin tab creates a per-tab verifier and state; an authenticated, CSRF-protected console POST authorizes the selected Agent and issues a code bound to the parent OCE session, principal, host, Agent, active deployment, state and verifier challenge. Callback redemption is a POST requiring the verifier and state, validates current admission, and consumes the code atomically within 60 seconds. GET/prefetch cannot mint or redeem access; opener/referrer are not authentication evidence.

OCC authentication owns these short-lived exchange records in its PostgreSQL persistence boundary. Store only a digest of the redeemable code, expire it after 60 seconds, and provide atomic consume semantics. This is transient authentication state, not a new platform resource. Bound issuance per parent session and remove expired entries opportunistically; no cleanup worker is required.

Successful redemption sets a signed, host-only `__Host-` Secure/HttpOnly/SameSite cookie containing the parent-session reference, exact Agent/deployment binding and expiry. The cookie cannot outlive the parent session and creates no independent durable session. Use the existing auth secret through a purpose-separated signing key; OCC validates the current parent session server-side. Remove callback secrets from browser history/storage, use no-store/no-referrer responses, and never put a gateway token, private route key or parent cookie into JavaScript or a launch URL.

### Proxy, native identity and permissions

Every protected HTTP request and WebSocket upgrade checks the bound parent session and current exact-Agent `administer` permission. Only OCC-owned launch/callback/bootstrap paths are public; those paths never forward to native handlers. Check exact Origin on browser upgrades and mutating requests, reject missing/null upgrade Origin, and preserve the external Origin for upstream verification. Same-site sibling hosts are not trusted origins.

The OCC proxy resolves the current private endpoint through Compute. It strips browser cookies, Authorization, API keys, forwarded identity and scope headers, then supplies the existing private service key server-side. It never follows caller-selected upstreams or forwards credentials across redirects. It strips native `Set-Cookie` and reserves its authentication paths so native handlers cannot overwrite OCC sessions. Ordinary native paths and WS messages pass through without method authorization or payload interpretation. Full admin does not require every optional native plugin or external service to be installed or enabled.

Reuse the existing `occ-workspace-files` native service identity and its administrative grant for this pilot. Envoy validates and strips OCC's private service key, overwrites `x-occ-identity` with that fixed identity, and removes caller scope/forwarding headers as it does today. Apply the same identity and sanitization to UI asset routes. Native authentication uses the configured service identity's `operator.admin` grant; the browser receives no service key. OCC attributes launch and session audit to the actual human, while native logs see the shared identity. Native per-command human attribution and dynamic native user allowlists are deferred.

Keep the existing native trusted-proxy configuration and Compute validation requiring `occ-workspace-files` in `allowUsers` and its admin `identityScopes` grant. Trust only the actual Envoy source and configure the exact external browser Origin. Enable explicit admin device auto-approval for the opt-in pilot on the pinned supported gateway. Browser device state never substitutes for OCC admission. OCC enforces browser Origin independently; OpenClaw also checks its Control UI Origin policy during the native WebSocket handshake.

`ComputeDriver.getGatewayEndpoint(revision)` keeps its existing exact private WSS base, `wss://<private-host>/namespaces/<namespaceId>/agents/<agentId>`, used unchanged by workspace files. For HTTP, OCC substitutes `https` while retaining the trusted authority and Agent base path; for either transport it maps native `/` to that exact base and native subpaths beneath it. OCC validates/canonicalizes suffixes so they cannot escape the selected Agent base, and preserves native query semantics without allowing a query to select an upstream. Kubernetes retains the exact-base rule rewriting to `/` and adds a segment-bounded prefix rule that strips only that Agent base from asset/deep-link subpaths. No new Compute method or endpoint descriptor is required.

Public ingress terminates browser-trusted HTTPS/WSS at the existing OCC API process serving the wildcard Agent hosts. Envoy remains a private ClusterIP service; no public native/Envoy listener or standalone access service is added. OCC verifies private Envoy TLS; the native backend hop remains private and NetworkPolicy protected as in existing routing. Gateway Services have no public listener and accept traffic only from the selected proxy. All human browser access crosses OCC even if native administrators create devices/tokens or change native authentication. Network isolation and proxy credential ownership remain platform-controlled.

Native admin can change configuration, plugins and gateway behavior. The security boundary therefore treats native HTML, headers and scripts as Agent-controlled content: keep the console on a separate domain, enforce host-bound session validation and retain cross-Agent network isolation. Native edits that break the supported auth contract may make the UI unavailable; OCC must not fall back to unauthenticated or shared-token browser access.

### Lifetime, audit and recovery

OCC owns each active socket's authorization lease. Renew current parent-session validity, exact-Agent permission/Restrictions and active deployment identity before the lease exceeds 30 seconds; close on expiry, denial, lookup failure/timeout, Agent stop, deletion or deployment replacement. Every new HTTP request/upgrade gets a fresh check. Accepted native operations may continue after disconnect; this does not cancel jobs. Disabling the pilot denies new access and closes existing sockets within the same bound.

Record actual human principal, Agent/Namespace, deployment revision, admission/denial, connection ID, start/end and closure reason. Do not log cookies, launch codes, native credentials, chat payloads or file contents. Native action logs remain supplemental; full per-command OCE audit is outside this pilot.

OCE never imports native edits or rewrites immutable revision records. Recovery is an OCE deployment of the intended managed configuration, followed by verification. Redeployment is not a factory reset: workspace data, pairing or plugin state may persist and require explicit operator repair. Do not wipe persistent storage automatically. A broken gateway must not prevent an authorized operator from using OCE to stop or redeploy it.

## Implementation

Source baseline: public OCE `19ce9e065e825d406ad665d2df58a11c5605ddb8`; upstream OpenClaw `083b498270124a059db70714b5df93d973391ee0`. These are inspected source snapshots, not runtime proof.

1. Pin and prove gateway compatibility before exposing the button. Verify built UI assets, trusted-proxy admin scope behavior, device auto-approval, all built-in UI traffic and existing harness connectivity. [Upstream token/auth exclusion](https://github.com/openclaw/openclaw/blob/083b498270124a059db70714b5df93d973391ee0/src/gateway/auth.ts#L188-L203) forbids combining trusted-proxy mode with a gateway token. [Device auto-approval is version-dependent](https://github.com/openclaw/openclaw/blob/083b498270124a059db70714b5df93d973391ee0/docs/gateway/trusted-proxy-auth.md#L50-L54). Deploy only an explicit compatible Agent configuration; do not silently change harness authentication or upstream code.
2. Extend [OCC authentication](../apps/controller/src/auth/index.ts), its persistence/migrations and [production HTTP composition](../apps/controller/src/index.ts) with launch/consume handlers, a parent-session lookup, purpose-bound cookie signing and the Agent-origin proxy. Add the warning/button in [console Agent views](../apps/controller/src/console/agents/). Reuse existing exact-resource [IAM](../packages/iam/src/index.ts), audit and API error conventions; centralize browser admission so HTTP and upgrades agree.
3. Preserve optional [ComputeDriver.getGatewayEndpoint](../packages/contracts/src/index.ts) and implement the deterministic HTTP/WS mapping above in the OCC proxy. Extend [Kubernetes private route generation](../apps/controller/src/drivers/compute/kubernetes/index.ts) only for same-Agent asset/deep-link suffixes, retaining the exact WSS route and native service-identity validation. Configure wildcard Agent DNS/TLS on the OCC-facing ingress through [Helm/controller settings](../deploy/helm/openclaw-enterprise/); keep [gateway-routing Envoy](../deploy/helm/openclaw-enterprise/templates/gateway-routing.yaml) private. Use the existing OCC API process; no new generic Driver, platform resource or standalone service.
4. Add connection lease handling and structured admission/closure audit; map revocation and Agent deployment changes to connection closure. Retain current workspace-file and harness paths. Pilot rollback disables the access listener and ends sessions; it does not revert native edits or delete Agent data.
5. Update the [Agent reference](../docs/reference/agents.md), [console reference](../docs/reference/console.md), [authentication](../docs/reference/authentication.md), [gateway routing](../docs/reference/gateway-routing.md) and deployment guide in the implementation change. Record the narrow pilot exception in the platform design and planning architecture then; this spec does not silently rewrite either authority. Document enablement, permissions, warning, native drift, revocation and recovery limits.

## Verification

Implementation acceptance requires real browser and gateway proof; documentation authoring does not run these tests.

| Outcome | Required proof |
| --- | --- |
| Stock full-admin experience | Real browser opens a pinned gateway, serves assets/deep links, reconnects WSS, streams a real chat and performs a reversible native administrative change in a disposable Agent. No upstream UI fork or RPC allowlist. |
| Exact privilege/tenant boundary | Real API/IAM checks deny read/operate-only users, disabled pilot, unsupported/explicitly stopped Agent, and attempts to select another Agent by host/path, escaping suffix or forged identity. Active revision plus running intent never claims observed health; unreachable gateways return an actionable unavailable error. |
| Browser/session protection | Replay, wrong verifier/state/host/Agent, expired code, cross-origin/missing-Origin upgrade, native cookie injection and copied device credentials fail to bypass admission; keys and parent cookies do not reach native/browser-visible output. |
| Revocation | Across two OCC replicas, permission removal, logout/expiry, pilot disablement and Agent replacement close established streams within 30 seconds; failed authorization renewal also closes them. |
| Private gateway and regressions | Real Kubernetes NetworkPolicy denies direct browser/workload bypass. Existing exact-base WSS workspace-file operations remain unchanged; new HTTP asset/deep-link suffixes route only to the selected Agent. Harness/model turns work before and after enabling the pilot. |
| Honest drift/recovery | A native configuration edit leaves the OCE revision unchanged; OCE can stop/redeploy the Agent and restore its managed configuration. Persistent data remains; remaining native-state repair is reported rather than silently erased. |
| Attributable access | OCC admission and closure records identify the human and exact revision; native connections use the shared administrative identity. Logs contain no credentials/content and do not claim native per-command human attribution. |

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-19 08:27: Drafted the user-approved trusted-operator full-admin pilot for trigger:spec review; no implementation or deployment. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 19ce9e065e825d406ad665d2df58a11c5605ddb8)
- 2026-09-19 08:37: Applied approved simplifications: shared native admin identity, OCC-facing public ingress, preserved endpoint with explicit suffix mapping, and existing lifecycle intent. Retained one-use browser-bound launch; no implementation or deployment. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 19ce9e065e825d406ad665d2df58a11c5605ddb8)

- 2026-09-19 22:13: Implemented the approved pilot and completed local real-runtime acceptance: stock browser/chat/edit/reconnect, managed configuration recovery and persistent files, exact-Agent admission, two-replica revocation, private routing and Kubernetes lifecycle. PR review and CI remain pending. (01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 06c23b9cf60915ba58baa38b23cf304562e674a1)
