---
rfc: index.md
---

# Hold protected startup until the trusted delivery is current

This proposed amendment defines the generic Sandbox and Compute boundary needed by the
[Strands and Box plan](../../plans/0053-strands-box-convergence.md). It extends the
[Installation credential ownership amendment](installation-credential-ownership.md):
the selected TokenService owns credential material and issuance, CredentialProxy owns
versioned delivery, and Compute releases an exact startup only after the Sandbox has
established containment and trusted delivery is current. It adds no delivery profile,
issuer, or Box-specific branch to core Compute.

## Problem and decision

The normal Worker must deploy an Agent without letting its workload run with missing or
stale protection. A trusted companion must be able to hold the workload, report why it
cannot start, accept the admitted projections, and release only the startup that was
checked.

At source commit `962a41087083053b585b477d4791f8aded6a9f4e`, the
[Sandbox contract](../../../packages/contracts/src/drivers/sandbox/index.ts)
provides `harnessStatus` and `enrollHarness`. In
[Kubernetes Compute](../../../apps/controller/src/drivers/compute/kubernetes/index.ts),
preparation checks `providerHarnessReady` before reading provider Harness status. The
[current Pod gate](../../../docs/reference/drivers/kubernetes-compute.md#sandbox-provisioning)
requires exactly one matching live Pod with `Ready=True`. Compute can already report a
validated held failure from a provider-owned Harness after that gate, and protected
enrollment can run before it. Neither behavior lets Compute read a terminal diagnostic
from an unready provider Pod. Main contains no Strands/Box Sandbox implementation.

Add a generic, authenticated observation of the held startup through the selected Sandbox.
Compute may read that observation before conventional Pod readiness, after establishing
the exact target and safe scope for the read. A held observation never means the Pod or
Harness is serving. Activation still requires the normal workload, transport, and routing
checks. Preserve the existing OpenShell readiness and exposure-withdrawal requirements.
[RFC-0024](../0024-sandbox-harness-mode-support.md) concerns OpenClaw mode reporting; it
does not approve Box or Codex support.

## Ownership and release

| Owner           | Required responsibility                                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compute         | Own the Agent revision Pod, storage, placement, lifecycle, generic readiness or refusal, and the decision to sign release. Do not interpret Box internals.                                                                                                                  |
| Sandbox         | Enforce process and network isolation, mandatory egress, private control transport, startup hold, and authenticated observation and release for the exact target incarnation, process instance, and fresh challenge. Its trusted companion implements these duties for Box. |
| TokenService    | Commit the authoritative source value and version, retain issuer keys and refresh grants, and issue or renew usable credentials under the Installation's selected owner.                                                                                                    |
| CredentialProxy | Commit effective policy, deliver the expected version to trusted copies, observe the target copy, and acknowledge a push only after every serving copy can use that version.                                                                                                |
| Harness         | Own the Agent process and its conversation or session after release.                                                                                                                                                                                                        |

The Worker uses the regular Compute preparation path. The selected Sandbox stages a
contained target with credential-using execution held and returns an authenticated
observation bound to the Agent revision, target incarnation, process instance, and fresh
startup challenge. Compute accepts a sanitized terminal failure only from that trusted
route and validates it for the requested revision. Missing, forged, stale, foreign,
ambiguous, or unauthenticated status cannot establish readiness or authorize release.

CredentialProxy prepares the admitted policy and projections and confirms the expected
delivery version on the target and every applicable serving copy. The trusted launcher
acknowledges installation of the reviewed projections for that same startup. Compute
rechecks the current tool, network, proxy, and workload conditions before authorizing
release. Sandbox accepts release only for the bound startup; a transport bearer alone
cannot release it. Compute then confirms authenticated serving status before activation.

Revocation, expiry, replacement, loss of a trusted companion, or an unreadable current
version prevents release and further protected use. A failed push leaves the committed
source version authoritative and does not count as delivery acknowledgement. After worker
loss or a lost reply, observe the current incarnation and delivery state before adopting
or releasing it; do not replay an operation with an unknown effect. A replacement rejects
the previous process's challenge, projections, acknowledgement, and release.

## Trust boundary

Before any privileged launch descriptor is transferred, the trusted installer or runtime
must provide one of two mechanisms:

- An independently trusted binding at each endpoint that lets the launcher authenticate
  the exact authorized receiver incarnation and lets the receiver authenticate the exact
  authorized launcher incarnation on the live connection.
- An independently provisioned, authenticated preconnected channel bound to that exact
  launcher and receiver pair.

Both endpoints must complete this check before descriptor transfer. A matching UID, a
mode-0700 rendezvous directory, a peer-supplied image digest, or a nonce exchanged over the
same unauthenticated socket is insufficient. An observed PID or pidfd is insufficient
without an independently authenticated expected incarnation. Refuse substitute listeners,
foreign first connectors, stale peers, and cross-run connections before sending any
descriptor. The existing Box candidate checks the peer UID and transfers descriptors
before validating anchors; it does not satisfy this requirement. No Kubernetes bootstrap
channel is selected or implemented by this amendment.

The handoff must preserve the supervisor's live authored-configuration and policy file
identities and protections against writable aliases. The workload receives the public CA
only as a read-only grant to the same pinned object; a byte copy does not establish that
identity. Private state, authored files, vault contents, and the CA signing key remain on
the trusted side.

The untrusted workload may receive opaque placeholders with no retrieval or release
authority. It must not receive user secrets, issuer keys, provider tokens, proxy control
credentials, a reusable ingress bearer, or another privileged reusable identity through any
workload-visible surface. Containers in one Pod share loopback, and NetworkPolicy selects
Pods rather than containers. Sandbox must independently isolate trusted control interfaces
and block direct egress, including
loopback and raw-socket bypass. The trusted companion retains the vault and injector. A
separate trusted proxy Pod is a possible later deployment, not a v1 prerequisite.

## Acceptance Criteria

- **AC-1 — Held observation:** Through the normal Worker and selected Compute/Sandbox path,
  stage one contained startup whose Pod is not conventionally ready. An authorized,
  authenticated scoped read reports pending or a validated terminal failure for that
  startup; neither result activates it. Refuse forged, cross-revision, stale-incarnation,
  and replacement reports.
- **AC-2 — Release:** Deliver an admitted version, authenticate the launcher's challenge,
  acknowledge the projections, release that startup, and observe authenticated serving
  status before activation. A missing or stale target copy, one stale serving peer, expired
  or revoked authority, companion loss, or a previous startup's release keeps work held or
  refused. Verify failed push and lost-reply recovery without blind replay.
- **AC-3 — Launch authority:** Through the real launcher and receiver, authenticate both
  exact incarnations before descriptor transfer. Prove that a substitute listener, foreign
  first connector, stale or cross-run peer, and unbound same-UID process receive
  no privileged descriptor. Verify live source identity, writable-alias refusal, the
  read-only same-object CA grant, and cleanup. A nonce exchange alone must not authorize
  transfer.
- **AC-4 — Containment and compatibility:** Extend maintained integration coverage through
  the real Agent workflow. Use invented sentinels to prove workload surfaces and same-Pod
  loopback cannot expose credentials or control authority. Preserve OpenShell's existing
  positive and refusal cases and its conventional readiness gate.
- **AC-5 — Installed qualification:** On clean ARM64 Helm installation, use the exact
  reviewed images and source to complete a real HTTP provider model turn, Git push, and
  draft pull request with independent provider readback. Withdraw Git access, refuse a
  fresh Git operation, and complete another model turn in the same conversation. Record
  real prerequisites and failures separately from fixture and source evidence.

## Delivery, alternatives, and open decisions

Submit this Driver-contract amendment for human review before changing required behavior,
configuration, or interfaces. RFC merge requires a human. Coordinate the exact status and
release contract with v1 push-admission work; select public field names only after the
owners agree on the contract. The installer/runtime owner must define and deliver the
independent launcher bootstrap before Box can implement the descriptor handoff. The Box
candidate, generic observation and delivery work, provider behavior, and installed
qualification remain dependencies or unproved outcomes. Main's
[#6098](https://github.com/openclaw/openclaw-enterprise/pull/6098) changes Sandbox
maintenance cadence, not the Box topology.

Keeping the current fail-closed behavior is safe but leaves a held failure in an unready
provider Pod invisible until the deployment deadline. A global Pod-readiness bypass is
rejected because it could activate an unready or untrusted workload. A separate trusted
proxy can strengthen the network boundary later and requires its own deployment qualification.

## Changelog

- 2026-11-18 — Propose a generic held-start observation and release boundary for TASK-0053.
