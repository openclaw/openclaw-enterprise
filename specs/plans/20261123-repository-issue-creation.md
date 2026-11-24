---
rfc: ../rfcs/20261123-repository-issue-creation.md
---

# Implementation plan: GitHub issue creation and repository permissions

- **ID:** RFC-20261123-repository-issue-creation
- **Delivery status:** In progress. Wider rollout is on hold.
- **Owner:** Repository access maintainers
- **Authority:** [Issue creation with repository Write access](../rfcs/20261123-repository-issue-creation.md)
- **Source reviewed:** [`3ab8f42b` on main](https://github.com/openclaw/openclaw-enterprise/commit/3ab8f42b0e1933c0d9510c3f2331d089d244ba1a)

## Implementation

1. [Create Agent #7178](https://github.com/openclaw/openclaw-enterprise/commit/d41494271000c79831532a2ee77ed74ddf1bac0a) added the role picker and first-deployment version check. Initial grants contain only repository and access. If draft creation fails, check for a saved Configuration or model credential before retrying.
2. The maintainer approved [RFC #6861](https://github.com/openclaw/openclaw-enterprise/commit/1b28f82683b307b7234723b7832bf90afd84918d). [GitHub App delivery #6864](https://github.com/openclaw/openclaw-enterprise/commit/713ecb6effe69c9e254676e22aec6b00d1514794) added issue creation and Namespace limits. Before upgrading, remove retired settings, [review permissions and limits](../../docs/reference/repository-credentials/access-levels.md#cut-over-existing-registrations) and plan redeployment.
3. [#7165](https://github.com/openclaw/openclaw-enterprise/pull/7165) added the operator preview. [#7179](https://github.com/openclaw/openclaw-enterprise/pull/7179) added per-Agent limits and migration 0093. [#7180](https://github.com/openclaw/openclaw-enterprise/pull/7180) supplies the editor. Older Workers cannot read limited revisions. Keep matching Controllers and Workers available through Stop and retirement.

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

- **AC-2, AC-3, AC-5 and AC-8, partial.** [The saved-Agent run](https://github.com/openclaw/openclaw-enterprise/pull/7179) passed seven checks at `5648c9e3` with stock OpenShell 0.1.9, migration 0093, a simulated App issuer and a controlled origin. B pushed and opened regular and draft PRs with Issues read-only. Its issue POST stayed blocked after redeployment and renewal. C kept Git only despite a more permissive Agent setting. A concurrent peer retained its Git access. The merged authorization code is identical.
- **AC-7, controlled.** Five checks passed on the same build with Issues read in the App permission map. Setting the Namespace limit to Write left the issue POST blocked before and after renewal.
- **AC-5 and AC-8, partial.** The [guide](https://github.com/openclaw/openclaw-enterprise/pull/7165) matched the compiler across 1,152 combinations. [Controller and browser tests](https://github.com/openclaw/openclaw-enterprise/pull/7180) exercised both independent opt-outs, a concurrent edit, the first revision and later editing with synthetic Drivers.
- **Earlier checks.** [#6864](https://github.com/openclaw/openclaw-enterprise/pull/6864) records controlled runs using the previous action lists. The origin linked both parents in AC-4. Those results do not qualify the new contract.

**Before wider rollout**, verify the upgrade sequence, live GitHub effects on both parent repositories and both opt-outs on deployed Agents with an unaffected peer. See [#7179](https://github.com/openclaw/openclaw-enterprise/pull/7179) for additional installed results.

## Manual Notes

## Changelog

- 2026-11-23 16:08 PST — Linked the delivery dependencies and separated controlled results from live verification at `09c89c243`.
- 2026-11-23 18:23 PST — Replaced action lists with resource limits and revised verification from `271212578`.
- 2026-11-23 18:49 PST — Recorded acceptance and the implementation on main at `713ecb6ef`.
- 2026-11-23 19:07 PST — Recorded the guide, Agent limit implementation and controlled enforcement results at `3ab8f42b`.
