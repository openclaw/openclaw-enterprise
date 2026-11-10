---
rfc: ../rfcs/0035-oidc-native-profiles.md
---

# Implementation plan: Native profiles for OIDC users

- **ID:** RFC-0035
- **Delivery status:** Planned
- **Authority:** [Native profile proposal](../rfcs/0035-oidc-native-profiles.md)
- **Source baseline:** OCE `c14307588e886e417f750dc3cd43fef1524af3ec`; native OpenClaw `513c12703ad9a9161cc123e0b8ed4ecb811aa6b3`

## Outcome and scope

An enrolled generic OIDC user opens an Agent through OCC and receives a stable
native person identity with live OCE authorization. A second user receives a
different identity. Implement the RFC's AC-1 through AC-5 through the normal
create, deploy, sign-in, and Control UI workflow. Keep all steps incomplete until
their required proof passes.

This plan depends on submission of its RFC before Compute contract changes and
on new native delegated authentication before activation. It does not depend on
the proposed OIDC enrollment feature or the People UI PR. Use existing enrolled
accounts for the first proof. No deployment or code changes are authorized by
writing this plan.

## Identity and transport contract

The proposed subject is `oce:v1:` followed by lowercase hexadecimal SHA-256 of
UTF-8 `JSON.stringify([installationId, principalId])`. Use the server-resolved
IDs exactly; do not lowercase OIDC subjects or concatenate ambiguous strings.
Every supporting Compute implementation must use this encoding. Native binding
uniqueness uses the fixed authority namespace `oce` plus that subject, independent
of revision, credential, and proxy address. Use native persistence constraints
to resolve concurrent first use to one profile.

Propose this optional asynchronous Compute method:

```typescript
getGatewayBrowserRequest(
  revision: AgentRevision,
  access: {
    principalId: string;
    mode: "chat" | "admin";
    displayName?: string;
  },
  signal: AbortSignal,
): Promise<GatewayBrowserRequest | undefined>;
```

Its private result carries the endpoint and sensitive request headers, never a
browser-visible API response. Call it only after exact-Agent authorization and
revision ownership checks. Absence means unsupported; dependency errors propagate
to the existing unavailable response. It must not create or update native profiles
or credentials; profile creation belongs to authenticated Gateway admission.

Kubernetes prepares a random 32-byte credential in an AgentRevision-owned Secret.
The API-side adapter reads it; only the selected Gateway mounts it. The proposed
headers are `x-occ-browser-key`, `x-occ-identity`, and `x-openclaw-scopes`.
Require an exact supported scope set and constant-time credential comparison.
Reject duplicate, malformed, or wrong-revision inputs without fallback. Use no
model credential, session secret, workspace password, or shared routing key.

An optional account display name initializes a new profile but does not overwrite
native edits. Otherwise use a neutral label with a short subject suffix. Forward
neither email addresses nor remote avatar URLs. Display names never select an
binding. No OIDC tokens, provider credentials, or OCE cookies enter this transport.

## Contract and source touchpoints

| Owner              | Current source and planned change                                                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication     | [OIDC provider](../../apps/controller/src/auth/oidc.ts) and [authentication](../../apps/controller/src/auth/index.ts): reuse verified account/Principal resolution; expose optional account presentation without forwarding token claims.                                                                                         |
| OCC                | [Agent browser authorization](../../packages/occ/src/index.ts): retain exact-resource mode selection and revision ownership; call the new contract only after authorization.                                                                                                                                                      |
| Compute contract   | [Compute Driver](../../packages/contracts/src/drivers/compute/index.ts), [public exports](../../packages/contracts/src/index.ts), and [core Driver contract](../../packages/occ/src/driver-contract.ts): declare optional delegated-browser capability and internal transport result.                                             |
| API and proxy      | [Native HTTP](../../apps/controller/src/http/native-admin.ts), [proxy](../../apps/controller/src/gateway/native-admin-proxy.ts), and [browser configuration](../../apps/controller/src/gateway/native-admin.ts): propagate server-selected authority, sanitize headers, retain socket leases, and remove admin device enrollment. |
| Kubernetes Compute | [Implementation](../../apps/controller/src/drivers/compute/kubernetes/index.ts): prepare credential/configuration, enforce private route ownership, resolve sensitive transport context, and clean up retired revision credentials.                                                                                               |
| Native OpenClaw    | Pinned sources listed below: extend authentication, typed identity bindings, authority calculation, and live connection policy.                                                                                                                                                                                                   |

Native sources inspected at the pinned revision:

- [Trusted-proxy authentication](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/src/gateway/auth.ts) currently checks static `allowUsers`.
- [Connection scopes](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/src/gateway/server/ws-connection/connect-admission.ts) combine device and identity grants, then cap them.
- [WebSocket profiles](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/src/gateway/server/ws-connection/connect-user-profile.ts) and [HTTP profiles](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/src/gateway/http-auth-user-profile.ts) resolve generic proxy identities through email aliases today.
- [Native connection policy](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/src/gateway/auth-policy.ts) needs delegated authority checks, not static allowlist snapshots.

## Implementation

### 1. Establish native delegated authentication

- [ ] Submit the RFC and agree on the native contract with Gateway maintainers.
      Define configuration parsing, reserved subject grammar, secret-file reads,
      duplicate-header rejection, and exact chat/admin scope allowlists.
- [ ] Implement authentication after trusted-peer validation. A valid per-revision
      credential selects delegation; a reserved subject without it always fails.
      Keep credentials local to the receiving Gateway and redact them at logging
      boundaries. Do not issue device tokens from this path.
- [ ] Add native external identity bindings with atomic uniqueness, no email
      equivalence, and no reassignment or cross-Principal profile merges. Reuse
      native profile persistence and creator/sender attribution. Handle concurrent
      HTTP and WebSocket first use and failure before any protected operation.
      Keep account linking in OCE; add no user-facing alias API or native linking
      workflow for these bindings. Existing native alias and merge operations
      must not reassign them to a different OCE Principal.
- [ ] Use delegated scope as grant and cap, then intersect native role and session
      policy. Cover HTTP, WebSocket RPC, subscriptions, reconnect, and native
      policy/credential invalidation. Never reuse device-token fallback.
- [ ] Qualify the native listener before changing OCE's runtime pin. Follow
      [runtime image verification](../../.agents/skills/local-dev/references/image-version-verification.md)
      for both supported architectures and required images. Missing proof blocks
      activation; a source commit alone is insufficient.

### 2. Deliver the contract through Compute

- [ ] Add the method above and typed private result; export public types
      through the top-level index. Core passes Principal and mode, while Compute
      owns native subject encoding, headers, credential loading, and endpoint
      construction. Unsupported Drivers return no capability.
- [ ] During revision preparation, create or reuse the owned delegation Secret,
      render its native configuration, and mount it only in the Gateway. Keep
      mutable credentials out of Configurations and serialized Agent revisions.
      Validate Secret ownership before reads and cleanup. Missing state on access
      is an error, not permission to issue a replacement credential.
- [ ] Add the private browser route on the existing Gateway infrastructure. Bind
      it to the exact Agent/revision endpoint and authenticated OCC transport;
      preserve delegation headers there only. Strip them on OCE-owned machine
      and node paths. External ingress remains operator-owned: its contract must
      prohibit delegation credentials and reserved subjects, with native
      authentication enforcing that boundary. Preserve existing TLS, service-key,
      and NetworkPolicy checks. Make retirement invalidate both route and credential.
- [ ] Separate delegated browser configuration from static external-human policy.
      Preserve `occ-workspace-files` and explicit external users. Remove the
      browser helper's admin device grant; qualification must prove existing
      workspace and machine administration still work.

### 3. Connect normal OCE browser access

- [ ] Extend the private proxy context with the Compute result after all session,
      IAM, lifecycle, and revision checks. Never accept Principal IDs or native
      credentials from request parameters. Resolve capability without leaking
      credentials in the availability response or persisting them in audit data.
- [ ] Strip browser-supplied headers before setting trusted values on HTTP and
      upgrades. Reject ambiguous duplicates before forwarding. Keep the socket
      bound to its original session, Principal, Agent, revision, and mode.
- [ ] Retain the existing 25-second authorization lease and 5-second check timeout,
      including closure on dependency failure. Do not cache a positive grant
      across sessions or serve another revision's transport result.
- [ ] Keep existing Open chat/Open Agent UI links. New browser connections must
      use delegated profiles once supported; unsupported versions report that
      state rather than using the machine identity. Verify observable native
      attribution with two users, not only OCC audit records.

### 4. Update current documentation at implementation

Update the owning [native access reference](../../docs/reference/agent-native-admin.md),
[Compute contract](../../docs/reference/drivers/compute.md),
[Gateway authentication](../../docs/reference/drivers/kubernetes-compute/gateway-authentication.md),
[native access flow](../../docs/flows/agent-native-admin.md),
[operator guide](../../docs/guides/deploy/native-admin.md), and
[browser proof guide](../../docs/testing/native-agent-browser.md).
Explain delegated versus external-human access and native identity versus OCE
permission. Change the concise claim that OCC browser requests share one native
identity in `docs/design.md` only when delivery changes that architectural claim.
Keep credential and test setup details in their owning pages. Check affected
cheat sheets; generate API documentation only if a public schema changes.

## Verification

Extend existing meaningful suites; register any new integration file as
`*.test.ts` in its owning CI lane. None of these runtime checks ran for this draft.

| Criteria         | Real check and required evidence                                                                                                                                                                                                                                                                                                                                      | Remaining proof |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| AC-1, AC-2       | Extend `oidc-agent-chat-k3d-real.test.ts`: real Keycloak, PostgreSQL, disposable enforcing k3d, qualified native image, two enrolled users, ordinary owner creation/deployment, operator/admin model turns, native creator/sender IDs, reconnect and restart with retained storage. Exercise existing authenticated linking only when available.                      | Not run         |
| AC-1             | Parameterize provider-independent OIDC claim verification: stable `sub` with changed email, equal subjects under different provider instances, distinct case-sensitive subjects, and two methods attached to one Principal. Use the real account/session persistence path; no email-based association.                                                                | Not run         |
| AC-2, AC-3, AC-5 | Extend `runtime-image-native-listener.test.mjs` with real native HTTP/WebSocket requests: scope limits, typed identity binding collision/concurrency, denied admin methods, native roles, wrong or absent credentials, duplicate/spoofed headers, existing paired devices, and static external-human access. Prove no reusable delegated device credential is issued. | Not run         |
| AC-3             | Extend `native-admin-k3d-real.test.mjs`: browser and external-ingress spoofing, wrong Agent/revision credentials, direct network denial, exact route selection, and machine workspace access with real route and workload dependencies.                                                                                                                               | Not run         |
| AC-4             | Use the real OCE sharing and session APIs to grant, remove, regrant, expire, and change mode while sockets are open. Measure closure within 30 seconds; verify new native RPCs and protected events stop. Separately change native roles/configuration and verify native invalidation, then replace the revision.                                                     | Not run         |
| AC-5             | Fail actual credential lookup, native profile persistence, IAM access, and revision availability at their owning integration boundaries. Verify refusal, no machine fallback, preserved profile after recovery, and cleanup limited to owned revision resources.                                                                                                      | Not run         |

Register the complete journey in the existing `gateway-routing` lane and
applicable QA matrix selection. Keep fixtures distinct from live model proof.
Use existing authorized model credentials; report missing infrastructure rather
than substituting a fake runtime. Capture a two-user Control UI walkthrough that
shows identities and conversation attribution. If Console states change, update
and inspect the matching Storybook states and supply the required visual evidence.

Keycloak demonstrates one provider against the generic contract. Other providers
need their own deployment qualification; no PingFederate, Entra ID, or Okta result
is implied. New enrollment policies remain RFC-0032's responsibility.

## Delivery record

Specification only. Native contract, Compute implementation, credential lifecycle,
browser integration, image qualification, and all acceptance proof remain pending.
No public reference claims are changed by this draft.

Documentation review keeps this plan in one page because the native extension,
Compute transport, browser admission, and proof form one dependent delivery
sequence. The shorter RFC owns the decision. Both pages remain below the
2,500-word hard limit.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-10: Drafted the delegated native-profile contract and implementation sequence from OCE `c14307588e` and native `513c12703a`.
- 2026-11-10: Moved wire and interface details from the RFC into this plan; clarified provider-independent account identity, Gateway-local profile IDs, and read-only transport resolution.
- 2026-11-10: Clarified internal external identity bindings versus native aliases; kept account linking in OCE and excluded user-managed bindings.
