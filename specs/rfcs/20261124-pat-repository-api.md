---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Proposal: GitHub repository APIs with a managed static Source

- **ID:** RFC-20261124-pat-repository-api
- **Created:** 2026-11-24
- **Last updated:** 2026-11-24
- **Related:** [Managed static GitHub Source proposal](https://github.com/openclaw/openclaw-enterprise/pull/7149), [Source implementation](https://github.com/openclaw/openclaw-enterprise/pull/7152), [Git delivery](https://github.com/openclaw/openclaw-enterprise/pull/7153), [repository network policy](20261119-repository-network-policy.md), [issue and PR access](20261123-repository-issue-creation.md)

## Summary

Allow an administrator to enroll the existing `github` managed static Source for native GitHub Issues and Pull requests APIs. The administrator explicitly adds `:api` to each repository ceiling that may use these APIs. OpenClaw Enterprise (OCE) derives the permitted direct routes from that ceiling, the Namespace registration and the saved Agent grant. Existing bare repository entries remain Git-only.

## Proposal

### Enroll and register the Source

Use the existing Source `repositories` ceiling. For example:

```text
acme/web:write:api,acme/docs:read:api,acme/tools:write
```

The first entry permits Git and eligible API reads and creation. The second permits Git and eligible API reads. The third permits Git only. `:api` covers both Issues and Pull requests. It grants no route by itself.

The administrator must enroll a dedicated fine-grained personal access token limited by GitHub to **exactly** the declared repositories. Before enrollment or replacement, the operator checks the selected repositories and resource permissions in GitHub and stops if they cannot confirm the scope. OCE has no automated check for extra token rights. A token prefix and an OCE Source record cannot attest the token's actual GitHub scope. Keep the token in TokenService and outside the Agent workload.

An existing Source cannot acquire or expand API opt-in through an update or credential rotation. Enroll a fresh Source for that expansion. Replacement of an opted-in token retains the enrolled ceiling and repeats the GitHub scope check. Preserve withdrawal and the existing Source retirement and credential cleanup workflow.

### Select direct routes

Register the Source in the same Namespace as the Agent and explicitly configure `permissions.issues` and `permissions.pull_requests`. For each repository and resource, intersect the Source ceiling, Namespace ceiling and permissions, saved Agent Read or Write grant, and Namespace and Agent `apiLimits`.

| Effective access | Eligible direct API requests under `/repos/{owner}/{repo}`                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| Read             | GET `/issues`, `/issues/{number}`, `/pulls`, `/pulls/{number}` where that resource has read permission |
| Write            | The eligible GETs and POST `/issues` or `/pulls` where that resource has write permission              |
| None             | No API routes                                                                                          |

Apply the existing `apiLimits` rules independently to Issues and Pull requests. A limit can remove eligible routes. It cannot enlarge a Source ceiling or GitHub permission. Git access retains its existing ceiling and checks.

The registration preview shows the Namespace maximum. Save, deploy and locked Source loans must refuse API operations outside these intersections. Recheck current authority before credential issuance and replacement. Fail closed when the native policy or recipient binding cannot be verified. An administrator can reduce access or withdraw the Source.

Stock `gh api` uses a placeholder credential. The Sandbox compiles exact repository routes and explicit credential bindings. The Credential Proxy provisions an endpointless Provider. Stock OpenShell 0.1.9 inspects TLS, enforces the native rules and injects the token. OCE performs no request-time GitHub authorization checks.

### Preserve the PR safeguard

Keep GitHub App behavior and the existing missing-bound-grant PR safeguard unchanged. A bound repository without an Agent grant suppresses PR creation while leaving eligible issue creation available. Also refuse an inconsistent static Source delivery if a PR creation route remains and the Agent lacks a grant for a declared Source repository outside its bindings. Reduce Pull requests to Read or select a matching Source. This rule does not add a global issue veto.

## Risks and limits

OpenShell checks direct methods and paths. These rules leave JSON fields and their query equivalents unrestricted. GitHub may accept a ready PR, a cross-repository head, an issue conversion, issue fields such as labels or assignees, or `parent_issue_id` referring to another repository. For example, B is writable and C is a private repository the Agent cannot access. A PAT mistakenly covering C could let a B pull request use C as a head if both share a fork network. A B issue could become a child of a C issue if GitHub grants triage in both. Even a correctly scoped token can affect a bound read-only repository this way. A PR can convert an issue when issue creation is disabled. GitHub workflows can also produce indirect effects.

Do not claim complete repository denial from direct route enforcement. Hold broader rollout if a controlled trial shows an unauthorized effect on private C. GitHub's dedicated token scope and permissions remain necessary safeguards. GraphQL, PATCH, DELETE, merge operations and strict body or query restrictions are outside this proposal.

## Interface changes

### APIs

Extend existing Source enrollment to accept `owner/name:read:api` and `owner/name:write:api` in `repositories`. Preserve the enrolled ceiling in readback. Reject expansion through update or rotation. Reuse existing Namespace permissions, grant preview, save, deploy and `apiLimits` interfaces.

### IAM

No new IAM action. Reuse the existing Source, Namespace and Agent authorization checks for each operation.

### Database entities

No changes. No database migration.

### Driver contracts

Extend managed static GitHub Source admission and locked credential loans to support the explicit API ceiling and the operator-declared repository set. Reuse native Sandbox compilation and endpointless Provider delivery.

## Simplifications

Reuse the Git-only Source, TokenService, repository syntax, permission intersection and native REST compiler. No new credential type, broker, request handler or OpenShell fork.

## Acceptance Criteria

All criteria are proposed and remain unverified.

- **AC-1.** Exercise normal enrollment, replacement and withdrawal. Reject malformed entries, routes outside the declared ceiling and expansion of API opt-in through update or rotation. Document the separate operator check of actual GitHub permissions.
- **AC-2.** Save and deploy the same Agent with A Read and B Write. Leave private C outside the credential, bindings and grants. Use a controlled origin and stock OpenShell to verify eligible A and B GETs, valid B issue and PR POSTs, and direct denials for A writes and C access. Record origin requests, placeholder use, zero OCE callbacks and absence of the token from the workload. Repeat with bare Git-only entries and independent resource limits.
- **AC-3.** Downgrade B, redeploy the same Agent and verify retirement of the old sandbox. B reads continue, fresh POSTs fail before the origin, and Git remains within its saved grant. Verify the same restrictions after token replacement. After withdrawal, the Source cannot issue or renew a credential. Confirm access stops when the installed copy is retired or expires. Missing or unverifiable native policy must release no credential.
- **AC-4.** Exercise the existing missing-bound-grant safeguard and the declared-but-unbound Source case. Verify PR suppression or delivery refusal as specified, and verify B issue creation when PR creation is disabled. In a controlled GitHub-like fixture, inspect both B and private C after parent, head, issue-conversion and workflow cases. Record direct denials separately from indirect effects and identify any GitHub behavior the fixture cannot establish.

## Delivery and verification

Submit this RFC for human review before changing the Driver contract. Implement through the regular saved Agent workflow after submission. Use controlled origins for acceptance work. This proposal authorizes no real GitHub writes, deployment or rollout. Live GitHub behavior and any broader rollout need separate authorization and evidence.
