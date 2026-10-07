---
rfc: index.md
---

# RBAC delivery and qualification

Read the [current-source and release-scope amendment](index.md#current-source-amendment--2026-09-24)
before applying this original proposal. This plan is deferred past 0.x; the
requirements below are not implementation acceptance. The 0.x scope is
[Agent access](../0010-agent-access.md#delivery-checkpoints) checkpoints 1-2.

**Post-0.x.** The [selected proposal](index.md) is complete only when
ordinary people can use personal and team Agents through both channels with the
required content, repository and withdrawal controls. These completion criteria are
not 0.x requirements. An earlier checkpoint may be useful without completing that
scope.

## Increments and qualification

Increments 2-4 are post-0.x. Increment 1 overlaps the 0.x [Agent access](../0010-agent-access.md#delivery-checkpoints) checkpoints, which govern where they differ.

1. **Account/policy foundation.** Through the real controller and limited-role
   PostgreSQL path, an administrator enrolls a human without grants, applies exact
   grants, and the human creates and operates an Agent. Prove external-only account
   currentness, complete repair, local-administrator races and all-writer ordering.
   Prove concurrent policy changes and one batch digest/revision outcome through
   replay, changed-content conflict, rollback, audit/commit failure and original
   receipt recovery after uncertain COMMIT.
2. **Authentic turn/content (post-0.x).** Deployer A and distinct requester B use real Slack
   with a dedicated Codex runtime. Prove current narrow roles, cross-Namespace and
   content/audit denial, failed-hook zero dispatch, duplicate/restart behavior,
   unknown runtime start/send and complete-audience changes. This increment makes
   no protected repository claim yet.
3. **Same-artifact protected read (post-0.x).** The same managed Agent performs a genuine Git
   HEAD read under explicit `git-read`, with a protected model and actual receiving
   proof. Prove allowed and denied repository use without unauthorized profile
   widening or an alternate path. Deny results after revoke and cancel protectively
   after the requester loses permission.
   Measure both withdrawal endpoints, renewal loss, delayed positive observations
   and blocked consumers. This Slack/Codex/git-read checkpoint remains narrower
   than the complete selected goal.
4. **Complete breadth (post-0.x).** Qualify installed local-account personal and team journeys
   through live Slack and Teams. Codex and Claude Code each need supported runtime
   and authentication profiles with separate installed acceptance. Record the
   finite offered combinations, exact source, images, runtime/CNI and provider
   evidence. Preserve distinct traffic closure, observed stop and provider-cleanup
   outcomes.

RFC approval comes first. Policy/State, account/content, invocation, connector and
Harness, repository/withdrawal, and installed integration remain reviewable delivery
pieces. Federated sign-in has a separate stack and independently qualifies enrolled
and denied provider users plus protocol-negative cases. History adds separately
granted reader C to genuine deployer A/requester B records only after its own
serving gates. Neither companion substitutes for RBAC's actual journey.

## Acceptance evidence

Use actual PostgreSQL, controller and runtime boundaries with real consumers.
Independent security and SQL review must resolve actionable findings, followed by
whole-change polish. Update living authorization, authentication, content, channel,
Harness and repository references and flows when the consumers are implemented.

Exercise each [increment](#increments-and-qualification) and its negative cases
against the exact qualified artifacts.

| Evidence layer     | What it establishes                                                  |
| ------------------ | -------------------------------------------------------------------- |
| Pinned source      | Contracts and behavior present at that revision.                     |
| Composed checks    | Connected production owners under the tested dependencies.           |
| Installed runtime  | Behavior of the named image/runtime/network combination.             |
| Live provider      | Actual channel, identity, repository and cleanup behavior exercised. |
| Release acceptance | Explicit acceptance of the complete selected scope and gates.        |

Bind receipts to exact source revisions, images, selected profiles, runtime/CNI and
provider configuration. Record skipped or unavailable proof explicitly. Component
tests establish neither composed, installed, live-provider nor release acceptance.
Documentation checks and diagrams establish none of those runtime guarantees.

## Decisions and follow-ups

The [interface owner decisions](interfaces.md#owner-decisions) retain exact context
commands, route/profile mapping, audience procedure, concurrent-operation binding,
fence lifetime and timing mechanisms. OCC, IAM, connectors, identity, egress and
Compute must close their respective producing and consuming contracts. The
[Installation profile proposal](architecture.md#profile-admission-and-availability)
still needs a decision on prospective defaults versus protective withdrawal of
existing weaker admissions. No implicit grace period or automatic combination is
approved.

Teams, Claude Code, complete personal/team breadth and active withdrawal are later
selected work within this goal. The following capabilities remain separately
triggered successors:

- **Per-effect Work.** When a selected effect consumer needs it, the original
  Work/effect owner must carry current selected IAM, exact resource and operation,
  digest, policy revision, original absolute deadline and one-use dispatch.
  Closure requires genuine effects and unknown-outcome recovery without replay.
- **Custom roles and delegated administration.** When selected, IAM supplies
  immutable role definitions/versions plus explicit grantable-role and scope
  ceilings. Prove no escalation and complete withdrawal.
- **Directory offboarding/SCIM.** An authoritative provider event, synchronization
  or reauthentication path is required for immediate identity-provider-driven
  withdrawal. The identity owner projects only its source-owned direct memberships
  through the common writer and proves session and active-work withdrawal.
- **Extra channel or team-service profiles.** A named connector/provider consumer
  must verify its audience and define one exact parsed operation profile before
  credential use and dispatch, with protected source and mandatory route. Group
  DMs, implicit/relayed activation, general TLS interception and arbitrary connector
  parity remain separate work.
- **Stronger isolation.** A selected privacy requirement needs runtime/content
  owners to separate context, storage, tools and output audiences. Confidentiality
  from designated operators needs separately scoped keys, attestation and protected
  execution. Identity/Compute must independently prove exact-container origin or
  outage-time physical termination when either stronger assurance is selected.

Reducing the selected breadth or protection requires an explicit human scope
decision. Open mechanisms and missing evidence cannot silently make that decision.
