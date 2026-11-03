---
rfc: ../rfcs/0027-agent-oauth-connections/index.md
---

# Implementation plan: Connect an OAuth account and grant individual Agents access

- **ID:** RFC-0027
- **Delivery status:** In progress
- **Owner:** mrunalp
- **Authority:** [RFC-0027](../rfcs/0027-agent-oauth-connections/index.md)
  and its [contracts companion](../rfcs/0027-agent-oauth-connections/contracts.md).

## Outcome and scope

An Installation administrator publishes a connection template. A person consents
once and saves the account in a Namespace. A caller with source-use authority
and permission to update a target Agent can attach it. Each attached Agent uses
its own service principal. The runtime admits requests within the approved
endpoint, effective provider scopes, and Installation policy.

## Implementation

1. **Backend connections.** Implement template IAM and versioning, client
   registrations, browser consent with PKCE, and separate operations to attach,
   detach and disconnect a saved source. Keep pending consent unavailable to
   ordinary source binding. Detach must withdraw that Agent's running and
   admitted revisions and preserve independent copies on other Agents.
2. **Console.** Expose template administration, connect/reconnect, the saved
   source picker and per-Agent attach/detach. Show the consequences of both
   detaching one Agent and retiring an account used by several Agents.
3. **Preset and provider options.** Add Preset connection suggestions and OIDC
   account verification. Extend per-request policies as runtime Drivers gain the
   ability to enforce them. A Driver must reject unsupported restrictions.

## Verification

- Exercise browser consent and code exchange against an OAuth provider, including
  state replay, a different browser session, revoked access and template version
  changes. Scope client registrations to the issuer and client ID.
- Attach the same completed source to two Agents. Deny an ungranted Agent and a
  caller who only edits the target. Detach one, exercise its earlier revision and
  check the other Agent still has its source and grant.
- Exercise the actual runtime for any claimed endpoint, method or operation
  policy. An Installation can impose its own executable ceiling. For stock
  OpenShell, test refusal of unsupported template-level read-only enforcement.
- Verify Console flows separately when their implementation lands.

## Delivery record

[The backend PR](https://github.com/openclaw/openclaw-enterprise/pull/3098)
implements browser consent, Agent attachment, and withdrawal.

## Manual Notes

## Changelog

- 2026-10-21: Planned three stacked PRs from RFC-0023 at `c1f7244d4` (session
  `session_01HzmRt1DGB79VEnEWHt7PRy`).
