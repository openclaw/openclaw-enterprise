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

## Supported commands

Use ordinary `git clone`, `git fetch` and `git push` to the approved ref. With a draft grant, use
`oce-github pr-create --draft` with the approved head and base. The explicit development-token
profile can also use `gh api` for permitted REST routes; it does not establish production GitHub
App behavior.

For Agent setup, use the [repository access guide](../../guides/repository-credentials.md#create-and-deploy-an-agent).
