---
status: Proposed
implementation_status: Partially implemented
author: stevenlee-oai
---

# Use a saved ChatGPT account for a Codex Harness

- **ID:** RFC-0030
- **Created:** 2026-11-05
- **RFC and implementation PR:** [#4794](https://github.com/openclaw/openclaw-enterprise/pull/4794)
- **Implementation plan:** [TASK-0051](../plans/0051-codex-saved-accounts.md)

## Decision for review

A user signs in to ChatGPT once in a Namespace. They can select the saved account when configuring each dedicated Codex Agent. Removing one Agent's access leaves the other Agents' grants and the user's account intact.

[RFC-0027](0027-agent-oauth-connections/index.md) defines saved OAuth connections, Token Service custody and per-Agent grants. Its original scope excludes Harness authentication. This proposal extends that model to the dedicated Codex Harness. It complements the [Harness auth source proposal](https://github.com/openclaw/openclaw-enterprise/pull/4512).

## Connect an account

OCC provisions an Installation-wide Codex connection template and the native public OAuth client. The registration identifies the OpenAI issuer, device sign-in endpoints, provider-owned callback and client ID. The token endpoint authentication method is `none`. These values identify the reviewed native protocol. An administrator cannot redirect the model account's token to a different server by editing a template or registering another client for the same issuer.

A user who can create credentials starts device sign-in from Credentials or the Agent's Harness configuration. OCE gives the user a verification URL and code. The control plane binds its temporary provider state to the authenticated user, browser session, Namespace and originating Agent context. Only that session may poll or cancel. An expired, cancelled or completed attempt cannot authorize an additional account. A new Agent can be configured before it has an ID. Access is granted when the user saves that Agent.

The Refresh Driver polls the provider. After approval, it redeems the code at the pinned token endpoint and hands the initial access token and reusable refresh grant to the Token Service. OCC records the consenting principal, template and client registration, and the provider-supplied ChatGPT account identity. It publishes the ready account only after the custody handoff succeeds. The Token Service owns rotation for all Agents that share the account. OCC treats a rotation of uncertain outcome as requiring recovery, so competing Agents cannot replay a spent refresh token.

## Select and use the account

The picker lists completed Codex connections that the caller can use in the current Namespace. Saving a Harness binding requires authority over the Agent and authority to use the exact source. OCC records the grant for that Agent. A generic OAuth account for the same issuer cannot supply the ChatGPT account identity required for model access.

The worker verifies the Agent's current grant before delivering an access token to its bound Credential Gateway. The dedicated Codex process receives the existing external-auth placeholder and ChatGPT account metadata. The Gateway supplies the bearer token only for approved model requests. The hosted Codex app catalog uses the same account and checks its authorization before sending the access token and account header to the reviewed provider. Neither consumer receives a refresh token.

Detaching withdraws the Agent's delivery through the existing durable cleanup path. Disconnecting the saved account withdraws every Agent's access and retires the grant. Existing Gateway-managed sources can continue to run. Since those sources lack a consent owner, a user completes device sign-in to create a reusable personal connection.

## Verification

Exercise the device exchange, custody, selecting one account for two Agents and withdrawing one binding. Verify that another user cannot poll the attempt or select the account without permission. Verify the receiver, allowed destinations and ChatGPT account identity at the delivery boundary. Qualify a live ChatGPT model turn separately from controlled provider integration tests.
