---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Proposal: Read issues and open pull requests without a GitHub App

- **ID:** RFC-20261124-pat-repository-api
- **Created:** 2026-11-24
- **Last updated:** 2026-11-24
- **RFC PR:** [#7243](https://github.com/openclaw/openclaw-enterprise/pull/7243)
- **Related:** [Git access without a GitHub App](https://github.com/openclaw/openclaw-enterprise/pull/7149), [implementation](https://github.com/openclaw/openclaw-enterprise/pull/7247), [repository network policy](20261119-repository-network-policy.md)

## Summary

A developer asks an Agent to fix issue 42 and open a pull request (PR). Git access lets the Agent push a fix. It still needs API access to read the issue and open the PR. Let it finish the task with a fine-grained personal access token (PAT) held by OCE.

## One token, different grants

1. Save the PAT as a credential Source. List `acme/docs:write:api` to allow Git and API access. Omitting `:api` keeps that repository Git-only. Adding API access later requires a new Source.
2. Allow Contents write, Issues read and Pull requests write in the Namespace. Select `acme/docs` for two Agents. Give the first Read and the second Write. Both can read issue 42. Only the second can push and open a PR. Neither can post to the issue creation route.
3. The controller checks who can grant access. At deployment, the Sandbox Driver translates the grants into OpenShell network rules. OpenShell checks each request and adds the PAT only on allowed routes. GitHub checks the PAT’s permissions.

Both Agents use the standard GitHub CLI with a placeholder in `GITHUB_TOKEN`.

```sh
gh api repos/acme/docs/issues/42
# After pushing fix-docs, submit the title, head (fix-docs) and base (main) in pr.json.
gh api --method POST repos/acme/docs/pulls --input pr.json
```

OpenShell blocks the first Agent’s POST even if it uses another HTTP client.

The PAT can do more than the first Agent. Before saving or replacing it, check the resource owner in GitHub, match the selected repositories to the full set declared for the Source, and grant the minimum permissions. Stop if you cannot verify these settings. OCE cannot check them for you. [GitHub’s public repository read access](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) adds no Sandbox routes.

## Interface changes

### APIs

The Installation, Source, Namespace and Agent grant must all allow the operation. Set `permissions.issues` and `permissions.pull_requests` independently. Read allows listing and reading. Write also allows creation by default. Namespace and Agent `apiLimits` can narrow either permission. To keep Git only, replace the entire limits object with `{"default":"none"}`. Per-resource overrides take precedence.

Changing the repository set while keeping API access requires a new Source. Reselect the repository when its grant changes, including before a draft’s first deployment. Rotating the PAT within the same scope preserves the selection. Before upgrading, rename and reselect any configured `repositoryRef` matching `pat-api-` plus 64 lowercase hexadecimal digits.

### IAM

No new action. The caller and Agent need Source `operate`. With a saved policy, changing bindings while retaining API access requires Agent update, `manage_policy` and SandboxPolicy read and update. Editors can still clear all bindings.

### Database entities

No changes.

### Driver contracts

The Repo Driver resolves repositories with identical Namespace permissions. Under the [PR safeguard](https://github.com/openclaw/openclaw-enterprise/pull/7135), a bound repository without a grant disables PR creation. If PR creation remains enabled but the Source lists an ungranted repository, OCE refuses to save the policy, deploy or renew access. Issue creation remains independent.

## Simplifications

Reuse the [existing GitHub routes](20261123-repository-issue-creation.md) and the [repository Worker’s delivery path](https://github.com/openclaw/openclaw-enterprise/blob/a448eac9fdc6ac4040a37f89907432d5da8bf421/docs/reference/repository-credentials/repository-token-source.md). Git and REST share one Provider per revision. This avoids a second credential copy and a call to OCE on each request. Comments, PR edits, merges and GraphQL stay out of scope. OpenShell owns any stricter body or query checks.

## Acceptance Criteria

- **AC-1. Upgrade a Git-only Agent.** Git still works and API requests fail. Reject stale selections on first deployment and redeployment until a policy editor selects the new grant. Restoring a registration must not restore a withdrawn grant.
- **AC-2. Check direct requests.** On stock OpenShell 0.1.9 with a controlled origin, give one Agent Read on A and Write on B. Exclude private C from the token, bindings and grants. Read issues and PRs, push to B and independently verify a new issue and PR. Verify that writes to A and direct requests to C never reach the origin. Check both PR safeguards and API limits. Verify zero OCE callbacks and no PAT in the Agent.
- **AC-3. Replace and withdraw.** Keep the old synthetic token valid. Verify requests use its replacement without logging either token. Downgrade B, redeploy and verify the old Sandbox retires, reads work and writes fail. Withdraw all access. Refuse new loans and verify the old Sandbox loses access on expiry or Provider retirement. Withhold the PAT if policy or recipient identity is uncertain. If a Provider write has an unknown outcome, stop the Agent and verify retirement.
- **AC-4. Check indirect effects.** GitHub interprets an allowed request. A PR on B can name a fork head or convert an issue. A parent link can affect A. Before broader rollout, test these cases and triggered workflows on GitHub. Verify A stayed unchanged and private C was neither exposed nor changed. A controlled origin alone cannot prove that.

## Delivery and verification

Start with a dedicated PAT for one private repository. Land [enrollment](https://github.com/openclaw/openclaw-enterprise/pull/7152) and [Git delivery](https://github.com/openclaw/openclaw-enterprise/pull/7153) before [#7247](https://github.com/openclaw/openclaw-enterprise/pull/7247). Installed PAT API behavior and live GitHub effects remain unverified.
