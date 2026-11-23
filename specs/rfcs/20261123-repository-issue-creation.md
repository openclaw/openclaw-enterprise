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

**Write plus GitHub Issues write allows issue creation by default.** For native App delivery, derive eligible actions from the repository permissions approved in the Namespace and the Agent’s saved Read or Write grant. Operators who need tighter controls can limit API actions per repository.

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

**Mixed grants.** Repositories on one selected App token share a permission map. With A Read, B Write, and C bound without a grant, B can create issues. [#7135](https://github.com/openclaw/openclaw-enterprise/pull/7135) still withholds PR creation while C is bound. Unbind C and redeploy to restore eligible PRs.

### Optional API restrictions

Keep Read and Write as the everyday Agent controls. An operator can narrow the eligible routes for all Agents using a repository’s Namespace registration with `apiActions`. Git fetch and push keep their existing grants. The following are alternative settings on B.

| Operator intent           | Registration example                                                    | When OCE supports another eligible action |
| ------------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| All permitted (default)   | Omit `apiActions`                                                       | Included                                  |
| All except issue creation | `apiActions: { deny: ["issues:create"] }`                               | Included unless excluded                  |
| Only read and open PRs    | `apiActions: { allow: ["pull_requests:read", "pull_requests:create"] }` | Excluded until listed                     |
| Git only                  | `apiActions: { allow: [] }`                                             | Excluded                                  |

Use **one of** `allow` or `deny`. Reject both together, unknown actions, duplicates and wildcards. An empty deny list has the default behavior. Filters can only remove eligible routes. Listing a write action cannot override Read, a missing permission or the PR safeguard.

Start with four actions. `issues:read` and `pull_requests:read` each cover list and numbered detail GETs. `issues:create` and `pull_requests:create` each cover one collection POST. Creation does not enable a separate GET. Give new operations distinct names. A new GitHub endpoint stays closed until OCE deliberately supports it and specifies its permissions.

In the UI, show the effective actions for the selected Agent and repository, including why a requested action is unavailable. Keep advanced filters at the Namespace registration. The labels above describe the intended UX. This RFC requires no new Console editor.

**Deployment.** Remove `scopedRest` from configuration. Existing and new Agents use the current approved registration on their next deployment. An unchanged Write grant can gain issue or PR creation. Review the registration before deployment. Running Sandboxes retain their loaded policy and can lose credential renewal if it no longer matches. Retire the old Sandbox to complete withdrawal.

**Limits.** These actions control direct requests. GitHub can apply labels or link a parent in another repository through the [issue POST](https://docs.github.com/en/rest/issues/issues#create-an-issue). An eligible PR POST can convert an issue even when issue creation is disabled. Issue reads can return PRs, and creation returns the created record. Denying a GET cannot hide those responses. Comments, edits, reviews, merges and GraphQL remain outside this policy. Finer field restrictions belong in OpenShell.

## Interface changes

### APIs

Add `POST /repos/{owner}/{repo}/issues` on `api.github.com`. No new OCE endpoint.

### IAM

Reuse existing registration, Agent policy and deployment permissions.

### Database entities

No changes.

### Driver contracts

Replace the REST version selector with the optional `apiActions` filter on native App registrations. Filter the existing operation set before compiling OpenShell allows. Bind effective actions to the credential grant and verify loaded policy. If a configured restriction cannot be enforced (including a missing native policy), refuse credential delivery. Never fall back to broader online access. Preserve Stop and withdrawal. PATs and protected profiles are outside this change.

## Simplifications

One policy applies at every deployment. No compatibility mode, per-Agent upgrade step, request hook, new client or OpenShell fork.

## Acceptance Criteria

- **AC-1.** On stock OpenShell, bind A/B/C with identical GitHub permissions, including Issues write. Grant A Read and B Write. Create and independently read back an issue in B. Require zero direct writes to A, zero requests to C, zero Worker callbacks and only a placeholder in the Agent.
- **AC-2.** Unbind C and redeploy. Verify both POSTs in B. Deny `issues:create` on B and redeploy. Verify B’s reads, push and PR creation still work. Another eligible Write repository retains issue creation.
- **AC-3.** Exercise an existing draft, redeployment, credential rotation and downgrade. Check current permissions and the opt-out in each case. Verify Git-only and Issues read deny issue creation. Deny disallowed methods, routes and redirects before forwarding. Verify retirement of the prior Sandbox.
- **AC-4.** Test parent links from B to A and C separately using authorized test repositories. Inspect both sides. Hold wider rollout if read-only A changes or denied C is exposed or changed.
- **AC-5.** Allow only PR reads and verify all other API routes stop before forwarding. With `allow: []`, verify Git works and all API requests stop. Explicit allows must respect Read, missing permissions and #7135. Reject invalid filters. Refuse broader delivery if the native policy is missing. Verify tightening takes effect on redeploy and old credentials cannot renew against stale policy.

## Delivery and verification

[#6864](https://github.com/openclaw/openclaw-enterprise/pull/6864) passed six installed tests at `69a61a83`. A controlled origin recorded both parent links despite direct denials. Live private GitHub effects remain unverified. The later draft at `d9b229e2` removed REST versions and supported denying issue creation only. Qualify the complete filter before release.
