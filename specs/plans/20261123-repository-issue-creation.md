---
rfc: ../rfcs/20261123-repository-issue-creation.md
---

# Implementation plan: GitHub issue creation and repository permissions

- **ID:** RFC-20261123-repository-issue-creation
- **Delivery status:** In progress. Wider rollout is on hold.
- **Owner:** Repository access maintainers
- **Authority:** [Issue creation with repository Write access](../rfcs/20261123-repository-issue-creation.md)
- **Source baseline:** [OCE main](https://github.com/openclaw/openclaw-enterprise/commit/09c89c243)

## Implementation

1. Review [GitHub App delivery #6864](https://github.com/openclaw/openclaw-enterprise/pull/6864) in parallel with the RFC. Merge the RFC first. Remove `scopedRest`, `apiActions`, `createIssues` and bare `deny` from registrations. Recheck [permissions](../../docs/reference/repository-credentials/access-levels.md), set `apiLimits` and coordinate redeployment before upgrading. Ship the [Namespace guide #7165](https://github.com/openclaw/openclaw-enterprise/pull/7165) with the new configuration.
2. [Create Agent #7178](https://github.com/openclaw/openclaw-enterprise/pull/7178) can land separately. Keep the catalog and creation schemas limited to repository and access. If draft creation fails, check for a saved Configuration or model credential before retrying.
3. After #6864, add [per-Agent grants #7179](https://github.com/openclaw/openclaw-enterprise/pull/7179). Review the SQL validator and immutable revision checks before upgrading. Integrate [Console editing #7180](https://github.com/openclaw/openclaw-enterprise/pull/7180) with both #7178 and #7179. Exercise the complete journey before wider rollout.

## Verification

Use an authorized operator, a supported Dedicated Agent, PostgreSQL, matched Controller and Worker builds and stock OpenShell 0.1.9. Bind private test repositories A/B/C to a selected GitHub App with identical Contents, Issues and Pull requests write permissions unless a case says otherwise. Use `gh api` and Git inside the Agent. Confirm outcomes independently, inspect origin requests and verify zero Worker authorization callbacks and placeholder-only credentials. Verify uncertain writes before retrying.

Repeat these checks on builds with `apiLimits`. Use a controlled origin to count requests and live GitHub to confirm provider effects.

- **AC-1.** Grant A Read and B Write. Leave C bound with no grant and `{"default":"none"}` in its registration’s `apiLimits`. Create an issue in B and independently read it back. Verify zero direct requests for A writes, C access or PR creation anywhere.
- **AC-2.** Unbind C and redeploy. Read and create both resources in B. Set `apiLimits.issues` to `read` and redeploy. Verify no issue POST in B. Check issue reads, push, normal and draft PRs, and issue creation on another Write repository.
- **AC-3.** Deploy an old draft and redeploy an existing Agent. Reorder keys and rotate credentials. Require stable identity and routes. Tighten limits, downgrade and withdraw. Verify stale renewal refusal, blocked redirects and retirement of the old Sandbox.
- **AC-4.** With triage access to both repositories, attempt parent links from B to A and C separately. A second authorized operator checks both sides before and after. Keep wider rollout on hold if A changes or C is exposed or changed.
- **AC-5.** Reject empty, unknown, invalid and retired settings. With `default` set to `none`, try `pull_requests: read`, then `issues: write`, then no listed resource. Verify PR reads only, issue reads and creation only, then Git only. Check both orders of conflicting Namespace and Agent limits. Require zero forwarding for denied routes.
- **AC-6.** Without native enforcement, verify issuance and renewal refusal for any explicit limit, including `write` and cases with no eligible routes. Verify online delivery for an Agent without a saved policy or explicit limits.
- **AC-7.** Grant B Write with token permission `issues: read`. Set `apiLimits.issues` to `write`. Before and after renewal, verify issue reads, zero forwarded issue POSTs and unchanged token permissions.
- **AC-8.** As an Admin, save a draft, reopen it from a normal link and review the grants. Concurrently add a first grant or change a reviewed one. Require 409 and no revision. Review again, deploy, then edit from Configuration. Check saved and deployed versions, an unaffected peer and a viewer without edit rights. Verify each creation opt-out separately on live GitHub after redeployment.

## Delivery record

[#6864](https://github.com/openclaw/openclaw-enterprise/pull/6864) reported 239 focused tests and 18 installed checks across three runs at `0a01f129` and `aeb2a54e`. They used the earlier action lists, a simulated issuer and a controlled GitHub origin. Results covered mixed grants, peer repositories, downgrade, renewal, Git-only access, deployment refusal and the read-only token case (parts of AC-1–AC-3 and AC-5–AC-7).

The controlled origin linked both parents in AC-4. Live effects remain unknown. [#7178](https://github.com/openclaw/openclaw-enterprise/pull/7178) exercised installed Git access. These results do not verify `apiLimits` or the complete AC-8 workflow.

## Manual Notes

## Changelog

- 2026-11-23 16:08 PST — Linked the delivery dependencies and separated controlled results from live verification at `09c89c243`.
- 2026-11-23 18:23 PST — Replaced action lists with resource limits and revised verification from `271212578`.
