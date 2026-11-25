---
status: Proposed
implementation_status: Not implemented
author: freeqaz
---

# Proposal: Give an Agent Git access without a GitHub App

- **ID:** RFC-20261123-repository-token-source
- **Created:** 2026-11-23
- **Last updated:** 2026-11-25
- **RFC PR:** [#7149](https://github.com/openclaw/openclaw-enterprise/pull/7149)
- **Companions:** [Token lifecycle](lifecycle.md) and [Acceptance and evidence](acceptance.md)
- **Related:** [Issue #6993](https://github.com/openclaw/openclaw-enterprise/issues/6993), [Per-Agent repository network policy](../20261119-repository-network-policy.md), [credential source ownership](../0023-egress-proxy-credential-lifecycle/credential-source-ownership.md)

<a id="problem-and-decision"></a>

## Summary

Give a saved Agent Git access to a private repository without installing a GitHub App. On a fresh local installation, one proposed command prepares the repository. You still choose which Agent can clone it. The Agent never receives your personal access token (PAT).

## Motivation

You may already be able to clone a repository on your laptop, even if your team has no GitHub App. The usual browser login for `gh` gives you an OAuth token. The [standalone development client](../../../docs/guides/repository-credentials/development-token.md) can use it. This proposal for saved Agents accepts a fine-grained PAT, including one already on your machine.

Why does setup take two steps? OCE assigns the credential a Source ID when you save it. The installation’s repository registry must refer to that ID before an Agent can select the repository. Let the local launcher do this for you on a fresh install. Keep the administrator in control of an existing registry.

<a id="scope"></a>

## Goals

- **G1.** Enforce Read and Write per repository and Agent.
- **G2.** Keep the PAT out of workloads, responses and model credentials.
- **G3.** Rotate in place and show when each Sandbox has applied the change.
- **G4.** Bound access after revocation, end it at Stop and retire every copy before deletion.
- **G5.** Make the first local clone simple. Preserve existing App grants and pull request access.

## Non-goals

This proposal covers Git with one credential per revision. [#7243](https://github.com/openclaw/openclaw-enterprise/pull/7243) addresses GitHub API access separately. Neither shortcut imports a GitHub CLI login or enables Write.

<a id="design"></a>

## Proposal

<a id="enrol-the-source"></a>
<a id="select-it-from-the-registration"></a>

### First local clone

1. Choose an existing fine-grained PAT or create one limited to `acme/docs` with Metadata and Contents read access. Check the owner, selection and permissions again on replacement. OCE cannot verify the token’s reach.
2. The proposed command is `occ dev up --github-repo acme/docs < "$PAT_FILE"`. The launcher [prepares a new local Namespace](lifecycle.md#install-and-start-without-a-github-app), registers the repository and verifies it is available for Read.
3. Select `acme/docs` on the Agent, explicitly save Read and deploy. Ask it to clone `https://github.com/acme/docs.git`.

### Existing installation

Use the proposed `occ credential-source create --github-repo acme/docs < "$PAT_FILE"` to save just the Source. Both commands also accept a pipe, so the token need not be written to disk. An administrator [registers its ID](lifecycle.md#register-and-read-a-source) in that Namespace and applies the configuration. Step 3 stays the same.

<a id="custody-and-loan"></a>
<a id="lifecycle"></a>

### Effective access

The Installation, registration, Source and saved grant must all permit an operation. GitHub can still refuse it. OpenShell substitutes the PAT for a placeholder on authorized Git requests. Read allows fetch. Write adds push. Direct REST and GraphQL stay blocked.

The earlier Worker let Git continue until expiry even on a healthy network. On [revocation](lifecycle.md#revocation-stale-sources-and-stop), a connected Worker should withdraw the credential promptly. During an outage, the Sandbox must stop using it by the earlier of grant expiry and 15 minutes from the last authority check. We propose allowing a shorter limit.

<a id="read-the-policy"></a>

## Interface changes

### APIs

[Source create, replace and delete](lifecycle.md#register-and-read-a-source) use the Namespace API. The networking policy shows the credential and delivery state to authorized readers.

### IAM

Source creation requires `credential_source:create` on the collection. Read, update and delete require the respective permission on the Source. Save and deploy require Source `operate` for caller and Agent principal. Clearing grants and Stop retain normal Agent permissions.

### Database entities

[Track each revision’s delivery](lifecycle.md#record-installed-copies), including pending writes, through cleanup. Store no PAT in these records.

### Driver contracts

The Repo Driver resolves an App or a same-Namespace Source. Changing the Source invalidates earlier grants. The native Credential Proxy delivers to one endpointless Provider per revision. The Sandbox Driver binds the saved Git paths.

## Simplifications

Reuse TokenService for custody and native delivery for the installed copy. Passing the token on standard input keeps it out of setup subprocesses and Helm values. A globally exported token could be inherited by build tools.

## Acceptance Criteria

[AC-1 through AC-10](acceptance.md#acceptance-criteria) include a cold start with no App, CLI login or hand-edited registry.

## Delivery and verification

[The credential changes in #7224](https://github.com/openclaw/openclaw-enterprise/commit/105ffee9962176cf42fc7cfe013b8b94831435db) include TokenService and the native Credential Proxy. [#7152](https://github.com/openclaw/openclaw-enterprise/pull/7152) covers enrollment. The local launcher and saved-Agent delivery on this baseline remain proposed. [Earlier installed runs](acceptance.md#delivery-and-verification) used a different implementation.

<a id="alternatives-and-open-decisions"></a>

## Unresolved questions

- How quickly must a connected Sandbox withdraw access? Which shorter expiry limits should operators get?
- Can a delayed Provider write restore access after the Worker loses its lock?
- Should a typed repository list replace the 2,048-character configuration field?
