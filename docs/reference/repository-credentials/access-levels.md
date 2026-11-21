# GitHub access levels

Choose the least access the Agent needs. Each binding selects one level for one
repository; Namespace policy determines which levels are available.

## Registry profiles

The registry's `namespaces[].profiles` lists the access modes that Agents in that
OCE Namespace may select for the repository. An Agent's
`repositoryBindings[].profile` selects one allowed mode. OCE rejects a binding
whose profile is not allowed by the Namespace policy.

| Profile             | Permission selection                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| `github-repository` | Uses the registry's explicit `permissions` map for the selected repositories. |
| `git-read`          | Requests the predefined read-access profile.                                  |
| `git-write`         | Requests the predefined contribution profile.                                 |
| `git-full`          | Requests the predefined contribution profile with issue management.           |

For `github-repository`, `profiles` must contain only that value and the Namespace
policy must include `permissions`. For example, `contents: write` and
`metadata: read` permit content writes and metadata reads within the supported
[protected repository route](protected-openshell-git.md#use-the-admitted-repository).
GitHub App permissions and repository rules still apply. This profile does not
accept an OCE branch allowlist; GitHub governs branch restrictions.

For one `github-repository` binding, the Installation and Namespace can opt into
[standing approval](../../guides/repository-credentials.md#keep-git-access-on-the-same-running-agent).
The approved scope includes the exact repository identity and permission map.
Multiple selected repositories remain finite; standing approval does not extend
the lifetime of individual sessions or tokens.

The other profiles do not accept a custom registry `permissions` map. Their
effective permissions and supported operations depend on the selected delivery,
as described below. `git-full` does not mean unrestricted GitHub administration.

Installation-wide access uses a separate
[`installationAccess` entry](protected-openshell-git.md#grant-access-to-a-github-app-installation);
`github-installation` is not a value in a repository's `profiles` list.

## Console access levels

| Console choice          | Configuration value | Meaning                                                                       |
| ----------------------- | ------------------- | ----------------------------------------------------------------------------- |
| Read-only               | `git-read`          | Requests read access where the selected delivery supports it.                 |
| Contributor, issues off | `git-write`         | Requests write access subject to the selected repository policy and delivery. |
| Contributor             | `git-full`          | Requests broader access where the selected delivery supports it.              |

These labels express requested access, not a token permission map or a guarantee that any
particular command is available. The [prepared native profile](prepared-native-git.md) accepts
`git-write` for one repository and one exact writable ref. Its Git-only transport permits Git
operations; `git-and-draft-pr` also permits one draft PR for the approved head and base. The
worker requests only the provider permissions needed for that selected transport.

The separately selected [development token authority](development-token.md) retains the token's
own GitHub permissions. Its profile controls forwarded REST write routes, and its configured
allowlist bounds Git pushes. GraphQL is denied unless explicitly enabled for an eligible token;
when enabled it remains read-only and is unavailable to `git-read`.

The Console starts with Contributor as the Agent default. Added repositories
inherit it until customized by expanding their card. Turning off issue management
selects `git-write`; each repository must permit its resulting profile.

Agent create, provision, and update requests can use `repositoryAccess`:

```json
{
  "defaultProfile": "git-write",
  "repositories": [{ "repositoryRef": "application" }]
}
```

An omitted entry profile inherits `defaultProfile`. An explicit profile remains
custom even when equal to the default. Responses retain this intent alongside
resolved `repositoryBindings`; saved versions contain concrete profiles.
Changing desired access affects future deployments only. An empty repositories
array removes attachments while retaining the default.

`repositoryAccess` and `repositoryBindings` are mutually exclusive request fields.
For direct `repositoryBindings`, omitting `profile` selects `github-repository`
when that is the registry policy's sole profile; otherwise it selects `git-write`.
Agents without saved intent open with their existing profiles marked custom.
Omitting both fields during update preserves existing settings; updating direct
bindings clears inheritance intent. Profiles remain subject to Namespace policy.

## API and branch boundaries

GitHub App `contents: write` permission is repository-wide. The prepared native sender enforces
the exact approved ref before sending the push; GitHub repository rules still apply. The
[push-ref guardrail](push-ref-guardrail.md) explains what the client hook and sender each enforce.
A push can trigger repository CI, so review that CI's own secret and execution policy.

A Git-only session does not admit REST or GraphQL. Draft transport admits only its bounded draft
operation. Neither profile supports arbitrary GitHub CLI commands, merges, forks, SSH or LFS.
A lost response does not authorize repeating a push or draft creation.

## Scoped REST

For protected `github-repository` delivery with a Sandbox repository network policy,
set `scopedRest: "v1"` or `"v2"` on each participating repository's Namespace row
in the GitHub registry. Version v1 permits the reads and pull request creation
described below. Version v2 adds issue creation; it does not grant general issue
management. Rebind and deploy after changing the setting. With the setting omitted,
the network policy permits Git only. With the network policy omitted, the selected
credential uses its ordinary API scope. The existing deployment and runtime
qualification requirements apply.

A repository read or write grant and `permissions.issues` of `read` or `write`
allow listing issues and reading one by number. Substitute the approved
lowercase owner, repository and issue number.

```sh
gh api repos/owner/repo/issues
gh api repos/owner/repo/issues/42
```

A repository write grant and `permissions.pull_requests: "write"` allow pull
request creation. Use the Sandbox's injected `GITHUB_TOKEN` placeholder. This
command submits one POST, skips local curl settings and stops at redirects.

```sh
printf 'Authorization: Bearer %s\n' "$GITHUB_TOKEN" |
  curl -q --fail-with-body --header @- --write-out '\nHTTP %{http_code}\n' \
    --json '{"title":"Fix","head":"topic/fix","base":"main"}' \
    https://api.github.com/repos/owner/repo/pulls
```

Use two unqualified branch names in the approved repository. The hook rejects
fork selectors, issue conversion, and `%3A` or `%25` in either branch. Optional
fields are `body`, `draft` and `maintainer_can_modify`. Set `"draft":true` for a
draft. Expect HTTP 201 and verify the returned PR in GitHub. If the outcome is
uncertain, inspect the repository before submitting again.

With v2, a repository write grant and `permissions.issues: "write"` also allow
`POST /repos/owner/repo/issues`. Use a nonblank string `title` and, optionally, a
string `body`. Other fields, including labels, assignees and milestones, are
refused before the request reaches GitHub.

```sh
gh api --method POST repos/owner/repo/issues \
  -f title='Investigate a regression' -f body='Steps to reproduce'
```

The Sandbox supplies the `GITHUB_TOKEN` placeholder; the protected sender keeps
the real credential outside the Agent. The request validator checks the exact
repository, method and JSON body, then requires current authorization. If the
validator or authorization is unavailable, the write fails closed. `gh api` can
follow redirects; each follow-up request must pass policy and authorization
again. To stop at the first redirect, use the curl pattern above without
`--location`. Expect HTTP 201 and verify the created issue in GitHub. If the
result is uncertain, inspect the repository before submitting again.

OpenShell also admits HEAD for the issue GET routes. Version v1 denies all issue
writes; v2 admits only the issue creation POST described above. Both versions
deny issue updates, comments, other API routes and GraphQL. The policy controls
request destinations. GitHub can return references to other repositories.

## Supported commands

Use ordinary `git clone`, `git fetch` and `git push` to the approved ref. With a draft grant, use
`oce-github pr-create --draft` with the approved head and base. The explicit development-token
profile can also use `gh api` for permitted REST routes; it does not establish production GitHub
App behavior.

For Agent setup, use the [repository access guide](../../guides/repository-credentials.md#create-and-deploy-an-agent).
