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

Use stock `gh api` to create a pull request through one explicit GitHub REST allowlist entry. OpenClaw Control Plane (OCC) authorizes the target when it admits the Agent revision; OpenShell enforces the saved rule and Credential Proxy injects the existing shared GitHub App installation token. Publication requires Write access to the target, Namespace permission to create a pull request, and at least Read access to every repository covered by the token.

## Motivation

[The earlier GitHub App delivery path](https://github.com/openclaw/openclaw-enterprise/pull/7135) let a Dedicated Agent publish a pull request with the bundled `gh` executable. The shared TokenService Source currently supplies credentials for Git transport. Repository policy can separately allow credential-free public metadata reads for selected repositories. An Agent can push a branch, but the current policy does not let it publish a pull request with the bundled GitHub CLI. The existing Credential Proxy policy already supports matches by executable, destination, method, and path.

GitHub accepts a head repository in the [create pull request body](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request). An exact target URL cannot prevent a request from naming another private repository that the shared token can read. A Source covering repositories A and B must therefore provide no publication authority to an Agent granted only A, even when the Agent can push to A.

## Approaches considered

We considered three ways to authorize GitHub API requests:

1. **Pull-based credentials with OCC authorization (WIP).** On first use, Credential Proxy requests a credential from OCC. OCC checks the execution, recipient, and grant before releasing it to the Proxy. Even when the Proxy has a cached credential, it requests a fresh OCC decision before forwarding each operation. This could support authorization against request details, if the contract carries them, but puts OCC in the request path and needs a cold-cache authorization and delivery contract. See the [credential pull discussion](0023-egress-proxy-credential-lifecycle/git-credential-pull.md).
2. **OpenShell GraphQL inspection (WIP for this workflow).** Let the Agent use `gh pr create` and have OpenShell inspect `POST /graphql`. OpenShell's [GraphQL policy](https://docs.nvidia.com/openshell/dev/how-it-works/policies/schema#graphql-rules) can restrict operation types and top-level fields. Allowing a PR mutation is not enough to authorize its repository IDs or input variables, or the other queries made by `gh`. This approach needs Repo policy integration and qualification of those checks before it can protect a shared token.
3. **Explicit REST allowlist for `gh api` (proposed).** OCC admits `/usr/local/bin/gh` for exactly `POST api.github.com:443/repos/{owner}/{repo}/pulls`. OpenShell enforces that rule without a request-time OCC call. The Agent uses `gh api --method POST repos/OWNER/REPO/pulls --input pr.json`; `gh pr create` and GraphQL are outside this proposal. This reuses the existing Source and Provider, but cannot inspect the REST body, so publication is withheld unless the Agent can read every repository covered by the shared token.

## Proposal

At Agent deployment, compose publication with the existing repository policy. For each eligible target, the Repo Driver compiles one rule for the inspected `/usr/local/bin/gh` executable and exact `POST api.github.com:443/repos/{owner}/{repo}/pulls` path. Eligibility requires all of the following:

- The Agent has a Write grant for the target in the admitted revision.
- The selected GitHub App Source has verified `pull_requests:write` permission. The Namespace repository policy must also allow creation on the target after applying its API limits. When `apiLimits` is absent, that policy uses the registered permission.
- Every repository in the Source's complete verified token scope has a Read or Write grant in that Agent revision. A missing, unknown, or unverified member withholds publication for every target using that Source.

Use the complete Source scope for this last check. The selected repository bindings can be narrower. For example, with one Source covering A and B, an Agent with A Write and B Read can publish in A. An Agent with only A Write can still read and push to A under its Git policy, while its publication request is denied.

OCC freezes the exact network and credential-injection matches at admission. The Worker revalidates frozen publication matches against current Source and repository authority before releasing or reconfiguring the revision. Renewal keeps the frozen routes and uses the normal committed-version Proxy delivery. New authority takes effect through a new admission. To remove publication from a serving revision, use withdrawal or Stop, which reduces policy before Provider detach.

The Agent uses stock `gh api` for the REST operation and the managed Supervisor trust bundle for TLS. Dedicated Codex already projects the binding's inert `GITHUB_TOKEN`, which `gh` accepts. Dedicated OpenClaw can pass the same placeholder from its trusted worker data as `GH_TOKEN` for one command. Credential Proxy substitutes the current installation token from the same Source and Provider used by Git. The token remains in the Proxy. This proposal covers one REST operation.

Stock OpenShell can inject the installation token on matching plaintext HTTP on port 443. Its executable match also includes descendants of `/usr/local/bin/gh`. Both temporary exceptions are accepted for this exact publication route. `gh` uses verified HTTPS in the supported flow. Track removal against native TLS-only and socket-opening executable enforcement. Qualify the selected Proxy against the exact route before enabling it on that pair.

GitHub interprets the request body. This operation also accepts an `issue` field that creates a pull request from an existing issue in the target repository, as it did in the earlier delivery path. Review that operation scope before enabling the route. The Source-wide Read check addresses private fork heads covered by the token.

## Interface changes

### APIs, IAM, and database entities

Reuse the Agent repository grants, exact Source operation authorization, Namespace repository configuration, and frozen deployment policy. The existing PostgreSQL validator accepts only smart Git requests for a Repository binding. Update it in a forward migration to accept the exact publication match for a frozen Write grant. No new resource, API operation, IAM action, or database column is planned.

### Driver contracts

Extend the Repo Driver's existing policy compilation to produce an eligible publication match from verified Source scope and Agent grants. Use the existing request match type for separate network and injection rules, and the existing Repository binding for the same Source. TokenService continues to mint and renew the finite installation token from the verified Source.

## Acceptance criteria

- After [shared Source subset admission](https://github.com/openclaw/openclaw-enterprise/pull/7346) is available, deploy two Agents sharing a finite Source for repositories A and B through the normal Agent workflow. With A Write and B Read, the first Agent's stock `gh api` creates a pull request in A. With only A Write, the second Agent can use admitted Git transport for A, but its publication request is denied before it reaches the origin.
- A Read target or an effective permission below `pull_requests:write` grants no publication route. After normal Git withdrawal or Stop, the affected Agent has no publication route. A peer Agent can continue to use its authorized route on the same Source.
- Verify the publication rule with the real Credential Proxy and the bundled `gh` binary. Exercise a wrong repository path, method, host, and a binary outside the accepted executable match. Record the selected pair's behavior for matching plaintext and descendants. Qualify both Dedicated Codex and Dedicated OpenClaw. A live GitHub publication check requires an authorized disposable repository and branches.
