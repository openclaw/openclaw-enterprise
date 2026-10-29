---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Guardrails for permissions and configuration ceilings

- **ID:** RFC-0024
- **Created:** 2026-10-19
- **Last updated:** 2026-10-24
- **RFC PR:** [#2968](https://github.com/openclaw/openclaw-enterprise/pull/2968)
- **Related:** [shared configuration definitions](0022-driver-configuration-contributions.md), [managed runtime](0021-managed-runtime-mode/index.md)

<a id="decision-and-motivation"></a>
<a id="problem-and-decision"></a>

## Summary

An Installation administrator wants a team to edit an Agent’s network policy
within a limit. IAM grants permission to edit. A Guardrail would constrain the
values the team can save or deny an otherwise permitted operation. Neither
rule grants access.

Suppose the Installation ceiling permits Python to reach `api.example.com` on
ports 443 or 8443. An administrator narrows the `research` Namespace to 443.
A team member with editing enabled and both grants can add 443. Adding 8443
fails unless the actor qualifies for the Installation administrator exemption.
Installation administrators write both policies.

## Motivation

Today [sandbox policy](../../docs/reference/sandbox-policies.md) requires IAM grants
and an enabled per-Agent editing switch. OCC and the worker enforce a startup
ceiling. Administrators need reusable Installation and Namespace limits that
editors, admission, and workers can apply to the same candidate.

Existing IAM Restrictions deny an action on a resource. RFC-0022 already lets
Drivers validate configuration values. The proposed changes add binding-based
targeting and validation against the ceilings applicable to a particular request.

<a id="scope"></a>

## Goals

Let Installation administrators cap configuration and deny operations for
selected actors, globally or in one Namespace. Apply every matching limit at
admission, explain it in the editor, and recheck pending work before effects.

## Non-goals

Tightening a ceiling does not inspect, reconfigure, or stop running Agents.
This RFC covers control-plane decisions; [runtime enforcement](0021-managed-runtime-mode/index.md)
depends on the selected Driver. Existing-resource compliance scans and reports,
and delegated Namespace policy administration, are outside scope.

<a id="design"></a>

## Proposal

### Architecture

The OpenClaw Control Plane (OCC) stores and audits Guardrails and selects the
policies in scope. The selected IAM Driver authorizes the
operation and supplies complete binding matches so OCC can select the applicable
ceilings. Each configuration Driver validates values for its domain. Refuse the
operation if an authority cannot establish or enforce the applicable limits.

### Two kinds of limit

A Guardrail covers either all current and future Namespaces in one Installation
or exactly one Namespace. Scope is immutable. The proposed resource carries
configuration ceilings, operation denials, or both. Each rule can have binding selectors.

| An administrator wants to…                         | Use                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Let an operator edit an Agent’s network policy     | Ordinary IAM grants: `manage_policy` on the Agent **and** `update` on its SandboxPolicy. IAM denies the edit if either grant is missing. |
| Limit what that operator can add                   | A configuration ceiling, such as Python to `api.example.com:443`. Being inside the ceiling does not itself add the rule.                 |
| Prevent edits even when a broader Role grants them | A proposed deny rule for the relevant action and resource kind. Existing Restrictions still apply, including to administrators.          |

A deny rule names existing actions and a resource kind. Scope and binding
selectors determine whom it covers. Wildcard actions, per-resource filters,
and general condition expressions are outside this proposal.

### Who a rule covers

Omitting `accessBindings` selects everyone in scope. Otherwise match any selector
and every field within it: subject kind and ID, Role ID, or both. Reject an empty
list and unknown or cross-scope references. Global rules may reference only
Installation-wide subjects, Groups, or Roles.

Inspect all current bindings of the identity and its Groups in the Namespace or
Installation. A Role bound on Agent A can select its holder for a rule on Agent B,
even when a different binding grants the operation. Audit membership changes
that remove a restriction. If targeted denials ship, IAM’s access-coverage check
must also account for them: two identities with identical grants can have
different effective access.

For a shared Configuration save, check the caller. For deployment or policy
application, check the caller and the Agent’s ServicePrincipal. Enforce every
ceiling that matches either, subject to the administrator exemption below.

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
  inspection. An optional field must satisfy its constraint when present;
  a forbidden field must be absent. Reject an incompatible deployment or empty intersection; never
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
   the candidate. Check an unresolved template’s structure at save and the complete value at
   materialization. No later transformation may widen the result.
3. Commit only if the Guardrails and the IAM facts used for permission, targeting,
   and any bypass are still current. Refuse the change if the selected authority
   cannot establish this. Record matched policy generations and bypass authority.
   Before queued work, retries, or rollback take effect, recheck current policy
   and the **original actor’s** current authority, never the worker’s.

A ceiling governs the next configuration change. An operation denial governs
the next authorization decision. For example, the
[Credential Proxy exact-dispatch path](0023-egress-proxy-credential-lifecycle/index.md#from-startup-to-one-repository-read-with-exact-dispatch)
checks the Agent’s service principal for `operate` on the exact credential source
before material access and again before granting send permission. If targeted denials ship, a matching
Guardrail deny would apply at both checks. A later denial cannot recall a send
already authorized.

### Administration and transition

Provide Installation and Namespace Guardrail collections. Authorize creation on
the parent and item operations on the exact Guardrail. Every Namespace operation
also requires Namespace `read`. Initially, all mutations require Installation
`administer`. Exclude Guardrail administration from deny-rule targets so an
administrator with base permissions can repair policy. Require the current
generation for replacement or deletion. Commit each mutation with its audit
record, including cleanup of a deleted Namespace’s Guardrails. Refuse deletion
of an identity, Group, or Role while a selector references it.

Authorized configuration readers can see safe effective limits, the policy
generations, and any administrator bypass. Show which global or local rule
limits a field. Reading the complete policy requires Guardrail `read`.

Keep the startup network ceiling. Deny delegated editing by default on a fresh
Installation. On upgrade, retire the per-Agent editing switch and old write path
together, once intended access is preserved or explicitly changed. Two Agents can
have opposite switch settings for an operator with identical grants. Recheck
pending work, and establish the outcome of a possibly applied change before
issuing another. Removing a deny still grants nothing.

## Delivery and verification

The recommended first increment has three parts.

1. OCC stores and audits versioned ceilings. It uses IAM targeting to resolve the
   global and Namespace ceilings for a request and exposes them to authorized editors.
2. Extend the [RFC-0022 definition](0022-driver-configuration-contributions.md)
   on the Sandbox Driver’s network-policy contribution and add a native-values
   definition to the Configuration Driver. Use the existing network matcher for
   sandbox additions and validate fields on the effective native configuration.
3. Call that validation at save, deployment, and supported live apply. Recheck
   current policy and the original actor before a queued effect. Retain startup
   bounds and the existing restrictions on protected executions.

Verify with the real API, IAM, PostgreSQL, worker, and a qualified runtime.
With editing enabled and both grants present, apply 443 and observe the resulting
sandbox behavior. Tightening the ceiling leaves the running policy unchanged. The next
out-of-bounds save, deployment, or apply must fail before a new effect. Verify the final native
configuration too. Change Group membership after evaluation with the Guardrail
generation fixed and verify that an out-of-bounds commit or queued effect is refused. Exercise loss
of administrator authority, mixed editing settings, and an uncertain prior apply.

If targeted denials ship, prove an alternate grant cannot evade one and a
targeted identity cannot claim the same access as an unaffected peer. Commit
a matching deny between the two Credential Proxy exact-dispatch checks. Withhold
send permission and observe zero new requests at the provider.

<a id="alternatives-decisions-and-proof"></a>
<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

Two network edits can require the same IAM grants and differ only in their port.
Checking the effective configuration against a ceiling lets the administrator
delegate editing while limiting which values the team can save. We recommend
delivering ceilings first, subject to architecture review.

A targeted denial blocks the operation itself despite a broader grant. This
draft proposes authoring those rules in Guardrail. Extending Restriction is the
alternative. Both use the selected IAM authority.

## Unresolved questions

1. **First release.** Which use case, if any, requires targeted operation denials
   to ship with configuration ceilings? Name the actor, the operation their Role
   grants, and why existing IAM grants and Restrictions cannot express the intended
   limit. Use that case to decide whether to change the recommended delivery order.
2. **Policy ownership.** Where should administrators author targeted denials:
   Guardrail or Restriction? Preserve existing Restrictions’ exact-resource and
   administrator semantics in either design.
3. Should a Role bound on Agent A select a rule on Agent B? This draft says yes.
4. Should Installation administrators bypass Guardrails in ordinary use, or only
   through a narrower recovery path?
5. What cutover preserves intended editing access without retaining the temporary
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

- 2026-10-24: Retained ceilings and targeted denials in the proposal and recommended delivering ceilings first, pending architecture review.
- 2026-10-23: Clarified how Namespace limits compose, why a ceiling identifies its Driver, and which decisions need architecture review. Renumbered to RFC-0024.

- 2026-10-20: Clarified delegated editing, operation denials, and the transition from the per-Agent switch; identified decisions for architecture review.
- 2026-10-19: Reorganized under the RFC template, with explicit goals, non-goals, architecture, request lifecycle, verification, and rationale.
- 2026-10-19: Deferred existing-resource inspection and compliance reporting; retained admission enforcement and the administrator bypass.
- 2026-10-19: Drafted Guardrail scope, binding selectors, configuration ceilings, and admission boundaries from the proposed outline and current contracts.
