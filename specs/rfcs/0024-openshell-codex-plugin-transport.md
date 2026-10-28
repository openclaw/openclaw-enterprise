---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Codex plugin startup through a Sandbox transport

## Summary

Extend the Sandbox-provided Harness transport so a dedicated Codex Agent can
install selected plugins without receiving the Gateway's reusable transport
secret. Use a temporary native stdio process for plugin preparation. Before
serving turns, register only the verifier of the Gateway's existing per-start
credential through an authenticated startup endpoint. The Gateway verifies the
serving native process before it becomes ready.

The first caller is a Slack request that reads a specified repository file
through the GitHub app, reads an issue through the Linear app, and returns both
facts in the original Slack thread. The apps retain their account authorization
and selected tool policies. This proposal does not enable protected Git delivery.

## Current behavior and scope

The [OpenShell runtime provider](../../docs/reference/drivers/openshell-sandbox/harness-providers.md)
delivers a transport verifier and nonsecret runtime files. It rejects selected
plugins. Native plugin startup instead needs the Gateway's base token for local
administration, status authentication, and per-start transport derivation. See
[runtime startup](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)
and [OpenShell admission](../../apps/controller/src/drivers/sandbox/openshell.ts).
Removing the admission check cannot connect these protocols.

[RFC-0016](0016-sandbox-credential-injection/index.md) explicitly excluded this
transport work. [RFC-0014](0014-plugin-policy-enforcement.md) owns plugin policy
semantics. This proposal extends transport behavior without changing those
semantics, account grants, or the PluginDriver catalog contract.

Goals are successful selected-plugin startup, authenticated readiness, rejection
of a previous process's transport credential after restart, and complete cleanup
through the existing Agent lifecycle. Provider-owned plugin failure remains fatal.
Ordinary Kubernetes plugin transport retains its current behavior.

Production qualification, protected Git, new platform resources, organization
policy changes, external Driver loading, and credential refresh protocols are
outside this change. Development evidence does not qualify EKS or the shared
OpenShell management/service port for production.

## Ownership and contract

The Sandbox Driver owns exposure, public CA trust, provider identity, adoption,
and removal. A typed capability on `SandboxHarnessEndpoint` identifies the
authenticated startup protocol and its HTTPS control endpoint. It contains no
credential, executable, or operator-selected forwarding target.

Compute owns the transport secret and supplies a domain-separated startup-control
verifier in Harness requirements. Compute and the Agent Gateway derive the matching control
bearer from the existing base secret and Agent revision ID. The control bearer
permits status and verifier registration only; it cannot authenticate a native
app-server connection. Runtime providers contain only its SHA-256 verifier.
Compute consumes this capability without an OpenShell-specific branch in OCC.

The existing trusted Harness launcher owns plugin preparation and the native
child process. A small HTTP/WebSocket front door owns control authentication
and forwarding to one fixed loopback native endpoint. It does not retain the
base secret or introduce a persistent local native bearer. Compute registers and verifies candidate transport before Gateway cutover.
The Gateway supervisor repeats readback at cutover and registers replacement
processes during same-revision restart. Both callers derive the same verifier,
so their concurrent identical registrations are idempotent.

## Startup protocol

1. The Harness creates a fresh startup ID and clears readiness before accepting
   any request. It restores the saved managed configuration and starts a temporary
   Codex app-server over stdio. Existing installation, app ownership, tool identity,
   authentication, and policy checks run through that private transport. The
   launcher closes stdio, terminates and reaps the preparation process, and
   confirms that no bootstrap server or administrative channel survives before
   starting the serving process.
2. Authenticated status reports `awaiting_transport`, with the Agent revision ID,
   startup ID, configuration identity, and complete plugin outcomes. This state
   cannot serve turns. Missing apps, unknown policy, or preparation failure reports
   failure rather than dropping a selected plugin.
3. Before first deployment or candidate cutover, Compute reads this status
   through the Sandbox Driver. It computes the existing per-start HMAC bearer from its base secret, revision
   ID, and the reported startup ID. It sends only that bearer's SHA-256 verifier
   to the authenticated registration endpoint.
4. Registration must name the current revision, startup, and configuration. Accept
   one verifier for that startup. An exact duplicate is idempotent; a different
   verifier, stale startup, or mismatched configuration fails. Registration cannot
   supply a URL, port, command, configuration edit, or other operation. Status
   includes the registration state and accepted verifier digest. A conflicting
   request cannot replace that verifier or restart the native child.
5. The launcher starts the serving native app-server on loopback with that
   verifier. It reports native availability separately from Gateway readiness.
   The front door rejects WebSocket upgrades before this state, then forwards
   their bearer authentication unchanged. Native Codex checks the verifier.
6. Compute authenticates and verifies the serving native process through the
   Sandbox contract before permitting candidate cutover. The Gateway then connects
   with the same derived bearer and rechecks the loaded policy, selected plugins,
   and app mapping. After starting its ordinary native Gateway, its supervisor
   rereads authenticated Harness status before publishing readiness. The report
   identifies its own startup separately from the verified Harness startup,
   configuration, and plugin outcomes. Compute compares these with the current
   provider observation before activation. Temporary-process readback alone does
   not establish final-process readiness.

Compute prepares the candidate while the serving predecessor retains its Gateway
endpoint. Candidate preparation must not depend on redirecting that Gateway.
For a same-revision Harness restart, registration occurs before the Gateway
supervisor's ready wait. Both rules prevent a circular wait.

## Security, failure, and restart

Authenticate every exported status and registration request. Use the existing
public CA projection with certificate and hostname verification. Permit only the
Gateway and existing authorized control-plane consumers. Do not expose private
unauthenticated status routes. Do not forward the control credential to Codex.
Reject control bodies above 4 KiB, apply a 10-second request deadline, and allow
at most one registration in progress per startup. Reject unknown fields.

The base and derived native transport credentials are not provisioned into
Harness environments, runtime-provider files, or disk. The trusted Gateway
retains its required credentials. The derived bearer crosses the verified
WebSocket path as required by native authentication.
Authorization headers, registration bodies, and native auth files must never
enter logs or diagnostics. The front door forwards only to its fixed local
server, with bounded buffers and connection cleanup; it is not a general proxy.

On Harness restart, discard registration and generate a new startup ID before
opening the listener. Old transport credentials must fail immediately. The
Gateway's existing peer-change handler closes its old serving path, repeats
registration and final-process checks, then restarts its native Gateway. A
Gateway-only restart may adopt the current startup only after authentication and
readback. Conflicting registrations fail closed.

Preparation failure or native exit stops readiness and closes transport. If
remote final-policy validation fails, Compute withholds activation and retires
the failed candidate through the existing lifecycle; the Gateway closes its
serving path. Closing a client connection alone does not close the listener. An uncertain registration is resolved by authenticated status; the
caller never guesses which verifier is active. Deletion removes the Sandbox
before runtime providers through the existing cleanup owner.

The Credential Gateway must support only the native plugin catalog, bundle, and
app routes actually required by the selected runtime. Account grants and native
managed policy still apply. Do not replace source-scoped credential injection
with a raw PAT in the Harness, or broaden filesystem/network policy without
source-backed requirements and negative checks.

This protocol does not establish new protection against arbitrary same-identity
process-memory access or hostile runtime replacement. Those guarantees belong
to the managed-runtime and Sandbox boundaries. Their limitations remain explicit.

## Delivery and verification

Submit this RFC before implementing the Driver behavior. Add a separate
implementation plan for transport, native plugin startup, policy/network wiring,
and real workflow proof. Update the owning runtime flow and current references
with implementation; keep this proposal marked unimplemented until then.

Required integration evidence includes:

- Real native stdio preparation and serving-process readback through the regular
  Agent deployment caller, including unavailable apps and conflicting policy.
- Wrong, absent, stale, and cross-revision control authentication; conflicting
  registration; wrong TLS trust; native exit; and Gateway/Harness restarts.
- Candidate redeployment while its predecessor keeps serving, including candidate
  failure that preserves the predecessor and identical concurrent registrations.
- Rejection of the old bearer before new startup readiness, with policy checks
  repeated for the replacement process.
- Model-command attempts to discover transport bearers or connect without
  authorization, while preserving Landlock and default-deny networking.
- One real Slack request reaching the OpenShell-backed Codex Agent, both app
  reads by that Agent, and a correct reply in the original thread. Capture image
  digests, resource/turn/tool identities, sanitized results, and the permalink.

No implementation or live selected-plugin proof is claimed by this RFC.

## Alternatives

Giving the Harness the base transport token would undo the existing separation.
A persistent random loopback bearer introduces a new secret-protection boundary
inside a same-identity workload. Neither is selected.

Compute could sign verifier releases through its existing protected-egress
enrollment. The proposed direct registration instead reuses the existing
transport secret and avoids a new signer dependency. Allowing only the serving
Gateway to register would deadlock candidate preparation; Compute must prepare
candidates while the predecessor keeps serving.

Keeping the current refusal is correct until the complete protocol and required
integration evidence exist.
