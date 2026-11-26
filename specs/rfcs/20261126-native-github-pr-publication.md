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

[The earlier GitHub App delivery path](https://github.com/openclaw/openclaw-enterprise/pull/7135) let a Dedicated Agent publish a pull request with the bundled `gh` executable. The current GitHub Repo policy for shared TokenService Sources admits Git transport. An Agent can push a branch through that path and needs another client to publish the pull request. The existing Credential Proxy policy already supports matches by executable, destination, method, and path.

GitHub accepts a head repository in the [create pull request body](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request). An exact target URL cannot prevent a request from naming another private repository that the shared token can read. A Source covering repositories A and B must therefore provide no publication authority to an Agent granted only A, even when the Agent can push to A.

## Proposal

At Agent deployment, compose publication with the existing repository policy. For each target eligible for publication, the Repo Driver compiles one HTTPS rule for the inspected `/usr/local/bin/gh` executable and exact `POST api.github.com:443/repos/{owner}/{repo}/pulls` path. Eligibility requires all of the following:

- The Agent has a Write grant for the target in the admitted revision.
- The selected GitHub App Source has verified `pull_requests:write` permission, and the Namespace repository ceiling allows creation on the target.
- Every repository in the Source's complete verified token scope has a Read or Write grant in that Agent revision. A missing, unknown, or unverified member withholds publication for every target using that Source.

Use the complete Source scope for this last check. The selected repository bindings can be narrower. For example, with one Source covering A and B, an Agent with A Write and B Read can publish in A. An Agent with only A Write can still read and push to A under its Git policy, while its publication request is denied.

OCC freezes the exact network and credential-injection matches at admission. The Worker revalidates frozen publication matches against current Source and repository authority before releasing or reconfiguring the revision. Renewal keeps the frozen routes and uses the normal committed-version Proxy delivery. New authority takes effect through a new admission. To remove publication from a serving revision, use withdrawal or Stop, which reduces policy before Provider detach.

The Agent uses stock `gh api` for the REST operation. The trusted Harness execution configuration supplies the binding's inert placeholder as `GH_TOKEN` for the command and uses the managed Supervisor trust bundle for TLS. Credential Proxy substitutes the current installation token from the same Source and Provider used by Git. The token remains in the Proxy. This proposal covers one REST operation.

Qualify the selected Proxy for the publication rule before enabling it. Current OpenShell can accept matching plaintext on port 443 and match an executable through a process ancestor. Existing accepted exceptions are specific to their named credentials and requests. Withhold GitHub publication on a pair whose behavior does not meet the rule unless reviewers explicitly accept an exception for this route.

GitHub interprets the request body. This operation also accepts an `issue` field that creates a pull request from an existing issue in the target repository, as it did in the earlier delivery path. Review that operation scope before enabling the route. The Source-wide Read check addresses private fork heads covered by the token.

## Interface changes

### APIs, IAM, and database entities

Reuse the Agent repository grants, exact Source operation authorization, Namespace repository configuration, and frozen deployment policy. The existing PostgreSQL validator accepts only smart Git requests for a Repository binding. Update it in a forward migration to accept the exact publication match for a frozen Write grant. No new resource, API operation, IAM action, or database column is planned.

### Driver contracts

Extend the Repo Driver's existing policy compilation to produce an eligible publication match from verified Source scope and Agent grants. Use the existing request match type for separate network and injection rules, and the existing Repository binding for the same Source. TokenService continues to mint and renew the finite installation token from the verified Source.

## Acceptance criteria

- After [shared Source subset admission](https://github.com/openclaw/openclaw-enterprise/pull/7346) is available, deploy two Agents sharing a finite Source for repositories A and B through the normal Agent workflow. With A Write and B Read, the first Agent's stock `gh api` creates a pull request in A. With only A Write, the second Agent can use admitted Git transport for A, but its publication request is denied before it reaches the origin.
- A Read target or an effective permission below `pull_requests:write` grants no publication route. After normal Git withdrawal or Stop, the affected Agent has no publication route. A peer Agent can continue to use its authorized route on the same Source.
- Verify the publication rule with the real Credential Proxy and the bundled `gh` binary. Exercise matching plaintext and an unapproved executable under a matching ancestor. Record any explicit exception for the selected pair. Qualify both Dedicated Codex and Dedicated OpenClaw. A live GitHub publication check requires an authorized disposable repository and branches.
