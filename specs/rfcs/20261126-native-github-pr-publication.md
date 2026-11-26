---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Native GitHub pull request publication

- **ID:** RFC-20261126-native-github-pr-publication
- **Created:** 2026-11-26
- **Last updated:** 2026-11-26
- **Related:** [Credential Design 1.0](20261124-credential-design-1-0/index.md), [repository network policy](20261119-repository-network-policy.md)

## Summary

An Agent with a shared TokenService GitHub App Source can create a pull request in a repository where it has Write access. OpenClaw Control Plane (OCC) admits one GitHub REST operation and requires the Agent to have at least Read access to every repository covered by that Source token. The Credential Proxy injects the token only on the admitted requests.

## Motivation

[The earlier GitHub App delivery path](https://github.com/openclaw/openclaw-enterprise/pull/7135) let a Dedicated Agent publish a pull request with the bundled `gh` executable. Credential Design 1.0 limited shared TokenService Sources to Git transport. A team can push a branch through that path but needs another client to publish the pull request.

GitHub accepts a head repository in the [create pull request body](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request). An exact target URL cannot prevent a request from naming another private repository that the shared token can read. A Source covering repositories A and B must therefore provide no publication authority to an Agent granted only A, even when the Agent can push to A.

## Proposal

At Agent deployment, compose publication with the existing repository policy. For each target eligible for publication, the Repo Driver compiles one HTTPS rule for the inspected `/usr/local/bin/gh` executable and exact `POST api.github.com:443/repos/{owner}/{repo}/pulls` path. Eligibility requires all of the following:

- The Agent has a Write grant for the target in the admitted revision.
- The selected GitHub App Source has verified `pull_requests:write` permission, and the Namespace repository ceiling allows creation on the target.
- Every repository in the Source's complete verified token scope has a Read or Write grant in that Agent revision. A missing, unknown, or unverified member withholds publication for every target using that Source.

Use the complete Source scope for this last check. The selected repository bindings can be narrower. For example, with one Source covering A and B, an Agent with A Write and B Read can publish in A. An Agent with only A Write can still read and push to A under its Git policy, while its publication request is denied.

OCC freezes the exact network and credential-injection matches at admission. The Worker revalidates frozen publication matches against current Source and repository authority before releasing or reconfiguring the revision. Renewal keeps the frozen routes and uses the normal committed-version Proxy delivery. New authority takes effect through a new admission. To remove publication from a serving revision, use withdrawal or Stop, which reduces policy before Provider detach.

The Agent uses stock `gh api` for the exact REST operation. Its process may obtain the inert authorization placeholder from the existing repository Git helper for that target and pass it to `gh` as `GH_TOKEN`. OpenShell substitutes the issuer token only for the admitted request. The worker does not receive the issuer token. The client verifies TLS through the managed Supervisor trust bundle. The current OpenShell policy detects TLS and admits sockets from a matching executable or its descendants. Enable publication only after OpenShell can require TLS and match the socket-opening executable, and those checks pass. GraphQL, other REST routes, and new per-Agent tokens are outside this proposal.

GitHub interprets the request body. This operation also accepts an `issue` field that creates a pull request from an existing issue in the target repository, as it did in the earlier delivery path. Review that operation scope before enabling the route. The Source-wide Read check addresses private fork heads covered by the token.

## Interface changes

### APIs, IAM, and database entities

Reuse the Agent repository grants, exact Source operation authorization, Namespace repository configuration, and frozen deployment policy. The existing PostgreSQL validator accepts only smart Git requests for a Repository binding. Update it in a forward migration to accept the exact publication match for a frozen Write grant. No new resource, API operation, IAM action, or database column is planned.

### Driver contracts

Extend the Repo Driver's existing policy compilation to produce an eligible publication match from verified Source scope and Agent grants. The selected Credential Proxy Driver must enforce the exact executable, HTTPS destination, method, and path, with separate network and credential-injection matches. TokenService continues to mint and renew the finite installation token from the verified Source. Its custody and issuer interface stay the same.

## Acceptance criteria

- After [shared Source subset admission](https://github.com/openclaw/openclaw-enterprise/pull/7346) is available, deploy two Agents sharing a finite Source for repositories A and B through the normal Agent workflow. With A Write and B Read, the first Agent's stock `gh api` creates a pull request in A. With only A Write, the second Agent can use admitted Git transport for A, but its publication request is denied before it reaches the origin.
- A Read target or an effective permission below `pull_requests:write` grants no publication route. After normal Git withdrawal or Stop, the affected Agent has no publication route. A peer Agent can continue to use its authorized route on the same Source.
- Verify the exact executable, scheme, method, and path with the real OpenShell Credential Proxy and the bundled `gh` binary. Reject HTTP and an unapproved executable without sending a credential. Qualify both Dedicated Codex and Dedicated OpenClaw. A live GitHub publication check requires an authorized disposable repository and branches.
