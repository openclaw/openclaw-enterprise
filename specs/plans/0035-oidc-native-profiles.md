---
rfc: ../rfcs/0035-oidc-native-profiles.md
---

# Implementation plan: Native profiles for OIDC users

- **ID:** RFC-0035
- **Delivery status:** In progress; code implemented, final qualification pending
- **Authority:** [Native profile proposal](../rfcs/0035-oidc-native-profiles.md)
- **Source baseline (planning):** OCE `c14307588e886e417f750dc3cd43fef1524af3ec`; native OpenClaw `513c12703ad9a9161cc123e0b8ed4ecb811aa6b3`

## Outcome and scope

An enrolled generic OIDC user opens an Agent through OCC and receives a stable
native person identity with live OCE authorization. A second user receives a
different identity. Implement the RFC's AC-1 through AC-5 through the normal
create, deploy, sign-in, and Control UI workflow. Implementation completion and
remaining qualification are recorded separately below.

The RFC was submitted before Compute contract changes. Native delegated
authentication is implemented; runtime qualification remains open. It does not depend on
the proposed OIDC enrollment feature or the People UI PR. Use existing enrolled
accounts for the proof. Writing this plan alone did not authorize implementation.

## Identity and transport contract

The subject is `oce:v1:` followed by lowercase hexadecimal SHA-256 of
UTF-8 `JSON.stringify([installationId, principalId])`. Use the server-resolved
IDs exactly; do not lowercase OIDC subjects or concatenate ambiguous strings.
Every supporting Compute implementation must use this encoding. Native binding
uniqueness uses the fixed authority namespace `oce` plus that subject, independent
of revision, credential, and proxy address. Use native persistence constraints
to resolve concurrent first use to one profile.

The optional asynchronous Compute method replaces `getGatewayChatEndpoint`:

```typescript
getGatewayBrowserRequest(
  revision: AgentRevision,
  access: {
    installationId: string;
    principalId: string;
    mode: "chat" | "admin";
  },
  signal: AbortSignal,
): Promise<{
  endpoint: string;
  subject: string;
  headers: Readonly<Record<string, string>>;
} | undefined>;
```

Installation and Principal IDs are server-owned inputs. The result carries the
endpoint, non-secret delegated `subject` for audit attribution, and sensitive
request headers. It is never a browser-visible API response. Call it only after exact-Agent authorization and
revision ownership checks. Absence means unsupported; dependency errors propagate
to the existing unavailable response. It must not create or update native profiles
or credentials; profile creation belongs to authenticated Gateway admission.

Kubernetes prepares a random 32-byte credential in an AgentRevision-owned Secret.
The API-side adapter reads it; only the selected Gateway mounts it. The
headers are `x-occ-browser-key`, `x-occ-identity`, and `x-openclaw-scopes`.
Require an exact supported scope set and constant-time credential comparison.
Reject duplicate, malformed, or wrong-revision inputs without fallback. Use no
model credential, session secret, workspace password, or shared routing key.

The first implementation uses a neutral native label; it does not transport an
account display name, email address, or remote avatar URL. No OIDC tokens,
provider credentials, or OCE cookies enter this transport.

## Contract and source touchpoints

| Owner              | Planned source changes                                                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication     | [OIDC provider](../../apps/controller/src/auth/oidc.ts) and [authentication](../../apps/controller/src/auth/index.ts): reuse verified account/Principal resolution without forwarding token claims.                                                                                                                               |
| OCC                | [Agent browser authorization](../../packages/occ/src/index.ts): retain exact-resource mode selection and revision ownership; call the new contract only after authorization.                                                                                                                                                      |
| Compute contract   | [Compute Driver](../../packages/contracts/src/drivers/compute/index.ts), [public exports](../../packages/contracts/src/index.ts), and [core Driver contract](../../packages/occ/src/driver-contract.ts): declare optional delegated-browser capability and internal transport result.                                             |
| API and proxy      | [Native HTTP](../../apps/controller/src/http/native-admin.ts), [proxy](../../apps/controller/src/gateway/native-admin-proxy.ts), and [browser configuration](../../apps/controller/src/gateway/native-admin.ts): propagate server-selected authority, sanitize headers, retain socket leases, and remove admin device enrollment. |
| Kubernetes Compute | [Implementation](../../apps/controller/src/drivers/compute/kubernetes/index.ts): prepare credential/configuration, enforce private route ownership, resolve sensitive transport context, and clean up retired revision credentials.                                                                                               |
| Native OpenClaw    | Pinned sources listed below: extend authentication, typed identity bindings, authority calculation, and live connection policy.                                                                                                                                                                                                   |

Historical native observations at the planning baseline:

- [Trusted-proxy authentication](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/src/gateway/auth.ts) currently checks static `allowUsers`.
- [Connection scopes](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/src/gateway/server/ws-connection/connect-admission.ts) combine device and identity grants, then cap them.
- [WebSocket profiles](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/src/gateway/server/ws-connection/connect-user-profile.ts) and [HTTP profiles](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/src/gateway/http-auth-user-profile.ts) resolve generic proxy identities through email aliases today.
- [Native connection policy](https://github.com/openclaw/openclaw/blob/513c12703ad9a9161cc123e0b8ed4ecb811aa6b3/src/gateway/auth-policy.ts) needs delegated authority checks, not static allowlist snapshots.

## Implementation

Code steps are complete. The first checkpoint remains open because maintainer
contract agreement is not recorded; RFC submission alone does not establish it.
Final runtime qualification remains open.

### 1. Establish native delegated authentication

- [ ] Submit the RFC and agree on the native contract with Gateway maintainers.
      Define configuration parsing, reserved subject grammar, secret-file reads,
      duplicate-header rejection, and exact chat/admin scope allowlists.
- [x] Implement authentication after trusted-peer validation. A valid per-revision
      credential selects delegation; a reserved subject without it always fails.
      Keep credentials local to the receiving Gateway and redact them at logging
      boundaries. Do not issue device tokens from this path.
- [x] Add native external identity bindings with atomic uniqueness, no email
      equivalence, and no reassignment or cross-Principal profile merges. Reuse
      native profile persistence and creator/sender attribution. Handle concurrent
      HTTP and WebSocket first use and failure before any protected operation.
      Keep account linking in OCE; add no user-facing alias API or native linking
      workflow for these bindings. Existing native alias and merge operations
      must not reassign them to a different OCE Principal.
- [x] Use delegated scope as grant and cap, then intersect native role and session
      policy. Cover HTTP, WebSocket RPC, subscriptions, reconnect, and native
      policy/credential invalidation. Never reuse device-token fallback.
- [ ] Qualify the native listener before changing OCE's runtime pin. Follow
      [runtime image verification](../../.agents/skills/local-dev/references/image-version-verification.md)
      for both supported architectures and required images. Missing proof blocks
      activation; a source commit alone is insufficient.

### 2. Deliver the contract through Compute

- [x] Add the method above and typed private result; export public types
      through the top-level index. Core passes Installation, Principal, and mode, while Compute
      owns native subject encoding, headers, credential loading, and endpoint
      construction. Unsupported Drivers return no capability.
- [x] During revision preparation, create or reuse the owned delegation Secret,
      render its native configuration, and mount it only in the Gateway. Keep
      mutable credentials out of Configurations and serialized Agent revisions.
      Validate Secret ownership before reads and cleanup. Missing state on access
      is an error, not permission to issue a replacement credential.
- [x] Add the private browser route on the existing Gateway infrastructure. Bind
      it to the exact Agent/revision endpoint and authenticated OCC transport;
      preserve delegation headers there only. Strip them on OCE-owned machine
      and node paths. External ingress remains operator-owned: its contract must
      prohibit delegation credentials and reserved subjects, with native
      authentication enforcing that boundary. Preserve existing TLS, service-key,
      and NetworkPolicy checks. Make retirement invalidate both route and credential.
- [x] Separate delegated browser configuration from static external-human policy.
      Preserve `occ-workspace-files` and explicit external users. Remove the
      browser helper's admin device grant; qualification must prove existing
      workspace and machine administration still work.

### 3. Connect normal OCE browser access

- [x] Extend the private proxy context with the Compute result after all session,
      IAM, lifecycle, and revision checks. Never accept Principal IDs or native
      credentials from request parameters. Resolve capability without leaking
      credentials in the availability response or persisting them in audit data.
- [x] Strip browser-supplied headers before setting trusted values on HTTP and
      upgrades. Reject ambiguous duplicates before forwarding. Keep the socket
      bound to its original session, Principal, Agent, revision, and mode.
- [x] Retain the existing 25-second authorization lease and 5-second check timeout,
      including closure on dependency failure. Do not cache a positive grant
      across sessions or serve another revision's transport result.
- [x] Keep existing Open chat/Open Agent UI links. New browser connections must
      use delegated profiles once supported; unsupported versions report that
      state rather than using the machine identity. Verify observable native
      attribution with two users, not only OCC audit records.

### 4. Update current documentation at implementation

Completed in the current reference, guide, and flow pages below.

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
`*.test.ts` in its owning CI lane. Record source revisions and per-scenario
results; partial checks do not complete a criterion.

The following is the **2026-11-10 verification checkpoint**. Subsequent results
and final qualification are recorded in
[PR #5323](https://github.com/openclaw/openclaw-enterprise/pull/5323).

[Enterprise run 42913783474](https://github.com/openclaw/openclaw-enterprise/actions/runs/42913783474)
tested OCE `d8f484f01` (merge `d2d227119`) with native `f645d6958`: three cases
passed, one failed, none skipped; all test-file cleanup passed. Real machine
routing, selective sharing withdrawal, and Keycloak owner/operator access passed.
The separate native-admin case verified the missing-Secret refusal and no reissue,
then timed out waiting for the restored page to initialize. Fresh native admission
and document-response checks now precede that initialization check. Its cause
and the remaining recovery, configuration, and revision-cutover checks require
the rerun; no successful recovery is inferred from Secret restoration.

| Criteria         | Real check and required evidence                                                                                                                                                                                                                                                                                                                                      | Checkpoint result                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1, AC-2       | Extend `oidc-agent-chat-k3d-real.test.ts`: real Keycloak, PostgreSQL, disposable enforcing k3d, qualified native image, two enrolled users, ordinary owner creation/deployment, operator/admin model turns, native creator/sender IDs, reconnect and restart with retained storage. Exercise existing authenticated linking only when available.                      | Keycloak owner/operator case passed; final images and native-admin boundary case pending.                                                                              |
| AC-1             | Parameterize provider-independent OIDC claim verification: stable `sub` with changed email, equal subjects under different provider instances, distinct case-sensitive subjects, and two methods attached to one Principal. Use the real account/session persistence path; no email-based association.                                                                | PostgreSQL claim/account/session checks and real linked password/OIDC identity passed.                                                                                 |
| AC-2, AC-3, AC-5 | Extend `runtime-image-native-listener.test.mjs` with real native HTTP/WebSocket requests: scope limits, typed identity binding collision/concurrency, denied admin methods, native roles, wrong or absent credentials, duplicate/spoofed headers, existing paired devices, and static external-human access. Prove no reusable delegated device credential is issued. | Native Gateway/SQLite proof passed (3 files, 6 tests); final composed images pending.                                                                                  |
| AC-3             | Extend `native-admin-k3d-real.test.mjs`: browser and external-ingress spoofing, wrong Agent/revision credentials, direct network denial, exact route selection, and machine workspace access with real route and workload dependencies.                                                                                                                               | Own-key, cross-Agent, edge, machine and network checks reached before separate failure; old-revision replay pending.                                                   |
| AC-4             | Use the real OCE sharing and session APIs to grant, remove, regrant, expire, and change mode while sockets are open. Measure closure within 30 seconds; verify new native RPCs and protected events stop. Separately change native roles/configuration and verify native invalidation, then replace the revision.                                                     | Real selective withdrawal/regrant/expiry and native role/key invalidation passed; live revision cutover pending.                                                       |
| AC-5             | Fail actual credential lookup, native profile persistence, IAM access, and revision availability at their owning integration boundaries. Verify refusal, no machine fallback, preserved profile after recovery, and cleanup limited to owned revision resources.                                                                                                      | Native SQLite refusal/recovery passed. Actual Secret outage returned API 503 and generic Agent-host 403 without reissue; post-restoration UI and later checks pending. |

[Final native focused proof](https://github.com/openclaw/openclaw/actions/runs/42903944982)
passed all six tests, including unchanged-key stability and replacement revocation.
[Normal native PR CI](https://github.com/openclaw/openclaw/actions/runs/42908258641)
passed 54 checks with 26 expected skips and its required gate. The Enterprise
startup lane passed 25 tests, including profile/conversation preservation from
actual pre-delegation `513c127` image state; this is not every stable release.
[Reviewed media](https://github.com/openclaw/openclaw-enterprise/pull/5323#issuecomment-6780910255)
shows owner/operator interaction. Protocol/history assertions establish identity
and authority; a composer badge does not.

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

The RFC was submitted for human review in [PR #5320](https://github.com/openclaw/openclaw-enterprise/pull/5320)
before implementation. [Native PR #196856](https://github.com/openclaw/openclaw/pull/196856)
at `f645d695819d6f05095433578f916a0643f8d37d` and
[Enterprise PR #5323](https://github.com/openclaw/openclaw-enterprise/pull/5323)
contain the code. The verification checkpoint above identifies the tested OCE commit.
Current [native access](../../docs/reference/agent-native-admin.md) and
[Compute](../../docs/reference/drivers/compute.md) documentation own behavior.

The public HTTP API, OCE database schema, IAM actions, and environment variables
are unchanged. Native binding reuses its existing typed identity table; it is
not an OCE database entity or user-managed alias API.

At this checkpoint, native build, required CI, focused reviews, and PostgreSQL
identity/session suites pass. Source verification also passes on AMD64 and ARM64;
final image assembly and startup qualification remain separate. The hosted native
re-review found no code or security issue and accepted the authority-chain proof.
Its remaining hold is the final Enterprise boundary and image qualification.
The Keycloak installation test also requires rerunning after correction of its
stale host-only cookie expectation. The known Codex-token QA issue is waived by
the user, not reported as passed.

[PR #5323](https://github.com/openclaw/openclaw-enterprise/pull/5323) is the record
for subsequent CI, image receipts, media, and review resolution. This checkpoint
does not claim merged source, published images, or a production deployment.

Documentation review keeps this plan in one page because the native extension,
Compute transport, browser admission, and proof form one dependent delivery
sequence. The shorter RFC owns the decision. Both pages remain below the
2,500-word hard limit.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-10: Record completed code and native CI, passing live scenarios, and
  pending final image, native-admin boundary, and review qualification.

- 2026-11-10: Record submitted RFC and in-progress implementation; pass server-owned Installation ID, omit display-name transport, and replace the chat endpoint with delegated browser transport.

- 2026-11-10: Drafted the delegated native-profile contract and implementation sequence from OCE `c14307588e` and native `513c12703a`.
- 2026-11-10: Moved wire and interface details from the RFC into this plan; clarified provider-independent account identity, Gateway-local profile IDs, and read-only transport resolution.
- 2026-11-10: Clarified internal external identity bindings versus native aliases; kept account linking in OCE and excluded user-managed bindings.
