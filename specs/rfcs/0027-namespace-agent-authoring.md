---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Proposal: Let verified teams author Agents in one Namespace

- **ID:** RFC-0027
- **Created:** 2026-11-03
- **Last updated:** 2026-11-03

An Installation administrator can opt one Namespace into **Agent Operator** for
one verified GitHub team. Members who pass the initial team check with an attached
account can create, edit, deploy, and stop existing and new Agents there and read
their revisions without per-Agent administrator grants. The first version uses
manual offboarding.

The [member draft test](../../tests/browser/console-create-agent-member.test.ts)
uses fixture grants to save a Configuration and Agent after Installation read
returns `403`. The Console then asks an administrator to grant the Agent
credential access. [Namespace policy](../../docs/reference/authorization.md#manage-namespace-policy)
writes exact identity bindings and cannot grant collection create. Adding
create alone leaves credential delegation and the [guided provisioning](../../docs/flows/agent-provisioning.md#2-occ-admits-one-job)
requirement for Installation `administer` unresolved.

## The IAM Driver contract

Only a current human with Installation `administer` and exact Namespace `read`
can enable, inspect, or withdraw the profile, or explicitly withdraw a member.
The profile defaults off. State binds the Namespace lifetime to the GitHub
provider instance and immutable organization and team IDs, with a policy
generation. The opt-in confirms that the scope includes all Agents there.
The administrator takes responsibility for withdrawing access when someone
leaves the team. Slugs serve only as lookup inputs.

The selected IAM Driver must support this fixed policy in OCC's existing
[State and audit transaction](../../docs/flows/namespace-iam-policy.md#5-platform-state-commits-policy-and-audit-together).
It accepts only the server-defined profile and trusted membership evidence.
It supplies Namespace read, Agent create/read/update/deploy/operate,
Configuration create/read/update, and Agent revision read. Current Restrictions
still win. Profile, membership, and managed grant changes are conditional on
current state and commit with attributable audit. An unsupported Driver or
transaction refuses the operation before a write. The generic policy API keeps
its existing limits. Agent Operator grants no Installation access, IAM
administration, Agent `administer`, or deletion.

Auth verifies active membership in the selected team for the exact attached
human account and provider subject. The
[GitHub sign-in allowlist](../../docs/reference/authentication/external-sign-in.md#organization-and-team-allowlist)
still applies independently. Signing in may satisfy an organization or a different
team rule. The profile separately requires positive proof for the selected team
before it grants access. Account disablement or detachment also ends access from
the profile.

Dashed arrows show the proposed connections.

```mermaid
---
config:
  theme: base
  htmlLabels: true
  themeVariables:
    fontSize: 14px
  flowchart:
    curve: linear
    nodeSpacing: 14
    rankSpacing: 22
---
flowchart LR
  Admin["<b>Installation</b><br/>administrator"]
  Auth["<b>Auth verifier</b><br/>GitHub proof"]
  IAM["<b>IAM Driver</b><br/>Namespace profile"]
  OCC["<b>OCC</b><br/>Agent authoring"]
  Agent["<b>Agent</b><br/>ServicePrincipal"]
  Admin -.->|opts in| IAM
  Auth -.->|proves team| IAM
  IAM -.->|authorizes| OCC
  OCC -.->|binds use| Agent
  classDef input fill:#F1EEF5,stroke:#A091AD,color:#3A3243,stroke-width:1px
  classDef owner fill:#EAF4F2,stroke:#829F98,color:#263B36,stroke-width:1px
  class Admin,Auth input
  class IAM,OCC,Agent owner
```

## Manual offboarding

In v1, OCE presumes membership after initial verification until an Installation
administrator withdraws the member's authority from the profile. The membership
record has no expiry or periodic sign-in or refresh requirement. Removing someone
from the GitHub team leaves their team-derived authority in OCE active until the
administrator withdraws it there. This is the v1 tradeoff for manual offboarding.

The administrator identifies the member in the Namespace profile, withdraws the
team-derived grant, and checks the committed audit record. IAM applies the
withdrawal at the next protected action, including from an existing session or
queued work awaiting a new write or effect. Independent grants still apply.
Shared Agents retain their permissions and approvals. Restoring eligibility
requires an administrator's action followed by fresh proof for that team.

A later version can accept an authenticated GitHub membership removal webhook
for the exact provider instance, organization, team, and subject. It can only
withdraw the current matching membership. Added, duplicate, or out-of-order
events never grant or restore access. If a removal delivery is missed or its
outcome is uncertain, the administrator checks the team roster and uses the
same local withdrawal procedure.

## Resource authority and withdrawal

Using a resource and granting its use are separate permissions. A resource owner
can approve Agent use once for an exact Namespace, resource lifetime, and purpose.
OCC resolves the accepted Configuration or Harness reference and checks that
approval and the selected resource Driver. A readable Preset or a human
`operate` grant supplies no approval. Ordinary save, deploy, and guided
provisioning share this decision. The existing transactional IAM writer grants
exact `operate` to the Agent's ServicePrincipal where required. The credential
owner must enforce the approved purpose at delivery and support withdrawal.
Members discover approved reference metadata and receive no credential material
or general credential use.

Repository choices use the current [GitHub App and Namespace policy](../../docs/reference/repository-credentials/access-levels.md).
The member may choose a permitted repository even without personal access to
it in GitHub. The saved binding limits the Agent's access. A Console default
such as Contributor applies only when offered and supplies no authority.

OCC reuses provisioning jobs, fingerprints, claims, effect receipts, and the
deployment handoff. Current authority and job ownership govern status and retry.
Other members manage the resulting Agent. The deployment controller owns
reconciliation after handoff. Use shared locks or conditional generations to
order original writes and final effect admission against withdrawal. Check the
actor, approval, claim, and original resource state. A cached IAM snapshot or
recorded intent cannot authorize later dispatch. If withdrawal wins, refuse the
new write or effect. The recorded owner inspects and settles admitted effects.
Keep unknown effects on hold with their receipts until reconciled. Stop and
deletion keep their existing lifecycle fences.

Withdrawing the Agent's independent approval stops new delivery for the affected
use and invokes supported runtime revocation. Reconciliation changes only
profile-owned grants. The provider's limits govern revocation of material
already delivered.

## Delivery and evidence

- Through real HTTP and restricted PostgreSQL, two ordinary attached members
  create, edit, deploy, and read a shared Agent's revisions using an approved
  model. Cover ordinary drafts and guided provisioning. Deny unverified or
  withdrawn members, other teams and Namespaces, service keys, deletion, a
  matching Restriction, and an unapproved credential passed through a Preset.
- Remove a verified member from GitHub without notifying OCE. Using the same
  signed-in session, show that a team-only action still succeeds. Have an
  Installation administrator withdraw the member from the Namespace profile and
  verify the audit record. The next team-only request and queued work awaiting a
  new effect must be refused. Show that an independently granted action still
  succeeds, another member can manage the shared Agent, and the Agent retains
  its approved resource use.
- Race withdrawal against a protected commit and provider dispatch. Check which
  side won and settle an unknown effect without duplicate dispatch. For
  repositories, show that a member without personal access can attach an approved
  read-only repository, the deployed Agent can fetch it, and push is refused.
- IAM, Auth, and credential owners review verification, effect admission,
  withdrawal, and the supported deployment before opt-in ships. GitHub
  sign-in keeps its host-only cookie and native administration startup guard.
  Native browser access and live provider behavior need separate installed proof.

Per-Agent sharing in [RFC-0010](0010-agent-access.md) keeps an administrator on
the path for each new Agent. This profile reuses the IAM evaluator and
provisioning flow. [RFC-0006](0006-basic-rbac/index.md) remains deferred, including
its general role and Group management, invocation, and audience controls.
