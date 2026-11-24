---
status: Proposed
implementation_status: Not implemented
author: freeqaz
---

# Proposal: Give an Agent Git access without a GitHub App

- **ID:** RFC-20261123-repository-token-source
- **Created:** 2026-11-23
- **Last updated:** 2026-11-24
- **RFC PR:** [#7149](https://github.com/openclaw/openclaw-enterprise/pull/7149)
- **Companions:** [Token lifecycle](lifecycle.md) and [Acceptance and evidence](acceptance.md)
- **Related:** [Issue #6993](https://github.com/openclaw/openclaw-enterprise/issues/6993), [Per-Agent repository network policy](../20261119-repository-network-policy.md), [credential source ownership](../0023-egress-proxy-credential-lifecycle/credential-source-ownership.md)

<a id="problem-and-decision"></a>

## Summary

You can clone a private repository on your laptop. To give your first OpenClaw Enterprise (OCE) Agent the same ability today, you need a GitHub App. Let the Agent clone one repository using a fine-grained personal access token (PAT) you already have or can create. The token stays outside the Agent.

## Motivation

Many teams have no GitHub App. Trying OCE means finding someone who can install one and configuring its private key before the first clone. A developer whose organization allows fine-grained PATs can skip that work.

If you already ran `gh auth login`, the kind of token matters. The usual browser login gives the GitHub CLI an OAuth token. The [standalone development client](../../../docs/guides/repository-credentials/development-token.md) can use it. A saved Agent needs a fine-grained PAT for this path. You supply it explicitly. `occ dev up` leaves your CLI login alone.

<a id="scope"></a>

## Goals

- **G1.** Enforce each Agent's read and write grants on each repository, as on the App path.
- **G2.** Keep the PAT out of API responses, workloads and model credentials.
- **G3.** Replace a PAT without redeploying. Show when each Sandbox has applied it.
- **G4.** End access after revocation or Stop, even during an outage. Retire every copy before deleting its Source.
- **G5.** Start without an App. Preserve existing App registrations and pull request access.

## Non-goals

This covers Git with one credential per revision. [#7243](https://github.com/openclaw/openclaw-enterprise/pull/7243) covers issue and pull request access separately. Other token types and GraphQL are out of scope.

<a id="design"></a>

## Proposal

<a id="enrol-the-source"></a>
<a id="select-it-from-the-registration"></a>

### Clone the first repository

Start with [OpenShell configured for native Git](lifecycle.md#install-and-start-without-a-github-app). Locally, you can administer OCE yourself. On a team, an administrator can do the first three steps once for the Namespace.

1. **Choose a token.** For a first clone, use a PAT limited to `acme/docs` with Metadata and Contents read access. Check the owner, repositories and permissions in GitHub. OCE cannot verify them.
2. **Save it in OCE.** Register a [credential Source](../../../docs/reference/credential-sources/managed-static.md) with `occ credential-source create --file FILE`. In the private input file, set `config.provider_preset` to `github` and `config.repositories` to `acme/docs:read`. Keep the returned Source ID.
3. **Make the repository available.** Put that ID in the repository registration’s `credentialSource` field. Apply the registry change with Helm so the controller and Worker load it. This step is still manual.
4. **Give the Agent access.** Select `acme/docs` on a new Agent, save a Read grant and deploy. Ask it to clone `https://github.com/acme/docs.git`. The clone succeeds. If the Agent tries to push, OpenShell blocks the request before it reaches GitHub.

### Effective access

The Installation, [Namespace registration](lifecycle.md#register-and-read-a-source), Source and Agent grant must all allow the operation. GitHub can still refuse it. For example, two Agents can use one write-capable token while only one can push. Repositories selected together need one credential and identical registration permissions. Set Read on A and Write on B in the Agent’s grants.

<a id="custody-and-loan"></a>
<a id="lifecycle"></a>

The repository Worker supplies the PAT to one OpenShell Provider per Agent revision. The Provider has no endpoints. The Sandbox Driver binds only the allowed Git paths. OpenShell checks each request and substitutes the PAT for a placeholder. Read permits fetch. Write adds push. Direct GitHub REST and GraphQL requests stay blocked.

In [#7153](https://github.com/openclaw/openclaw-enterprise/pull/7153), Git can keep working for up to 15 minutes after permission is revoked, even on a healthy network. We propose [withdrawing access when the Worker detects revocation](lifecycle.md#revocation-stale-sources-and-stop). If it cannot reach the Sandbox, the credential expires there. An administrator could choose a shorter limit.

### Save and deploy

OCE [checks the grants](lifecycle.md#save-and-deploy) before saving or deploying. An editor can still clear grants and a user with Agent `operate` can still stop the Agent after losing access to the Source.

<a id="read-the-policy"></a>

## Interface changes

### APIs

- `POST /namespaces/{namespaceId}/credential-sources` accepts the `github` preset. OCE checks token format and size without calling GitHub.
- `PATCH` on `.../credential-sources/{credentialSourceId}` [rotates the token](lifecycle.md#replace). `DELETE` [returns `409`](lifecycle.md#retire) while the registry still uses the Source or any copy is unretired.
- `GET .../sandbox-policy/networking` shows [which credential the Agent uses](lifecycle.md#register-and-read-a-source). Policy save, validation and deployment enforce the [same limits](lifecycle.md#save-and-deploy).

### IAM

Creation requires `credential_source:create` on the Namespace collection. Replacement and deletion require `credential_source:update` and `credential_source:delete`, respectively, on that Source. Save and deploy additionally require `credential_source:operate` for caller and Agent principal. Policy readers need `credential_source:read` on the exact Source for details. Clearing and Stop need no Source permission.

### Database entities

[#7153](https://github.com/openclaw/openclaw-enterprise/pull/7153) records each revision’s copy before queuing deployment. [#7202](https://github.com/openclaw/openclaw-enterprise/pull/7202) records the expected version and time on rotation. The copy record contains no token value.

### Driver contracts

The Repo Driver resolves a GitHub App installation or a Source in the same Namespace. Changing the Source invalidates earlier grants. App grant identities stay unchanged. The repository Worker uses the Credential Proxy Driver’s native Git Provider to install, track and retire each copy. The Sandbox Driver accepts its distinct name prefix. TokenService already returns the version.

## Simplifications

Reusing Sources gives us [audited replacement](https://github.com/openclaw/openclaw-enterprise/pull/7006) and [guarded deletion](../../../packages/occ/src/managed-credential-sources.ts). We avoid mounting a Secret in the Worker or handing the Agent the developer’s CLI credentials. No new service or Agent field is needed.

## Acceptance Criteria

[AC-1 through AC-10](acceptance.md#acceptance-criteria) cover first use without an App, denied operations, replacement and withdrawal.

## Delivery and verification

[#7152](https://github.com/openclaw/openclaw-enterprise/pull/7152) registers the token. #7153 delivers it. [Installed results](acceptance.md#delivery-and-verification) include a GitHub clone and push. Prompt withdrawal and a configurable expiry remain proposals.

<a id="alternatives-and-open-decisions"></a>

## Unresolved questions

- **Revocation.** How quickly should a connected Sandbox stop using the PAT? What shorter expiry limits should an installation be able to choose? [AC-5](acceptance.md#acceptance-criteria) measures the two cases separately.
- **Rotation.** Does the lock and write record described in [the lifecycle](lifecycle.md#serialize-provider-writes) cover a write that arrives late? AC-4 requires that it cannot extend access.
- **Configuration.** Should the repository list have a typed field? The existing string field holds 2,048 characters.
