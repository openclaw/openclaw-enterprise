---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Native OpenClaw profiles for OIDC users

- **ID:** RFC-0035
- **Created:** 2026-11-10
- **Implementation plan:** [Native profile delivery](../plans/0035-oidc-native-profiles.md)
- **Related:** [OIDC sign-in](0001-oidc-sign-in.md), [OIDC Agent chat](0031-oidc-agent-chat.md), [OIDC enrollment](0032-oidc-account-enrollment.md)

## Summary

Give each OpenClaw Enterprise (OCE) account a distinct native OpenClaw profile
when its user opens an Agent's Control UI. OpenClaw Control Plane (OCC) authenticates the person and
checks current permissions on that exact Agent. The Gateway receives the
verified identity and permitted scope, then applies its native access rules.

Reuse generic OpenID Connect (OIDC) sign-in and the existing OCE session. Identity
follows the OCE Principal, not the login provider: supported sign-in methods
attached to the same account use the same native identity. No second login or
per-person Gateway configuration is required.

**The decision is to delegate identity and request authority to OCC while keeping
profiles in OpenClaw.** This needs a native authentication extension and a
Compute Driver contract change. Both remain proposed and unimplemented.

## Why the current paths are insufficient

[PR #5136](https://github.com/openclaw/openclaw-enterprise/pull/5136) enables OIDC
Agent chat but sends every person as `occ-workspace-files`. Sally O'Malley's
[PR #3049](https://github.com/openclaw/openclaw-enterprise/pull/3049) supports
separate people through an external authenticated ingress with configured
`allowUsers` and `identityScopes`.

We reuse native profiles, but neither path supplies the required admission model:
changing a header alone does not admit new users or grant their WebSocket scopes.
Copying OCE grants into native configuration would create a second permission
directory. The proposed native extension accepts each authorized OCC request
without maintaining that directory or redeploying on access changes.

## Scope

Use existing enrolled accounts and browser-enabled Agents. Account enrollment,
identity attachment, IdP group mapping, and IdP logout retain their existing
owners. Neither [OIDC enrollment](0032-oidc-account-enrollment.md) nor the
[People UI](https://github.com/openclaw/openclaw-enterprise/pull/2596) is required.

Profiles improve attribution and support native per-person features. They do
not isolate an Agent's execution, tools, credentials, or files. Native session
sharing still applies; separate profiles do not promise private conversations.
Preserve machine access and the separately configured external-human ingress.

## Proposal

### One stable identity per OCE Principal

Authentication resolves the verified OIDC provider instance and case-sensitive
subject to an OCE account and Principal. Browser access consumes that resolved
Principal; it does not match people by email, display name, or browser claims.
No provider-specific adapter or additional OIDC scope is needed.

Derive a stable opaque subject from Installation ID and Principal ID. It survives
email edits, supported identity attachment, reconnects, and redeployment. A new
Principal gets a new subject. Keep its namespace independent of credentials and
Agent revisions. The [plan](../plans/0035-oidc-native-profiles.md#identity-and-transport-contract)
specifies the encoding.

Each Gateway creates or reuses its own profile for that subject. Native profile
IDs are local to the Gateway; they need not match across Agents. Preserving the
profile requires retaining its native storage. Add a typed external identity
binding with atomic uniqueness, separate from email aliases. Email linking,
reassignment, and profile merges must not conflate different OCE Principals.
Do not add an OCE-to-native-profile database table or rewrite old shared-machine
attribution. Optional display names are presentation only.

This binding is an internal mapping from an OCE Principal identity to a native
profile, not a user-managed alias. OpenClaw already supports sign-in aliases and
profile merges; reuse its profile machinery where suitable without exposing a
second account-linking workflow. Multiple OIDC identities must first attach to
the same OCE account through OCE's authenticated linking workflow. They then
resolve to the same native profile. User-editable identity bindings and native
merges between different OCE Principals are outside this feature.

### Authorize one browser request end to end

1. **OCC** validates the human session, exact-Agent permission, selected revision,
   and Compute ownership using the existing browser admission path.
2. **Compute** resolves private transport for that authorized Principal and mode.
   It owns native encoding, credentials, routing, and runtime capability checks;
   core logic has no Kubernetes-specific branches.
3. **The OCC proxy** removes browser-supplied identity and authority headers, then
   adds the trusted transport values. OIDC tokens and OCE cookies never reach
   the Gateway.
4. **The Gateway** verifies delegation, resolves the profile, and uses the
   delegated scope as both its initial grant and its ceiling. Native roles and
   session rules can narrow it. Device and static identity grants cannot widen it.

| Exact-Agent permission          | Native authority                                  |
| ------------------------------- | ------------------------------------------------- |
| `administer`                    | `operator.admin`                                  |
| `operate`, without `administer` | `operator.sessions.write`, including session read |
| Neither, or a service API key   | No browser admission                              |

Apply the same identity and authority rules to HTTP and WebSocket traffic.
Profile resolution must succeed before protected access. Delegated connections
must not issue reusable device credentials or enroll administrator devices.
Distinct profiles do not add permissions for personal model accounts or other
features outside the selected scope.

### Authenticate OCC independently of external ingress

Enable delegation during preparation of a browser-enabled revision on a qualified
runtime. Use a separate credential for that Agent revision, owned and cleaned up
by Compute. A distinct private browser route carries it from OCC to the Gateway
under the existing TLS, service-key, and exact-peer network controls. The
credential authenticates OCC's authority to assert a person; it does not identify
that person itself.

The native verifier requires the revision credential, a valid reserved subject,
and an allowed scope together. An external ingress trusted for static users must
not be able to assert an OCE identity. Reserve OCE subjects across every native
authentication path; missing or invalid delegation must never fall back to
static, device, password, or machine authentication. Retain static `allowUsers`
and machine grants for their existing paths, without wildcard human admission.

Create credentials during revision preparation, reuse them on retries, and
invalidate them with retirement. Never create replacements during browser
admission. Keep credentials out of browser responses, Configurations, audit
records, and logs. The plan owns header names, Secret delivery, and cleanup steps.

Unsupported Drivers or runtimes report `unsupported`; unavailable credentials,
IAM, or profile storage refuse access. Do not silently open the shared-machine UI.
No additional end-user mode selector is needed.

### Retain authority throughout a connection

Reuse OCC's original-session WebSocket binding and its 25-second authorization
lease with a 5-second check timeout. Session expiry, revocation, changed mode,
or revision replacement closes the socket. Reconnect requires fresh admission;
new grants and regrants require no native roster update or deployment.

Native RPC and subscription checks must also recognize delegated authority.
Native role, delegation-policy, or credential changes must stop affected
protected operations and event delivery; OCC's lease cannot detect those native
changes. Keep the profile in native creator/sender attribution and the Principal,
subject, Agent, revision, and mode in OCC's connection audit.

Removing access retains profiles and prior attribution. Closing a connection
does not cancel already accepted work. IdP disablement retains the existing OCE
session policy; this feature adds no IdP revocation deadline.

## Acceptance Criteria

The [verification plan](../plans/0035-oidc-native-profiles.md#verification) pairs
these requirements with real dependencies and checks; none has run for this draft.

- **AC-1 — Stable people:** Two enrolled OIDC users open one Agent and receive
  distinct profiles and creator/sender attribution. Reconnect, email change,
  and restart with retained storage preserve them. Sign-in methods attached to
  one OCE account resolve the same subject. Concurrent first use yields one profile.
- **AC-2 — Correct authority:** An operator completes a real model turn but cannot
  invoke administrative HTTP or WebSocket operations. An administrator retains
  admin access subject to managed mode and native policy. Unauthorized users
  cannot enter, including users authorized only for another Agent.
- **AC-3 — No alternate admission:** Spoofed headers, external ingress, wrong-revision
  credentials, alternate authentication, and elevated device grants cannot select
  another person's OCE identity or exceed delegated authority.
- **AC-4 — Live access:** Grant, revoke, and regrant without deployment. Verify OCC
  lease closure, native policy enforcement on RPCs and events, and reconnection
  to the same profile with current permissions.
- **AC-5 — Fail closed and preserve other paths:** Dependency or credential failure
  and unsupported runtimes refuse browser access. Machine workspace operations
  and static external-human ingress retain their existing behavior.

## Alternatives and delivery

Keep Sally's external ingress for people without OCE accounts. Requiring it here
would add separately administered authentication and policy. A copied native
roster would require permission enumeration and synchronization; wildcard
admission plus broad device grants would weaken the admission boundary.

Use the [implementation plan](../plans/0035-oidc-native-profiles.md) for the native
extension, Compute integration, and live proof. Submit this RFC for human review
before changing the Driver contract. Qualify the native extension before enabling
OCE delegation. No implementation or acceptance is claimed by this proposal.

## Manual Notes

[keep this for the user to add notes. do not change between edits]
