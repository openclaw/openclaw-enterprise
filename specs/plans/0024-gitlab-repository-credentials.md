---
rfc: ../rfcs/0024-gitlab-repository-credentials.md
---

# Implementation plan: GitLab.com repository credentials

- **ID:** RFC-0024
- **Delivery status:** Planned
- **Owner:** Repository credential and Repo Driver maintainers
- **Authority:** [RFC-0024](../rfcs/0024-gitlab-repository-credentials.md)
- **Source baseline:** 98785b43abf9c83ea4ad6c08dfc385e87bbbf836

## Outcome and scope

An authorized Agent can use one GitLab.com project for the repository tasks and access profiles selected for the first release, through the existing `repo` capability and protected Credential Proxy/Sandbox path. GitLab credentials stay outside Agent files and logs. Self-managed GitLab and human-delegated tokens are outside the proposed first release.

Preserve task parity for `git-read` (clone/fetch; inspect project, issues, merge requests, diffs, and pipeline status), `git-write` (read tasks plus branch push and draft merge-request creation/discussion), and `git-full` (write tasks plus issue creation and comments). Keep issue writes disabled in `git-write`. Draft creation requires explicit source and target branches already present in the project. The create operation must never push a branch or create a fork. Provider-specific command names can differ, but the Agent must not gain merge, approval, project administration, or pipeline-control operations.

The RFC proposes a project service account and draft merge-request creation. GitLab service accounts can hold fine-grained PATs, and GitLab documents project permissions for Git and merge-request API operations. The project service-account token endpoint documents coarse scopes; fine-grained token creation for the current user is an experimental GraphQL mutation. Validate an acceptable credential setup and rotation path before implementation.

## Contract and source touchpoints

Current composition selects the GitHub provider implementation in [repository credential composition](../../apps/controller/src/composition/repository-credentials/platform.ts). The shared [RepositoryPolicyDriver contract](../../packages/contracts/src/repo.ts) lists approved options and resolves bindings, while the [repository session-file contract](../../packages/contracts/src/repo.ts) and [protected repository-delivery contract](../../packages/contracts/src/protected-repository-git.ts) retain GitHub-specific limits. The [Credential Proxy contract](../../packages/contracts/src/credential-proxy.ts) pairs with a selected Sandbox. The [credential reference](../../docs/reference/repository-credentials.md) and [team runbook](../../docs/guides/repository-credentials/team-runbook.md) describe current GitHub behavior and operator setup.

The work must extend the existing Repo capability and compose the provider through the selected Drivers. The [RFC-0023 implementation in PR #2487](https://github.com/openclaw/openclaw-enterprise/pull/2487) is merged: OCC owns admission and binding lifecycle, Token Service owns prepared credential lifecycle, provider adapters own provider scope and protocol, and the selected Credential Proxy/Sandbox path enforces protected requests. However, the protected repository-delivery contract is GitHub-specific and the bundled OpenShell release remains unqualified. Do not assume the GitHub issuer supports GitLab PATs or that a merged implementation establishes runtime qualification.

## Implementation

1. Validate a supported GitLab.com project-service-account flow for creating a fine-grained PAT with project-bound Git and merge-request permissions. Decide whether the experimental GraphQL creation path is acceptable or whether a non-experimental flow is required. Confirm rotation behavior and account for GitLab revoking the old token when it issues the replacement. Resolve the project role, exact API operations, and Free-tier service-account quota through RFC review. Select a supported static-secret or prepared-token source and define expiry, revocation, operator rotation, and Token Service/provider-adapter responsibilities.
2. Extend the Repo and protected repository-delivery contracts only as approved by the RFC. Add GitLab project identity and provider-specific client configuration without accepting Agent-supplied hosts or project IDs. Register and compose GitLab support through normal Installation configuration.
3. Add the GitLab provider adapter and service-side client. Bind requests to the configured project ID and canonical path, fix HTTPS origin to `gitlab.com`, enforce the approved Git methods and API route/method set, and keep the upstream token outside Agent files and logs.
4. Connect GitLab project discovery and binding to the existing repository-selection caller. Preserve fail-closed behavior when the provider, credential, project, protected sender, or operation is unavailable or unauthorized. Keep GitHub selection working.
5. Update the repository credential reference, team runbook, runtime flow, and documentation navigation if page placement changes. State GitLab.com scope, token setup, access limits, expiry, rotation, and recovery.
6. Verify the end-to-end Agent workflow against an authorized disposable GitLab.com project through the selected Credential Proxy and paired Sandbox. Separately record runtime qualification evidence; do not treat a local hook observation, provider client unit test, or hand-written adapter as proof of protected enforcement or the Agent workflow.

Do not implement a separate broker or silently fall back to native GitHub session delivery. If review changes the protected path, provider contract, or credential lifecycle, revise this plan and the GitLab RFC before implementation.

## Verification

| Required outcome                                                                                         | Real check and prerequisites                                                        | Result or remaining proof                                              |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Agent uses only the bound GitLab project for allowed clone, fetch, and push operations                   | Real Agent workflow with an authorized GitLab.com project and approved token        | Not run; this spike compared published docs and repository source only |
| `git-read` and `git-write` match GitHub's read and branch/MR tasks, with issues read-only in `git-write` | Real Agent workflow; verify per-profile Git, API, and denied write effects          | Not run; API route set remains for RFC review                          |
| `git-full` adds the same supported issue creation and comment tasks as GitHub                            | Same Agent workflow; verify project issue effects                                   | Not run; API route set remains for RFC review                          |
| Draft creation succeeds while merge and approval remain denied                                           | Same Agent workflow; verify real GitLab API effects                                 | Not run; API route set remains for RFC review                          |
| Wrong-project, unapproved API route, and missing, expired, or revoked credentials fail closed            | Verify OCE denials before send and distinguish a rejection returned by GitLab       | Not run                                                                |
| Token remains outside Agent material, logs, and client configuration                                     | Inspect delivered files, service logs, and provider request path in the integration | Not run                                                                |
| GitHub behavior remains available and existing Agent bindings retain their behavior                      | Current Repo Driver integration coverage plus targeted regression evidence          | Not run                                                                |

## Open decisions

- Product maintainers must confirm the project-service-account token creation path, exact Git/API grants, and whether GitLab.com Free support is required. This blocks the runbook and provider configuration.
- Credential Proxy and Token Service maintainers must decide whether GitLab uses a live static secret or a prepared-token provider, and how expiry, granular-scope preservation, immediate token replacement, and failed updates affect active bindings.
- Repo Driver maintainers must confirm the exact GitLab API operations.
- An authorized GitLab.com project and project-service-account credentials are required to validate token creation, granular permissions, and the live integration workflow.

## Delivery record

No implementation has started. This plan records the proposed work and verification only.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-21: Drafted from GitLab.com documentation research.
- 2026-10-23: Rebased the proposal on the merged RFC-0023 implementation and updated current provider and runtime boundaries.
