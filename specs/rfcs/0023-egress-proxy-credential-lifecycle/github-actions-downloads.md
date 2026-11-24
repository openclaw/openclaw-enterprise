---
rfc: index.md
---

# Let the GitHub CLI follow Actions download redirects

An Agent can list a failed job yet be unable to read its log. GitHub
authorizes the API request, then redirects `gh run view --log-failed` to a
short-lived signed URL. If the CLI cannot match a job to a file in the run
archive, it requests the individual job log. That download can use a different
host. Result artifacts also use signed URLs.

**Decision for review.** Should new protected, dedicated Codex revisions with
online `github_repository` access let `/usr/local/bin/gh` reach the Actions
download hosts by default? This would let the Agent investigate a failure
without asking an operator to download and forward logs.

## What the Driver would allow

Keep the existing repository check on every request to `api.github.com`.
For a private repository, the GitHub App needs
[Actions read permission](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run).
The storage request uses the signed URL. Do not attach the GitHub credential
to storage requests.

Allow the CLI to connect on TCP port 443 to
`results-receiver.actions.githubusercontent.com` and the exact GitHub result
storage accounts. At release time, take exact names such as
`productionresultssa9.blob.core.windows.net` from
[`domains.actions` in GitHub's metadata](https://api.github.com/meta).
The same job can use different accounts on consecutive runs. Do not use an
Azure wildcard or fetch policy from GitHub during deployment.

This grants more than log reads. The client verifies TLS. The Sandbox does
not inspect the HTTP method, path or headers on these storage connections.
The CLI can use another signed URL, including one that permits a write or
refers to a different repository. Once withdrawal takes effect, the proxy
refuses new requests for that repository. A signed URL can remain usable until it
expires. Maintainers must decide whether that tradeoff is acceptable for
every qualifying revision.

## Admission and recovery

Pass the existing `RepositoryGitDeliveryProfile` as an optional argument to
[`admitProtectedCodexArtifactPolicy`](contracts.md#protected-codex-artifact-downloads).
OCC passes the profile only for the online route when the selected bindings
and the egress plan agree. The OpenShell Sandbox Driver owns the host list
and executable rule. An omitted or different profile gets no download rule.
Native Git grants and the inspected, read-only Codex plugin rules stay
unchanged. This requires no new API, IAM grant type or database field.

Store the exact rule in the existing revision snapshot. A running revision
never inherits new hosts. Upgrade all readers before admitting the first
revision with the rule. Keep each previously admitted list readable when
the published hosts change. A compatible controller used for recovery
preserves the grant. To withdraw it, deploy a revision that does not qualify.

## Acceptance

- Through an installed Supervisor, use `gh run view --log-failed` on a selected
  repository. Check the expected failure text, including a job that needs the
  individual log fallback. Verify an artifact against its published digest.
  An exit code alone can miss an empty log.
- Verify the storage requests carry no GitHub authorization header. Deny an
  unrelated storage host and a different executable without a separate grant.
  Keep signed URLs out of diagnostics.
- Deny API requests for an unselected repository and again after removing a
  selected repository. Verify neither request reaches GitHub. Continue the
  same Agent conversation after removal.
- Recover with the compatible controller after writing a revision. Check
  both the stored rule and the policy loaded by the Supervisor. Check that
  an older revision still has exactly its original access.
