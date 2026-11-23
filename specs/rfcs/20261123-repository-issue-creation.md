---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Opt-in issue creation on stock OpenShell

- **ID:** RFC-20261123-repository-issue-creation
- **Created:** 2026-11-23
- **RFC PR:** [#6861](https://github.com/openclaw/openclaw-enterprise/pull/6861)
- **Related:** [Per-Agent repository network policy](20261119-repository-network-policy.md)

## Summary

Add `scopedRest: "v2"` for selected GitHub App repositories on stock OpenShell 0.1.9. A repository with saved Agent Write and **Issues: write** permits issue creation by default under v2. Its Namespace registration can set `createIssues: false` to disable that route. Other repositories' grants do not veto creation in the writable repository. Defaults, v1 and Git-only access remain unchanged.

## Motivation

An Agent with Read on A, Write on B and no grant on C should be able to create an issue in B while direct writes to A and direct access to C remain denied. GitHub exposes one repository issue-creation POST route. Authorizing that route also accepts GitHub's full request-body behavior, including effects on another repository.

## Proposal

An operator enables `nativeGit: "v1"` and `scopedRest: "v2"` on B’s `github-repository` Namespace registration. All repositories sharing the selected App token must have identical GitHub permission maps, including **Issues: write**. The REST version can differ by repository. Agent grants narrow direct access within that ceiling.

For a new v2 Write grant on B, permit `POST /repos/{owner}/{repo}/issues` on `api.github.com` by default. Set `createIssues: false` on B’s Namespace registration to disable that POST for Agents using the registration. Apply changes by rebinding and redeploying.

**Existing Agents must explicitly adopt new writes.** Enabling v2, raising permissions, or removing the opt-out cannot silently authorize an old draft or saved Write grant. Require an Admin’s explicit selection for that Agent before granting additional routes. An ordinary save or redeploy must preserve the previously approved scope.

The Sandbox Driver compiles the exact method and path into native network policy with an explicit credential binding. Stock OpenShell enforces the direct route and injects the credential from the endpointless Provider outside the Agent. No Worker callback or OCE body check runs. A Read or C denied on the same selected installation token does not prevent B's POST. Direct requests to A and C still follow their own grants.

**This authorizes the full GitHub endpoint.** The rule does not constrain query or JSON fields. GitHub may accept labels, assignees, milestone, type, status, issue-field values and `parent_issue_id`, subject to its permissions and enabled features. Creation can trigger notifications. In particular, GitHub can link the new issue in B to a parent in a differently granted private repository when the caller has triage access to both. That may affect A or C even though the Agent cannot send a direct issue POST there. Native method-and-path enforcement cannot restrict these server-side effects. Administrators requiring title/body-only creation or strict isolation from such effects must disable issue creation. See GitHub's [create-issue contract](https://docs.github.com/en/rest/issues/issues#create-an-issue).

Issue reads and pull-request grants remain independent. The existing [mixed-grant pull-request rule](https://github.com/openclaw/openclaw-enterprise/pull/7135) remains unchanged. `createIssues: false` denies the issue POST only. It does not prevent conversion of an existing issue through an independently permitted pull-request POST. Issue editing, comments, other issue-write routes and GraphQL remain excluded. This proposal adds no token type, grant type, CLI, broker, middleware or OpenShell fork.

## Interface changes

### APIs

Permit the outbound GitHub issue POST route under the stated per-repository conditions. No OCE HTTP API changes.

### IAM

No new OCE IAM permissions. Reuse saved Agent Write and independently approved GitHub **Issues: write**.

### Database entities

No changes.

### Driver contracts

Extend the Repo Driver's selected-repository Namespace registration with `scopedRest: "v2"` and optional `createIssues: false`. Reuse the Sandbox Driver's native route compiler and Credential Proxy's endpointless Provider.

## Simplifications

Stock OpenShell enforces the direct route without a patched supervisor, online OCE validator or credential-wide issue-creation veto. Strict body and server-side effect controls remain upstream work.

## Acceptance Criteria

- **AC-1.** On stock OpenShell 0.1.9, save A Read, B Write and C ungranted for the same Agent and selected installation token. Use identical GitHub permissions including Issues write for A/B/C, v1 on A and v2 on B. On B, omit `createIssues`, rebind and deploy. Use stock `gh api` to create an issue in B and independently verify its repository and number. Verify allowed traffic reaches the controlled origin, direct A creation and C access are denied before forwarding, credentials stay outside the Agent, and Worker callback attempts remain zero.
- **AC-2.** Refuse direct creation before forwarding for default or v1 registration, Git-only access, missing **Issues: write**, saved Read, an ungranted repository, `createIssues: false`, or another method or path. A redirect outside the allowed route must send zero unauthorized HTTP requests to its destination. Change only B's registration to disable creation, rebind and redeploy, and verify other repositories' issue creation and B's permitted reads retain their own behavior. Verify the existing pull-request rule is unchanged and deny-create does not claim to block issue conversion through an allowed PR route.
- **AC-3.** Downgrade B or withdraw its saved grant and redeploy the same Agent. Verify old Sandbox retirement, remaining authorized reads, denial of a fresh POST before forwarding, and no new issue by independent readback. Repeat after credential rotation and registration changes, with a fresh rebind for the latter.
- **AC-4.** In the controlled origin, give the synthetic credential triage access to A, B and C. Create two issues in B, setting `parent_issue_id` first to a parent in read-only A, then to a parent in ungranted private C. Inspect the child and each parent independently. Record direct request and resulting simulated server-side effect separately. This controlled result is not live GitHub proof. Hold broader rollout if read-only A changes or denied C is exposed or changed. Live validation requires separate, specific authorization. Record exact packaged controller, runtime and stock OpenShell images for installed proof. Earlier patched-supervisor evidence does not qualify.
- **AC-5.** Using the same repository reference, upgrade v1 to v2 and separately remove a v2 opt-out. Deploy an old draft and redeploy a serving Agent, including after an unrelated edit that resubmits unchanged selections. Neither gains a new issue POST. Approve one Agent explicitly and verify the other stays denied. Unbind C and redeploy. With B still writable, disable only B’s issue POST and verify an eligible PR succeeds.

## Delivery and verification

[Implementation #6864](https://github.com/openclaw/openclaw-enterprise/pull/6864) passed six installed tests at `69a61a83` on stock OpenShell with a controlled origin. The simulated provider recorded both parent links despite direct denials. Wider rollout remains on hold. Effects on private GitHub repositories are unverified.

At [`fc2ffba3`](https://github.com/openclaw/openclaw-enterprise/blob/fc2ffba3083d5ee0087bd300e61ffde4bf47659e/packages/occ/src/repository-policy.ts#L634-L664), deployment resolves the current registration from a saved reference and profile. The binding hash protects the admitted revision but does not enforce explicit adoption on the next deploy. Require AC-5 before implementation merge. Merging this RFC accepts the design only.
