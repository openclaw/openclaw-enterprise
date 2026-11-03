---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Proposal: Let verified teams author Agents in one Namespace

- **ID:** RFC-0027
- **Created:** 2026-11-03
- **Last updated:** 2026-11-03

**Decision proposed.** Let an Installation administrator enable **Agent Operator** for one verified GitHub team in one Namespace. Teammates could then create, edit, deploy, and stop shared Agents without a grant for each Agent. Resource owners decide what those Agents can use. **In v1, the administrator must offboard departing teammates in OCE.**

## Why change per-Agent sharing?

Today the member draft flow can save a Configuration and Agent with fixture grants after Installation read returns `403`. The member still needs an administrator to grant the Agent credential access. Adding collection create alone would leave both that handoff and guided provisioning’s Installation `administer` requirement unresolved. [Member draft test](../../tests/browser/console-create-agent-member.test.ts) · [Guided provisioning](../../docs/flows/agent-provisioning.md#2-occ-admits-one-job)

## Who gets access, and where?

| Who                               | What they can do                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation administrator        | A current human with Installation `administer` and `read` on the exact Namespace can enable, inspect, or withdraw its profile and withdraw individual members. The profile defaults off. Enabling it covers **every existing and future Agent in that Namespace**.                                               |
| Team member                       | Auth verifies active membership in the selected GitHub team for the exact attached human account and provider subject. The sign-in allowlist applies separately and can admit people from another team. [Sign-in rules](../../docs/reference/authentication/external-sign-in.md#organization-and-team-allowlist) |
| Verified member in that Namespace | Read the Namespace. Create, read, update, deploy, and operate Agents. Read Agent revisions. Create, read, and update Configurations. Current Restrictions take precedence. Installation access, IAM administration, Agent `administer`, and deletion require separate authority.                                 |

## How two teammates share an Agent

1. The administrator enables the profile for the Support team in its Namespace. Maya and Eli each verify their membership.
2. Maya saves a Configuration referencing an approved model, creates an Agent, and deploys it.
3. Eli reads its revision, edits the Agent, and can stop it. Both members use the same shared Agent.

```mermaid
flowchart LR
  Admin["Installation administrator"] -->|Enables team profile| IAM["IAM Driver"]
  Auth["Auth verifier"] -->|Verifies member| IAM
  Member["Team member"] -->|Saves or deploys| OCC["OCC"]
  IAM -->|Authorizes member action| OCC
  Owner["Resource owner"] -->|Approves use for Namespace and purpose| OCC
  OCC -->|Binds approved use| Agent["Agent ServicePrincipal"]
```

## What can the Agent use?

A resource owner approves Agent use for an exact Namespace, resource lifetime, and purpose. Members see approved reference metadata. Credentials stay with the credential owner, who enforces the purpose at delivery and supports withdrawal.

For example, Maya can select an approved read-only repository even if her personal GitHub account cannot access it. The Agent can fetch. A push is denied. The GitHub App and Namespace policy determine the choices, and the saved binding limits the Agent. A Console default such as Contributor applies only when offered and supplies no authority. [Repository access levels](../../docs/reference/repository-credentials/access-levels.md)

## When does access end?

| Event                                          | Outcome                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maya leaves the GitHub team                    | Her OCE profile access continues. V1 checks membership once, with no expiry or periodic refresh. The administrator must find Maya in the Namespace profile, withdraw her grant, and verify the audit record.                                                                                                                                             |
| The administrator withdraws Maya               | Her next team-only action is refused, even from an existing session or queued work awaiting a new write or effect. Independent grants still apply. Eli can manage the Agent, and the Agent retains its approved uses. Rejoining requires administrator restoration and fresh team proof. Disabling or detaching Maya’s account also ends profile access. |
| The resource owner withdraws an Agent approval | New delivery for that use stops. The owner invokes supported runtime revocation. Provider capabilities govern material already delivered. Reconciliation changes only profile-owned grants.                                                                                                                                                              |

A later authenticated GitHub removal webhook could withdraw the current matching membership for the exact provider instance, organization, team, and subject. Added, duplicate, or out-of-order events must never grant or restore access. For missed or uncertain delivery, the administrator checks the roster and withdraws locally.

## What must pass before opt-in ships?

- **Shared authoring.** Through real HTTP and restricted PostgreSQL, two attached members create, edit, deploy, and read revisions using an approved model. Exercise ordinary drafts and guided provisioning.
- **Denied access.** Refuse unverified and withdrawn members, other teams and Namespaces, service keys, deletion, a matching Restriction, and an unapproved credential referenced through a Preset. Demonstrate the read-only repository example on a deployed Agent.
- **Offboarding.** In the same session, verify team-only access after GitHub removal, then local withdrawal, its audit record, and refusal of the next request and queued effect. Verify the independent grant, teammate access, and Agent approval still work.
- **Concurrent withdrawal.** Race withdrawal against a protected commit and provider dispatch. Verify which won and settle an unknown effect without duplicate dispatch.
- **Deployment.** IAM, Auth, and credential owners review verification, effect admission, withdrawal, and the supported deployment. Native browser access and live provider behavior each need installed proof. Preserve the GitHub sign-in host-only cookie and native administration startup guard.

## Implementation contract

- **Identity and policy.** Bind the Namespace lifetime and policy generation to the GitHub provider instance and immutable organization and team IDs. Use slugs only for lookup. The IAM Driver accepts only the server-defined profile and trusted membership evidence. Condition profile, membership, and managed grant writes on current state and commit them with attributable audit. Refuse before writing if the Driver or transaction cannot support this. [State and audit transaction](../../docs/flows/namespace-iam-policy.md#5-platform-state-commits-policy-and-audit-together)
- **Resource binding.** For ordinary save, deploy, and guided provisioning, OCC resolves the accepted Configuration or Harness reference and checks approval and the selected resource Driver. A readable Preset or human `operate` grant supplies no delegation. The transactional IAM writer grants exact `operate` to the Agent’s ServicePrincipal where required.
- **Effect ownership.** Reuse provisioning jobs, fingerprints, claims, receipts, and deployment handoff. Current authority and job ownership govern status and retry. The deployment controller reconciles after handoff. Use shared locks or conditional generations to order writes and final effect admission against withdrawal. Recheck the actor, approval, claim, and original resource state. If withdrawal wins, refuse new work. Cached IAM or recorded intent cannot authorize dispatch. The recorded owner settles admitted effects and holds uncertain effects with their receipts. Preserve stop and deletion fences.
- **Scope.** Reuse the IAM evaluator and provisioning flow. Generic Namespace policy keeps its exact identity bindings and cannot grant collection create. Per-Agent sharing still requires an administrator for each Agent. General roles, Groups, invocation, and audience controls remain deferred. [Namespace policy](../../docs/reference/authorization.md#manage-namespace-policy) · [RFC-0010](0010-agent-access.md) · [RFC-0006](0006-basic-rbac/index.md)
