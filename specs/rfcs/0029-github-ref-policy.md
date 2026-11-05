---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# RFC-0029: Let GitHub enforce branch rules for Agents

An Agent should be able to push to any branch GitHub allows within its selected repositories. OCE v1 should scope GitHub App installation tokens to approved repository IDs and permissions, and retire its own branch allowlist. GitHub applies branch and tag rules to the App.

[#4098](https://github.com/openclaw/openclaw-enterprise/pull/4098) already uses this model for selected repositories with one shared permission map. The older Git write and draft paths still carry exact refs or branch patterns. This proposal changes those supported paths prospectively. [RFC-0008](0008-repository-credentials/index.md) and [RFC-0023](0023-egress-proxy-credential-lifecycle/index.md) remain historical records.

## Authorization

OCE admits the Namespace, Agent, repository selection, and effective permissions under the installation's ceiling. The issuer requests explicit repository IDs and permissions and checks the returned scope. Missing or mismatched scope fails closed. An explicitly enabled installation-wide grant remains separate; a missing, empty, stale, or unrecognized selection and a failed exchange never widen access.

GitHub sees the App identity. Two Agents using the same App with write access to one repository do not get different branch rules from this design. Operators must configure branch and tag protection in GitHub and verify the App cannot bypass rules they expect it to obey. Keeping OCE's allowlist would preserve per-Agent branch differences, but would leave two owners for ref policy.

Read and Read + write are repository permissions, subject to the App's permission ceiling. Keep the existing shared token for repositories with identical effective permissions. To support mixed permissions, start with one token for the repository named by the operation. A write token for A cannot include read-only B. Do not pick a write token for an API request whose repository or permission group is ambiguous. Define and test that routing before offering mixed permissions.

The trusted sender still checks current authorization before use and keeps App keys and tokens out of the Agent. Ref syntax and protocol validation, request limits, withdrawal, and original-operation recovery stay in place. Public repository reads, general API restrictions, and a possible GitHub publishing plugin are separate decisions.

## Cutover and proof

1. Inventory saved exact-ref and branch-pattern grants, issued credentials, and outstanding sessions or drafts by their original owner. Establish GitHub rules and require an authorized operator to explicitly choose the replacement repository grant. A saved ref-scoped grant keeps its constraint or refuses fresh use; an upgrade must not convert it into repository-wide write access.
2. Move fresh Git use to the selected-repository path. On an installed OpenShell Agent, push to differently named allowed branches and verify that GitHub refuses an update to a protected ref without changing its SHA. Verify that an unselected private repository stays inaccessible and that withdrawal stops fresh requests while the Agent can still chat. Before enabling mixed permissions, prove that the same Agent can write A, read B, and cannot write B; verify B's ref independently.
3. Stop admitting new ref-scoped grants. Qualify restart and rollback on an interrupted upgrade. Original receipts remain bound to the repository, ref, and operation that was issued; an uncertain outcome cannot become a new write. Once the old path drains, remove ref-policy configuration, propagation, sender checks, and the native pre-push guard. Retain the tests for repository selection, permission scopes, withdrawal, and original-owner recovery.
