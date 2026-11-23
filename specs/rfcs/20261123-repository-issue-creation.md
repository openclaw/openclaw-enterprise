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

Add an explicit `scopedRest: "v2"` option for selected GitHub App repositories. An Agent with saved Write can create issues through stock OpenShell 0.1.9 when every repository covered by its installation token also has the required issue-write authority. Defaults and v1 remain unchanged.

## Motivation

Agents can read issues but cannot create them under the current scoped REST grant. GitHub supports issue creation through one repository POST route. Its request body can also change metadata or link a parent issue in another repository, so authorizing the destination path alone is insufficient.

## Proposal

An operator selects `nativeGit: "v1"` and `scopedRest: "v2"` on each participating `github-repository` Namespace registration and approves **Issues: write**. An Admin saves Agent **Write**, rebinds the credential and redeploys. The Repo Driver may then permit `POST /repos/{owner}/{repo}/issues` on `api.github.com`. The Sandbox Driver compiles the exact method and path into native network policy with an explicit credential binding. OpenShell enforces the route and injects the credential from the endpointless Provider outside the Agent. No Worker callback or OCE body check runs.

**The selected installation token's complete repository scope is the boundary.** GitHub accepts `parent_issue_id` and can link to a parent in another repository when the caller has triage access to both. Withhold issue creation across the token unless its complete repository scope is verified and every covered repository is bound, explicitly selects v2, has **Issues: write**, and has saved Agent **Write**. Unknown or broader scope disables creation. If A is Read and B is Write on one token, B creation is disabled. Bind B alone to enable it when the selected token is confined to B. Recheck on binding, deployment and rotation.

**This authorizes the full GitHub endpoint.** GitHub may accept labels, assignees, milestone, type, status, issue-field values and parent links, subject to its permissions and enabled features. Creation can trigger notifications. Parent links within the authorized repository set are allowed. Administrators requiring title/body-only creation or stricter restrictions must leave v2 disabled until GitHub or upstream OpenShell can enforce them. See GitHub's [create-issue contract](https://docs.github.com/en/rest/issues/issues#create-an-issue).

Issue reads and separately authorized pull-request operations retain their existing rules. Issue editing, comments, other issue-write routes and GraphQL remain excluded. This proposal adds no token type, grant type, CLI, broker, middleware or OpenShell fork.

## Interface changes

### APIs

Add the outbound GitHub issue POST route under the stated conditions. No OCE HTTP API changes.

### IAM

No new OCE IAM permissions. Reuse saved Agent Write and independently approved GitHub **Issues: write**.

### Database entities

No changes.

### Driver contracts

Extend the Repo Driver's selected-repository registration with `scopedRest: "v2"` and require the complete installation token scope check. Reuse the Sandbox Driver's native route compiler and Credential Proxy's endpointless Provider.

## Simplifications

Stock OpenShell enforces the exact route without a patched supervisor or online OCE validator. This intentionally gives up title/body-only enforcement.

## Acceptance Criteria

- **AC-1.** On stock OpenShell 0.1.9, use the normal saved-Agent workflow to bind B alone or multiple repositories, each with v2, **Issues: write** and saved Write. Use stock `gh api` to create an issue in B and independently verify its repository and number. Verify allowed traffic reaches the controlled origin, credentials stay outside the Agent, and Worker callback attempts remain zero.
- **AC-2.** Refuse creation before forwarding for default or v1 registration, missing permission, saved Read, an ungranted repository, or another method or path. A redirect outside the allowed route must send zero unauthorized HTTP requests to its destination. Withhold B creation when one token also covers A Read, a repository without v2 or **Issues: write**, or unknown or broader scope. Preserve permitted Git and REST reads.
- **AC-3.** Downgrade B or withdraw its saved grant and redeploy the same Agent. Require a fresh rebind when changing registration. Verify old Sandbox retirement, remaining authorized reads, denial of a fresh POST before forwarding, and no new issue by independent readback. Repeat after rotation and token-scope changes.
- **AC-4.** Verify no OCE body validator or callback runs and issue creation grants no additional pull-request authority. Record the exact packaged controller, runtime and stock OpenShell images for installed proof. Earlier patched-supervisor evidence does not qualify.

## Delivery and verification

Submit this RFC before changing the Driver contract. The selected behavior and installed acceptance criteria remain unverified until implementation and qualification complete.
