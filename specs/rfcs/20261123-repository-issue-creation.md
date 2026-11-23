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

Keep the existing native Git delivery selection. The table shows eligible **direct requests** to GitHub on stock OpenShell before filtering.

| Approved Namespace permission | Agent Read           | Agent Write                        |
| ----------------------------- | -------------------- | ---------------------------------- |
| `issues: read`                | List and read issues | List and read issues               |
| `issues: write`               | List and read issues | Also create issues unless disabled |
| `pull_requests: read`         | List and read PRs    | List and read PRs                  |
| `pull_requests: write`        | List and read PRs    | Also open eligible PRs             |

Omitted permissions grant no corresponding routes. Metadata and Contents alone mean Git-only, even if the installed App has broader permissions. Without a saved grant, deny direct access to that repository. GitHub also enforces the credential’s permissions.

Repositories on one selected App token must have identical permission maps. Their filters can differ. With A Read, B Write and C bound without a grant, [#7135](https://github.com/openclaw/openclaw-enterprise/pull/7135) withholds PR creation on B but permits eligible issue creation there. Setting `allow: []` on C leaves it bound. Unbind C and redeploy to restore eligible PR creation on B.

### Optional API restrictions

Setting `apiActions` on B’s Namespace registration filters direct API requests for **every Agent using that registration**. Git fetch and push keep their existing grants.

| Operator intent           | Registration example                                                    | When OCE supports another eligible action |
| ------------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| All permitted (default)   | Omit `apiActions`                                                       | Included                                  |
| All except issue creation | `apiActions: { deny: ["issues:create"] }`                               | Included unless excluded                  |
| Only read and open PRs    | `apiActions: { allow: ["pull_requests:read", "pull_requests:create"] }` | Excluded until listed                     |
| Git only                  | `apiActions: { allow: [] }`                                             | Excluded                                  |

If present, `apiActions` must be an object with exactly one key, `allow` or `deny`, whose value is an array of unique literal action names. Reject malformed values, mixed or extra keys, wildcards and unknown names. Reject retired `scopedRest`, `createIssues` and bare `deny` settings without conversion.

Treat `deny: []` as omission. Every allow list (even `allow: []`) and every nonempty deny list is an active restriction. Filters can only remove eligible routes. Listing a write action cannot override Read, a missing permission or the PR safeguard.

Start with four actions. `issues:read` and `pull_requests:read` each cover list and numbered detail GETs. `issues:create` and `pull_requests:create` each cover one collection POST. Creation does not enable a separate GET. Give new operations distinct names. A new GitHub endpoint stays closed until OCE deliberately supports it and specifies its permissions.

**Operator UX.** In the setup guide, check the actions to keep on B. With **Include new eligible actions automatically** on, generate `deny` from unchecked actions. With it off, generate `allow` from checked actions. Show the configuration to copy into the Namespace registration. Label the preview as an example and explain which grants or permissions limit access. The checklist cannot change a running Agent. Live policy reporting is separate work.

**Before deploying**, remove `scopedRest` and check the approved permissions. To keep Git-only access, set `apiActions: { allow: [] }`. To keep issue creation off, use `apiActions: { deny: ["issues:create"] }`. An unchanged Write grant can otherwise gain issue or PR creation at the next deployment. A running Sandbox retains its loaded policy and may lose credential renewal after a change. Retire it to complete withdrawal.

**Limits.** These actions control direct requests. GitHub can apply labels or link a parent in another repository through the [issue POST](https://docs.github.com/en/rest/issues/issues#create-an-issue). An eligible PR POST can convert an issue even when issue creation is disabled. Issue reads can return PRs, and creation returns the created record. Denying a GET cannot hide those responses. Comments, edits, reviews, merges and GraphQL remain outside this policy. Finer field restrictions belong in OpenShell.

## Interface changes

### APIs

Add `POST /repos/{owner}/{repo}/issues` on `api.github.com`. No new OCE endpoint.

### IAM

Reuse existing registration, Agent policy and deployment permissions.

### Database entities

No changes.

### Driver contracts

Filter eligible routes before compiling OpenShell policy. Include each repository’s filter and effective actions in the credential grant identity. Ignore list order. Verify the loaded policy at issuance and renewal. Reject stale policy after tightening. If native policy cannot enforce an active restriction, refuse both issuance and renewal even when permissions leave no eligible routes. Preserve legacy online fallback for unfiltered grants, Stop and withdrawal. PATs and protected profiles are outside this change.

## Simplifications

One policy applies at every deployment. No compatibility mode, per-Agent upgrade step, request hook, new client or OpenShell fork.

## Acceptance Criteria

- **AC-1.** On stock OpenShell, bind A/B/C with identical permissions including Issues and Pull requests write. Grant A Read and B Write. Leave C bound without a grant and set `allow: []` on C. Create and independently read back an issue in B. Block PR creation on B. Require zero direct writes to A, zero direct requests to C, zero Worker callbacks and only a placeholder in the Agent.
- **AC-2.** Unbind C and redeploy. Through the same Agent and binding, read issues and PRs and verify both POSTs in B. Deny `issues:create` on B and redeploy. Verify B’s reads, push and PR creation still work. Another eligible Write repository retains issue creation.
- **AC-3.** Check current permissions and filters on existing drafts, redeployment, rotation and downgrade. Reordering actions preserves grant identity. Tightening blocks renewal against stale policy. Verify the new limits on redeploy and retire the prior Sandbox. Block disallowed methods, routes and redirects before forwarding.
- **AC-4.** Hold wider rollout until reviewers assess live parent links from B to A and C separately in authorized test repositories. Inspect both sides. Keep the hold if read-only A changes or denied C is exposed or changed.
- **AC-5.** Reject invalid and retired settings. Allow only PR reads and block other API routes. Allow only `issues:create` on B and verify POST succeeds while GET stops before forwarding. Explicit allows must respect Read, missing permissions, Issues read and #7135. With `allow: []`, verify Git works and all API requests stop.
- **AC-6.** With native policy missing, test issuance and renewal separately. Both must fail without fallback for `allow: []` and for a nonempty `deny`, even with no eligible API routes. Under the same conditions verify legacy delivery still works with the filter omitted or `deny: []`.
- **AC-7.** Keep B’s Agent grant at Write and approve only Issues read for the token. Even with `issues:create` listed in `allow`, a valid issue POST must stop before the origin. Verify that the issued permission map remains unchanged.

## Delivery and verification

[#6864](https://github.com/openclaw/openclaw-enterprise/pull/6864) passed six installed tests at `69a61a83`. A controlled origin recorded both parent links despite direct denials. Live private GitHub effects remain unverified. The later draft at `d9b229e2` removed REST versions and supported denying issue creation only. Qualify the complete filter before release.
