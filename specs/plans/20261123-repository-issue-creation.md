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

1. Review [GitHub App delivery #6864](https://github.com/openclaw/openclaw-enterprise/pull/6864) in parallel with the RFC. Merge the RFC first. Remove `scopedRest`, `createIssues` and bare `deny` from registrations. Recheck [permissions](../../docs/reference/repository-credentials/access-levels.md), set restrictions and coordinate redeployment before upgrading. Ship the [Namespace guide #7165](https://github.com/openclaw/openclaw-enterprise/pull/7165) with the new configuration.
2. [Create Agent #7178](https://github.com/openclaw/openclaw-enterprise/pull/7178) can land separately. Keep the catalog and creation schemas limited to repository and access. If draft creation fails, check for a saved Configuration or model credential before retrying.
3. After #6864, add [per-Agent grants #7179](https://github.com/openclaw/openclaw-enterprise/pull/7179). Review the SQL validator and immutable revision checks before upgrading. Integrate [Console editing #7180](https://github.com/openclaw/openclaw-enterprise/pull/7180) with both #7178 and #7179. Exercise the complete journey before wider rollout.

## Verification

Use an authorized operator, a supported Dedicated Agent, PostgreSQL, matched Controller and Worker builds and stock OpenShell 0.1.9. Bind private test repositories A/B/C to a selected GitHub App with identical Contents, Issues and Pull requests write permissions unless a case says otherwise. Use `gh api` and Git inside the Agent. Confirm outcomes independently, inspect origin requests and verify zero Worker authorization callbacks and placeholder-only credentials. Verify uncertain writes before retrying.

| Criterion | Workflow and evidence required                                                                                                                                                                                                                                                                                                            | Evidence or gap                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| AC-1      | Give A Read, B Write and C no grant with `allow: []`. Check issue readback in B and zero direct requests for denied operations.                                                                                                                                                                                                           | Controlled mixed grants passed. Verify the exact combination live.                                                       |
| AC-2      | Unbind C and redeploy. Verify issue and PR reads and both creations. Deny B issue creation. Check push, normal and draft PRs and issue creation on another Write repo.                                                                                                                                                                    | Controlled filter and peer-repository checks passed. Live sequence pending.                                              |
| AC-3      | Redeploy an old draft and an existing Agent. Reorder actions, rotate, downgrade and withdraw. Compare identity, renewal, blocked redirects and old Sandbox retirement.                                                                                                                                                                    | API and controlled downgrade and renewal checks. Full upgrade sequence pending.                                          |
| AC-4      | With triage on both sides, attempt parent links from B to A and C separately. A second authorized operator checks both repositories before and after.                                                                                                                                                                                     | The controlled origin linked both parents. Live GitHub effects unknown. Keep wider rollout on hold.                      |
| AC-5      | Reject invalid and retired fields. Try PR reads alone, then issue creation alone. Deny all other routes before forwarding. With empty allow verify Git alone.                                                                                                                                                                             | Focused checks and controlled Git-only case. Confirm both explicit action lists live.                                    |
| AC-6      | Remove native enforcement. Test issuance and renewal separately with an empty allow, a nonempty deny and no eligible routes. Omission or empty deny retains online fallback.                                                                                                                                                              | Controlled deployment refusal and focused checks. Repeat on the upgrade build.                                           |
| AC-7      | Grant B Write with Issues read. Allow issue creation explicitly and attempt it before and after renewal. Verify zero forwarded POSTs and unchanged token permissions.                                                                                                                                                                     | Controlled installed checks passed.                                                                                      |
| AC-8      | As an authorized Admin, save a draft, reopen from a normal link, customize and review. Concurrently add a first grant or change a reviewed one. Require 409 with no revision. Review again, deploy, then edit from Configuration. Test each exception, saved versus deployed status, an unaffected peer and a viewer without edit rights. | Console and storage tests cover parts of this flow. Verify each POST and its denial from deployed Agents on live GitHub. |

## Delivery record

[#6864](https://github.com/openclaw/openclaw-enterprise/pull/6864) reports 239 focused tests and 18 installed checks across three runs at `0a01f129` and `aeb2a54e`. The issuer and GitHub origin were simulated. [#7178](https://github.com/openclaw/openclaw-enterprise/pull/7178) exercised installed Git access. Neither result establishes the full AC-8 workflow.

## Manual Notes

## Changelog

- 2026-11-23 16:08 PST — Linked the delivery dependencies and separated controlled results from live verification at `09c89c243`.
