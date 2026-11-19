---
rfc: index.md
---

# Agent-wide Box policy for protected execution

**Status: PROPOSED.** This amendment to [RFC-0023](index.md) proposes an opt-in,
separately named **Agent-wide Box policy** capability. It changes the principal
used to admit a route or credential injection: one authenticated Agent Sandbox,
rather than a particular executable. The capability is not implemented or
qualified, and requires human review.

## Decision

For the initial qualification, an operator may explicitly select Agent-wide Box
policy only in an isolated pilot deployment, when all processes in one Agent
Sandbox may use the same admitted routes and credential injections. Broader
release depends on qualification through the real Agent workflow below.
The Sandbox must contain exactly one authenticated Agent revision and execution
incarnation. Every process in that Sandbox, including a shell, tool, Model Context Protocol (MCP)
server, or compromised subprocess, can use the routes and injections admitted
for that Agent. The policy provides no distinction among those processes. Use
separate Agents with separate Sandbox identities and policies when work needs
different trust or credential access. A compromised tool or MCP server can make
any admitted Git or API operation, spend model quota, or send data through an
allowed route even though it cannot read a raw credential.

Public Box source commit `956764b58f2c5ccb12bb7048fd1ced3d8ca1b5d4` provides
routes per Box; its callback does not identify the executable that originated a
request. Agent-wide policy makes that scope explicit. Admission must never
silently substitute it for an executable-specific requirement or report that it
satisfies one. If an admitted assertion requires a particular executable, the
selected Sandbox must enforce that assertion or refuse admission. A deployment
that does not explicitly select the new capability retains its existing
requirements.

The selected Sandbox Driver must explicitly support this capability, and admission
must check the complete effective policy before provisioning. An authorized
administrator must delegate Agent-wide authority for the route, and credential
injection needs reviewed consumer authority at that same scope. One or more
executable-specific rules cannot authorize an Agent-wide grant. For conflict
detection, an Agent-wide allowance overlaps executable-specific restrictions on
the same route and cannot weaken them. The Box pilot must refuse a policy that
mixes these subjects or contains an executable-specific assertion it cannot
enforce. Missing capability support or any unsupported policy bound also refuses
admission.

Principal granularity is independent of the protection levels in RFC-0023.
Agent-wide policy does not change exact dispatch, online request authorization,
their admission rules, or their evidence requirements. It cannot substitute one
level for another.

## Policy and credential boundary

Box Policy remains the mandatory, unavoidable, default-deny authorizer for Box
network, shell, and filesystem operations. The selected Sandbox authors and
installs Policy from admitted declarations, prevents bypass, and refuses an
absent or unsupported Policy. Declarations and floor restrictions cannot grant
operations; floor restrictions can only deny them.

A Policy permit is necessary but does not authorize credential use. OpenClaw
Enterprise (OCE), its IAM Driver, and applicable repository or source policy
must independently authorize the current Agent, credential source, destination,
port, HTTP method, and path before protected use. The trusted sender must
preserve the admitted request and credential-presentation bounds, verified
upstream TLS, and redirect restrictions. If the selected Sandbox and sender
cannot enforce a required bound, admission must refuse it. An injection cannot
grant a Box operation, widen a route, or authorize another Agent.

The trusted side retains usable credentials, issuer keys, vault contents,
private signing material, and control and release authority. Workload processes
may receive reviewed filesystem grants, public trust material, and opaque
binding-specific placeholders. A placeholder grants neither credential retrieval
nor startup release authority. Sandbox must protect trusted control channels and
prevent workload access to protected material through process state, inherited
descriptors, files or writable aliases, environment, arguments, logs, or network
and proxy control interfaces. Direct upstream, DNS, loopback, and raw-socket bypass must be
blocked.

## Startup, withdrawal, and audit

The [held-start amendment](strands-box-held-launch.md) continues to govern
startup. CredentialProxy delivers the expected policy and credential version to
the exact trusted target and checks every applicable serving copy. Compute may
authorize release only after containment, current delivery, and projection
acknowledgment are established for that startup. Agent-wide admission and a
binding placeholder confer no release authority.

CredentialProxy must deliver policy changes and withdrawal and read back the
effective version from every applicable serving copy before acknowledging them.
Missing, stale, foreign, or ambiguous readback cannot establish success. Expiry,
revocation, or loss of current authorization must refuse fresh protected use;
a lost reply requires reconciliation before recovery. Audit must attribute
admission, protected use, denial, version changes, and withdrawal to the
Agent execution and selected capability without exposing protected material or
claiming executable attribution that Box cannot establish.

## Acceptance criteria

The isolated pilot must use the normal deployed Agent path and the actual Box
callback and trusted injector, with invented credential sentinels and an
independently observed trusted origin:

- Start one authenticated Agent revision and execution incarnation in one
  contained Box. Run two distinct real subprocesses in that same incarnation.
  Both must use the **same admitted route and credential binding**. Have the
  trusted origin distinguish and accept both requests, and independently verify
  that the trusted injector supplied the binding's sentinel for each request.
  Neither subprocess may read or retrieve the sentinel.
- Refuse use by another Agent. Replace the Sandbox and refuse authority from
  the previous execution incarnation. Also refuse a wrong route, destination,
  port, method, or path.
- With Box Policy still permitting the route, revoke its credential binding and
  refuse a fresh request. Separately withdraw the admitted credential policy,
  read back its effective version from every serving copy, and refuse a fresh
  request. Remove Box Policy and verify refusal. With stale or missing delivery
  readback, verify that startup remains held.
- Measure each refusal at the layer that enforces it. For a denied application
  request on an otherwise permitted proxy connection, require zero denied
  application-request bytes forwarded to the origin, zero unauthorized
  credential injections, and zero provider operations. Observe and record TCP
  establishment separately; an allowed TCP connection alone is not an accepted
  application request. For a forbidden destination or port, require no
  connection to that destination or port. Attempt direct egress and require no
  direct connection.
- Attempt access to trusted control and release interfaces from the workload.
  Across all refusal cases, require zero protected-material disclosure, control
  mutation, and unauthorized release. Preserve any stronger connection, dispatch,
  authorization, or evidence requirement of the admitted RFC-0023 protection
  level; the application-layer criterion does not relax it.
- Verify that an executable-only grant cannot authorize Agent-wide access, that
  overlapping restrictions are not weakened, and that the Box pilot refuses
  mixed subjects or unsupported capability before provisioning. Request an
  executable-specific assertion and verify admission refuses it unless a
  separately qualified mechanism enforces it.
  Preserve the existing exact-dispatch and online-authorization acceptance
  cases.

These observations qualify only the tested source, runtime, and deployment.
The [Strands and Box plan](../../plans/0053-strands-box-convergence.md) retains
ownership of implementation and installed qualification.
