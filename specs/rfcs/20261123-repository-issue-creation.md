---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Issue creation with repository Write access

- **ID:** RFC-20261123-repository-issue-creation
- **Created:** 2026-11-23
- **RFC PR:** [#6861](https://github.com/openclaw/openclaw-enterprise/pull/6861)
- **Related:** [Per-Agent repository network policy](20261119-repository-network-policy.md)

## Summary

For native GitHub App delivery, derive REST access from the repository permissions approved in the Namespace and the Agent’s saved Read or Write grant. **Write plus Issues write allows issue creation.** An operator can disable it for one repository with `createIssues: false`.

Remove the `scopedRest` setting. This supersedes the proposed REST versions and separate Agent approval in [#7120](https://github.com/openclaw/openclaw-enterprise/pull/7120).

## Motivation

An Admin who grants Write on B should know what the Agent can do there. A second REST switch, version selection and upgrade approval would duplicate permission decisions and make redeployments harder to predict.

## Proposal

Keep the existing native Git delivery selection. For each granted repository, compile only these GitHub API routes on stock OpenShell.

| Approved Namespace permission | Agent Read           | Agent Write                        |
| ----------------------------- | -------------------- | ---------------------------------- |
| `issues: read`                | List and read issues | List and read issues               |
| `issues: write`               | List and read issues | Also create issues unless disabled |
| `pull_requests: read`         | List and read PRs    | List and read PRs                  |
| `pull_requests: write`        | List and read PRs    | Also open eligible PRs             |

Omitted permissions grant no corresponding routes. Metadata and Contents alone mean Git-only, even if the installed App has broader permissions. Without a saved grant, deny direct access to that repository. GitHub also enforces the credential’s permissions.

**Mixed grants.** Repositories on one selected App token share a permission map. With A Read, B Write, and C bound without a grant, B can create issues. Set `createIssues: false` on B’s Namespace registration to disable B’s issue POST without lowering the shared permission ceiling. [#7135](https://github.com/openclaw/openclaw-enterprise/pull/7135) still withholds PR creation while C is bound. Unbind C and redeploy to restore eligible PRs.

**Deployment.** Remove `scopedRest` from configuration. Existing and new Agents use the current approved registration on their next deployment. An unchanged Write grant can gain issue or PR creation. Review the registration before deployment. Running Sandboxes retain their loaded policy and can lose credential renewal if it no longer matches. Retire the old Sandbox to complete withdrawal.

**Limits.** OpenShell authorizes the [full issue POST](https://docs.github.com/en/rest/issues/issues#create-an-issue) without filtering JSON or query fields. GitHub can apply labels and link a parent issue in another repository when the credential permits. Disabling issue creation leaves issue conversion possible through an eligible PR POST. Ordinary comments, edits, reviews, merges and GraphQL remain outside this policy. Finer field restrictions belong in OpenShell.

## Interface changes

### APIs

Add `POST /repos/{owner}/{repo}/issues` on `api.github.com`. No new OCE endpoint.

### IAM

Reuse existing registration, Agent policy and deployment permissions.

### Database entities

No changes.

### Driver contracts

Remove the REST version selector from native App registrations. Add an optional per-repository `createIssues` switch. Reuse the Sandbox rule compiler and the Credential Proxy’s endpointless Provider. Keep delivery and loaded-policy checks. PATs and protected profiles are outside this change.

## Simplifications

One policy applies at every deployment. No compatibility mode, per-Agent upgrade step, request hook, new client or OpenShell fork.

## Acceptance Criteria

- **AC-1.** On stock OpenShell, bind A/B/C with identical GitHub permissions, including Issues write. Grant A Read and B Write. Create and independently read back an issue in B. Require zero direct writes to A, zero requests to C, zero Worker callbacks and only a placeholder in the Agent.
- **AC-2.** Unbind C and redeploy. Verify issue and PR creation in B. Disable issue creation only on B and redeploy. Verify B’s reads, push and eligible PRs still work. Deny issue POSTs on B and retain issue creation on another eligible Write repo.
- **AC-3.** Exercise an existing draft, redeployment, credential rotation and downgrade. Check current permissions and the opt-out in each case. Verify Git-only and Issues read deny issue creation. Deny disallowed methods, routes and redirects before forwarding. Verify retirement of the prior Sandbox.
- **AC-4.** Test parent links from B to A and C separately using authorized test repositories. Inspect both sides. Hold wider rollout if read-only A changes or denied C is exposed or changed.

## Delivery and verification

[#6864](https://github.com/openclaw/openclaw-enterprise/pull/6864) passed six installed tests on an earlier, versioned implementation at `69a61a83`. A controlled origin recorded both parent links despite direct denials. Live private GitHub effects remain unverified. Repeat the relevant checks on the simplified implementation before release.
