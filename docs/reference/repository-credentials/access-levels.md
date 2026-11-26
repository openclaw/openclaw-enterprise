# GitHub access levels

For Credential Design 1.0, choose repository **Read** or **Read/write**.
TokenService supplies credentials for admitted Git operations. GitHub enforces
branch rules. OpenShell can also admit a separate public metadata request for
the same repository. The prepared broker and deprecated protected profiles
documented below are outside 1.0.

## Registry profiles

The registry's `namespaces[].profiles` lists the access modes that Agents in that
OCE Namespace may select for the repository. An Agent's
`repositoryAccess.repositories[].profile` selects one allowed mode. OCE rejects a binding
whose profile is not allowed by the Namespace policy.

| Profile             | Permission selection                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| `github-repository` | Uses the registry's explicit `permissions` map for the selected repositories. |
| `git-read`          | Requests the predefined read-access profile.                                  |
| `git-write`         | Requests the predefined contribution profile.                                 |
| `git-full`          | Requests the predefined contribution profile with issue management.           |

For `github-repository`, `profiles` must contain only that value and the Namespace
policy must include the GitHub App token `permissions`, such as `contents: write`
and `metadata: read`. These permissions set the scope of the App's installation
token. GitHub applies its repository and branch rules.

For a legacy session with one `github-repository` binding, the Installation and Namespace can opt into
[standing approval](../../guides/repository-credentials.md#keep-git-access-on-the-same-running-agent).
The approved scope includes the exact repository identity and permission map.
Legacy sessions for multiple selected repositories remain finite.

With TokenService Git, the revision records its Agent Repository grants
independently of the installation token's expiry. The legacy session duration
does not set a deadline on those grants.

The other profiles do not accept a custom registry `permissions` map. Their
effective permissions and supported operations depend on the selected delivery,
as described below. `git-full` does not mean unrestricted GitHub administration.

Installation-wide access uses a separate
[`installationAccess` entry](protected-openshell-git.md#grant-access-to-a-github-app-installation);
`github-installation` is not a value in a repository's `profiles` list.

### TokenService registry example

This registry permits read-only Git access to `project` in one Namespace.
Replace the example Namespace, App, and installation IDs. Set `backendId` to
the selected GitHub Backend ID.

```json
{
  "version": 1,
  "backendId": "repository-backend",
  "providerInstanceId": "github-production",
  "appId": "123456",
  "githubInstallationId": "789012",
  "maximumDurationSeconds": 900,
  "repositories": [
    {
      "repositoryRef": "project",
      "repository": "project",
      "namespaces": [
        {
          "namespaceId": "ns_00000000-0000-4000-8000-000000000001",
          "profiles": ["github-repository"],
          "nativeGit": "v1",
          "permissions": { "contents": "read", "metadata": "read" }
        }
      ]
    }
  ]
}
```

Use the same short repository name in the Installation's ceiling. The registry
grants access to the Namespace. The ceiling limits the grants its Agents can save.

```yaml
repositoryNetworkPolicyCeiling:
  - repository: project
    access: read
```

### Native Git delivery

Use a dedicated Codex Agent with a supported TokenService model Source,
Kubernetes Compute, and the paired OpenShell Sandbox and Credential Proxy.
[Installation and Agent setup](../../guides/repository-credentials.md#set-github-app-access-for-an-openshell-agent)

Dedicated OpenClaw with native Git is unsupported. Compute contains a guarded
placement path, but OCC refuses that recipient at deployment and no qualified
OpenClaw image pin is supplied. A live combined run remains unverified.

In the Namespace registry, select `nativeGit: "v1"` with the
`github-repository` profile for each selected repository. Register the GitHub
App Client and choose it on the Agent. Set each repository to **Read-only Git**
or **Read/write Git**. OCC derives the revision's grants from those selections,
the current registry and Installation ceiling, and the repository identities
verified by GitHub. A separately saved `repositoryNetworkPolicy`, even an empty
list, conflicts with the selection and blocks deployment. Use an Agent draft
without that list. [Repository network policy](../sandbox-policies.md#repository-network-policy)

TokenService holds the installation token. Credential Proxy injects it only
on each Agent's admitted Git requests. Read-only permits Git discovery, clone,
and fetch. Read/write also permits push.

Stop a running Agent before deploying changed grants. Removing repositories
can [withdraw running Git access](../../guides/credential-proxy.md#withdraw-repository-access) without
replacing its model credential. [Git token renewal](../../guides/repository-credentials/openshell-git-renewal.md)
does not change the Agent's grants.

### Public repository metadata

For either access level, OpenShell adds a public metadata rule for each admitted
repository when the Installation's `sandboxNetworkPolicyCeiling` permits
`/usr/bin/curl` to reach `api.github.com:443`. Without this ceiling entry, the
Agent can still deploy with its Git grants.

The derived rule allows `/usr/bin/curl` to send `GET` to the exact
`/repos/{owner}/{repository}` path. It grants no `HEAD`, other methods,
subpaths, or routes for other repositories. OpenClaw Enterprise supplies no
credential and leaves request headers intact. GitHub returns its full response
and decides whether the repository is public for an unauthenticated request.

If an existing Sandbox rule overlaps this request, OpenShell refuses to prepare
the deployment. Remove the overlapping rule and keep the Installation ceiling
entry to use the derived rule.

The rule uses the Repository grants saved with the Agent revision. Withdrawing
the Git Source leaves this public rule in place. Deploy a revision without the
grant to remove the rule.

<a id="api-limits"></a>
<a id="preview-namespace-limits"></a>
<a id="issue-creation"></a>
<a id="cut-over-existing-registrations"></a>
<a id="pull-request-creation"></a>
<a id="known-limits"></a>

Earlier OpenShell REST routes, API limits, and issue and pull request behavior
are documented in the [historical REST reference](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/reference/repository-credentials/access-levels.md#native-git-delivery).
The separate [prepared native Git broker](prepared-native-git.md) is outside 1.0;
its draft-PR feature is not equivalent to a Source-backed Git grant.

## Console access levels

These profile choices apply to the separate **Access profiles** path.

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
custom even when equal to the default. The Agent response returns the saved
`repositoryAccess`, and deployment resolves those selections against Namespace
policy before freezing the grants in the Agent revision.

Omitting `repositoryAccess` preserves the saved selections. An empty
`repositories` array removes the selections while retaining the default profile.

## API and branch boundaries

GitHub App `contents: write` permission is repository-wide. The prepared native sender enforces
the exact approved ref before sending the push; GitHub repository rules still apply. The
[push-ref guardrail](push-ref-guardrail.md) explains what the client hook and sender each enforce.
A push can trigger repository CI, so review that CI's own secret and execution policy.

A Git-only session does not admit REST or GraphQL. Draft transport admits only its bounded draft
operation. Neither profile supports arbitrary GitHub CLI commands, merges, forks, SSH or LFS.
A lost response does not authorize repeating a push or draft creation.

## Supported commands

Use ordinary `git clone` and `git fetch` on approved repositories. Write
grants permit `git push`. The prepared native sender limits pushes to its
approved ref. With a prepared draft grant, use
`oce-github pr-create --draft` with the approved head and base. The explicit development-token
profile can also use `gh api` for permitted REST routes; it does not establish production GitHub
App behavior.

For Agent setup, use the [repository access guide](../../guides/repository-credentials.md#create-and-deploy-an-agent).
