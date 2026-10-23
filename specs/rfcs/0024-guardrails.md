---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Guardrails for permissions and configuration ceilings

- **ID:** RFC-0024
- **Created:** 2026-10-19
- **Last updated:** 2026-10-23
- **RFC PR:** [#2968](https://github.com/openclaw/openclaw-enterprise/pull/2968)
- **Related:** [shared configuration definitions](0022-driver-configuration-contributions.md), [managed runtime](0021-managed-runtime-mode/index.md)

<a id="decision-and-motivation"></a>
<a id="problem-and-decision"></a>

## Summary

Let a team edit an Agent’s network policy while limiting what it can add. IAM
decides whether the operator may edit at all. A Guardrail can rule out an
otherwise permitted operation or put a ceiling on the values the operator may
choose. It grants no access.

For example, an Installation might allow teams to add Python access to
`api.example.com` on ports 443 or 8443. A Guardrail scoped to the `research`
Namespace can narrow that to port 443. The operator still needs permission to
edit, and adding port 8443 there is refused. Initially, Installation
administrators write both policies; the Namespace is the scope, not the author.

## Motivation

[Sandbox policy](../../docs/reference/sandbox-policies.md) already separates
permission to edit from a startup ceiling on network additions. Its per-Agent
editing switch is temporary. [IAM Restrictions](../../docs/reference/authorization.md)
already narrow permissions but cannot constrain configuration values.
[RFC-0022](0022-driver-configuration-contributions.md) defines the shared Driver configuration contract. The
[existing interface](https://github.com/openclaw/openclaw-enterprise/blob/af7c1bf73b98c4cdefa2e58237f992e561f0e5d1/packages/contracts/src/configuration-definition.ts)
validates a value against its schema and semantic rules. This proposal adds validation
against the ceilings that apply to a particular request.

<a id="scope"></a>

## Goals

Apply every relevant limit at admission and recheck pending work before an
effect. Let editors explain the same limits the API and worker enforce.

## Non-goals

Tightening a ceiling does not inspect, reconfigure, or stop running Agents.
This RFC covers control-plane decisions; [runtime enforcement](0021-managed-runtime-mode/index.md)
depends on the selected Driver. Compliance reporting and delegated Namespace
policy administration are outside this proposal.

<a id="design"></a>

## Proposal

### Architecture

The OpenClaw Control Plane (OCC) stores versioned Guardrails and audits changes.
The selected IAM Driver makes one operation decision, including grants,
Restrictions, and applicable denials. It also identifies which configuration
ceilings apply. Configuration Drivers check values against those ceilings; they
cannot change who is covered. If an authority cannot determine or enforce the
applicable policy, refuse the operation.

### Two kinds of limit

A Guardrail covers either all current and future Namespaces in one Installation
or exactly one Namespace. Scope is immutable. The proposed resource can contain
`policy` rules, `configurations` ceilings, or both. These answer different questions:

| An administrator wants to…                         | Use                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Let an operator edit an Agent’s network policy     | Ordinary IAM grants: `manage_policy` on the Agent **and** `update` on its SandboxPolicy. Without either, IAM already denies the edit. |
| Limit what that operator can add                   | A configuration ceiling, such as Python to `api.example.com:443`. Being inside the ceiling does not itself add the rule.              |
| Prevent edits even when a broader Role grants them | A deny rule for the relevant action and resource kind. Existing Restrictions still apply, including to administrators.                |

Deny rules name existing actions and a resource kind. No wildcard actions,
per-resource filters, or general condition language. Scope and binding selectors
determine whom a rule covers. Whether targeted denials belong in Guardrail or an
extended Restriction is an architecture decision below; either uses the same IAM
decision, not a second authorization service.

### Who a rule covers

Omitting `accessBindings` selects everyone in scope. Otherwise match any selector
and every field within it: subject kind and ID, Role ID, or both. Reject an empty
list and unknown or cross-scope references. Global rules may reference only
Installation-wide subjects, Groups, or Roles.

The draft deliberately considers **all** current bindings of the identity and its
Groups in the Namespace or Installation, including bindings that did not grant
the request. A Role bound on Agent A can therefore select its holder for a deny on
Agent B. Another grant cannot evade the deny. Audit membership changes that remove
a restriction; evidence listing only successful grants cannot establish complete
targeting.

For a shared Configuration save, check the caller. At Agent deployment or policy
application, check the caller and the Agent’s ServicePrincipal, and enforce every
ceiling selected for either. An Agent does not inherit its creator’s identity.

### What fits within a ceiling

A ceiling identifies its configuration capability and target. In the draft,
`driverId` binds the ceiling to the selected Driver’s schema and interpretation;
it does not choose or install a Driver. Reject unsupported targets. When changing
Drivers, validate existing ceilings or refuse the change rather than drop a limit.

Extend the owning RFC-0022 definition to validate the ceiling document, describe
candidate values for editors, and validate the effective candidate against **all**
applicable ceilings. Return the unchanged value or field errors. These operations
are deterministic, have no side effects, and fail closed. Saving a ceiling need
not prove that its intersection with every other ceiling is satisfiable.

- **Sandbox networking.** Every requested executable, host, and full port range
  must fit each ceiling, using the [existing matcher](../../packages/contracts/src/sandbox-policy.ts).
  An empty ceiling permits no additions. A count limit does not bound the reach of
  a wildcard. Driver defaults and generated transport rules are separately owned.
- **Native OpenClaw configuration.** For example, require
  `/plugins/entries/codex/config/appServer/sandbox` to be `read-only` or
  `workspace-write`. Removing a parent cannot evade a required field. Support
  only known paths and assertions, without remote schema references or Secret
  inspection. Reject an incompatible deployment or empty intersection; never
  silently clamp a value or discard an invalid draft.

<a id="ownership-and-enforcement"></a>

### Request lifecycle

1. Resolve scope and authorize the exact operation. This draft lets an actor
   currently authorized to `administer` the singleton Installation bypass all
   Guardrails for that operation, including prerequisite and Agent checks.
   Determine that authority with base IAM and Restrictions, excluding Guardrails
   to avoid recursion. Ordinary grants, startup ceilings, and platform limits
   still bind the administrator; the deployed Agent inherits no exemption.
2. Read current policy and complete IAM targeting consistently. Resolve defaults,
   Presets, overlays, Secret references, and Driver contributions before checking
   the candidate. A template with unresolved values receives its full check at
   materialization. No later transformation may widen the result.
3. Commit only while the policy version remains current. Record matched policy
   generations and the authority for any bypass. A preview is not authorization.
   Before queued work, retries, or rollback take effect, recheck current policy
   and the **original actor’s** current authority, never the worker’s.

A ceiling governs the next configuration change. An operation denial governs the
next authorization decision, including for a running Agent. For example, the
[Credential Proxy proposal (RFC-0023)](https://github.com/openclaw/openclaw-enterprise/blob/af7c1bf73b98c4cdefa2e58237f992e561f0e5d1/specs/rfcs/0023-egress-proxy-credential-lifecycle/index.md)
checks the Agent’s credential-source permission before material access and again
before authorizing a send. A current deny applies at either check; it cannot
recall a send already authorized.

### Administration and transition

Provide Installation and Namespace Guardrail collections. Creation checks the
parent; other operations check the exact Guardrail. Initially, mutations also
require Installation `administer`, plus Namespace `read` where applicable. Policy
cannot block its own repair. Use expected generations for replacement and deletion,
commit policy and audit together, and prevent deletion of referenced IAM selectors.
Deleting a Namespace removes only its own Guardrails.

Show authorized editors global and local limits, what constrained a field, and
any administrator bypass. Full policies require Guardrail read permission. The
view explains admission limits, not compliance of an existing deployment.

Keep the startup network ceiling. Deny delegated editing by default on a fresh
Installation. On upgrade, retire the per-Agent editing switch and old write path
together, once intended access is preserved or explicitly changed. Two Agents can
have opposite switch settings for an operator with identical grants. Recheck
pending work, and establish the outcome of a possibly applied change before
issuing another. Removing a deny still grants nothing.

## Delivery and verification

Plan implementation after architecture review. Through the real API, IAM, state,
worker, and qualified runtime, demonstrate the port-narrowing example, an alternate
grant that cannot evade a deny, and an administrator who loses the exemption
while work is queued. Tightening alone leaves a running Agent unchanged; its next
out-of-bounds save or apply fails. A denial committed between Credential Proxy’s
two checks yields no send permission or provider request. Include mixed editing
settings and an uncertain prior application in the cutover proof.

<a id="alternatives-decisions-and-proof"></a>
<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

Keep operation authorization in IAM and value containment with the configuration
owner. Extending Restriction could avoid another policy resource; a ceilings-only
Guardrail would solve delegated editing without deciding targeted operation denials
in this release. JSON Schema alone cannot establish network containment.

## Unresolved questions

1. Should the first release cover configuration ceilings alone, extend Restriction
   for targeted denials, or expose both through Guardrail? Preserve existing
   Restrictions’ exact-resource and administrator semantics in every option.
2. Should a Role bound on Agent A select a rule on Agent B? This draft says yes.
3. Should Installation administrators bypass Guardrails in ordinary use, or only
   through a narrower recovery path?
4. What cutover preserves intended editing access without retaining the temporary
   per-Agent switch indefinitely?

## References

- [Shared Driver configuration definitions (RFC-0022)](0022-driver-configuration-contributions.md).
- [Managed runtime contract (RFC-0021)](0021-managed-runtime-mode/index.md).
- [Current IAM authorization](../../docs/reference/authorization.md).
- [Current SandboxPolicy lifecycle and ceilings](../../docs/reference/sandbox-policies.md).
- [Network containment contract](../../packages/contracts/src/sandbox-policy.ts).

Source baseline: `af7c1bf73b98c4cdefa2e58237f992e561f0e5d1`.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-23: Clarified how Namespace limits compose, why a ceiling identifies its Driver, and which decisions need architecture review. Renumbered to RFC-0024.

- 2026-10-20: Clarified delegated editing, operation denials, and the transition from the per-Agent switch; identified decisions for architecture review.
- 2026-10-19: Reorganized under the RFC template, with explicit goals, non-goals, architecture, request lifecycle, verification, and rationale.
- 2026-10-19: Deferred existing-resource inspection and compliance reporting; retained admission enforcement and the administrator bypass.
- 2026-10-19: Drafted Guardrail scope, binding selectors, configuration ceilings, and admission boundaries from the proposed outline and current contracts.
