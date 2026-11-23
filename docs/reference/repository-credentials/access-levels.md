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

### Native Git delivery

A Namespace registration can select `nativeGit: "v1"` with the finite
`github-repository` profile. Select it consistently across the Agent's bindings.
Deployment also requires a saved [repository policy](../sandbox-policies.md#repository-network-policy)
and a Compute Driver that admits the placement. Omitting the policy retains
online authorization. Existing ref, draft and standing grants retain their own profiles.

Before enabling `nativeGit: "v1"`, finish replacing incompatible Workers. An old
Worker can consume a scoped deployment job attempt before refusing its marked
revision. The repository policy reference covers recovery and the restriction on
adopting previously deployed legacy Agents.

OpenShell matches discovery and upload-pack for each read grant. Write also
permits receive-pack. The Sandbox binds each repository path to a credential
held by the Gateway. By default, this selection grants Git only.

Before installing or renewing the credential, OCE checks that the expected
Sandbox is the Provider's sole recipient and the workspace has no additional
members. Operators must retain exclusive control of workspace, Sandbox and
Provider writes for this delivery mode.

To allow GitHub API access with stock OpenShell 0.1.9 and the managed Installation
Provider, set `scopedRest: "v1"` or `"v2"` alongside `nativeGit: "v1"` on the
selected GitHub App repository registration for the OCE Namespace. v1 stays
unchanged. v2 also permits issue creation by default. Each operation requires the
registration permission in this table, the corresponding GitHub App permission, and a saved
repository grant:

| Operation                              | `permissions` entry                | Saved grant   |
| -------------------------------------- | ---------------------------------- | ------------- |
| List issues or read one issue          | `issues`: `read` or `write`        | Read or Write |
| Create an issue (v2 only)              | `issues`: `write`                  | Write         |
| List pull requests or read one of them | `pull_requests`: `read` or `write` | Read or Write |
| Create a pull request                  | `pull_requests`: `write`           | Write         |

GitHub's issue routes also return pull requests as issue records, so the issue
permission alone lets an Agent read pull request titles and descriptions.

Complete the compatible Worker rollout before enabling these settings. After
changing the registration, rebind existing repository access under the usual
credential approval and deploy or redeploy the Agent. A Worker upgrade does not
change a running Sandbox. If the registration already had `scopedRest: "v1"` and
a `pull_requests` permission, the Agent receives the pull request routes at its
next deployment. Use the supplied `GITHUB_TOKEN` placeholder:

```sh
gh api --method GET repos/OWNER/REPO/issues
gh api --method GET repos/OWNER/REPO/issues/NUMBER
gh api --method GET repos/OWNER/REPO/pulls
gh api --method GET repos/OWNER/REPO/pulls/NUMBER
```

`NUMBER` must be a positive decimal number of at most 19 digits.

Three parties act on a request:

- **OpenShell** checks every request inside the Sandbox. It refuses a request
  outside the saved grants before GitHub receives it, and adds the real
  credential to an allowed one. The Agent holds only a placeholder.
- **OCE** sees no request. It writes the OpenShell rules from the saved grants
  when the Agent is deployed, and the Worker renews the credential. API access
  continues without the Worker while the current credential is valid (at most
  one hour).
- **GitHub** applies the permissions and repositories of the credential.

Omitting `scopedRest` keeps native delivery Git-only. v1 does not permit issue
creation. Neither version permits comments, reviews, PR updates or merges,
other issue-write routes, GraphQL, or direct access to repositories without a
saved grant. Creation routes have the exceptions under [Known limits](#known-limits).

#### Issue creation

For a selected App repository with `scopedRest: "v2"`, `permissions.issues: write`
and saved Write, issue creation is enabled unless its Namespace registration
sets `createIssues: false`. That setting switches off only this repository's
`POST /repos/{owner}/{repo}/issues`. Rebind repository access and redeploy
after changing the registration. A saved-grant downgrade needs redeployment.
Read-only or denied repositories bound to the same credential do not block issue
creation in a writable repository.

Save the request in `issue.json` and send it with stock `gh api`:

```json
{ "title": "Investigate failure", "body": "Steps to reproduce" }
```

```sh
gh api --method POST repos/OWNER/REPO/issues --input issue.json
```

Inspect the repository before retrying an uncertain creation result.

#### Pull request creation

To create a normal or draft pull request, save the request in `pull.json` and
send it as the JSON body:

```json
{ "title": "Fix", "head": "topic/fix", "base": "main" }
```

```sh
gh api --method POST repos/OWNER/REPO/pulls --input pull.json
```

OCE writes the creation route only when every repository bound to the Agent has a
saved Read or Write grant. While one binding has no grant, the Agent keeps Git and
the read routes, and OpenShell refuses creation with 403 before GitHub receives
it. To allow creation, save a Read grant for that repository, or remove its
binding, and redeploy. A Sandbox that an earlier Worker started with the
creation route in that state gets no new credential until the Agent is
redeployed.

If a creation result is uncertain, inspect the repository before submitting again.
To withdraw creation, save Read for the repository and redeploy. Verify that the
old Sandbox retires.

#### Known limits

Issue creation permits GitHub's full endpoint. GitHub can accept labels,
assignees, milestone, type, status, issue-field values and `parent_issue_id`,
and can send notifications. A parent link can affect a differently granted
private repository when GitHub gives the caller triage access to both, even
though direct access to that repository is denied. Other indirect effects remain
unverified. Broader rollout is on hold pending safety review. Controlled-origin
results do not qualify live GitHub effects. Disable issue creation if these
effects are unacceptable.

The [existing pull-request rule](https://github.com/openclaw/openclaw-enterprise/pull/7135)
remains independent. `createIssues: false` does not prevent conversion of an issue
through an independently permitted PR POST.

OpenShell matches the method, path and query of a request. It does not inspect
the body, and OCE does not check it. An Agent that can create pull requests in a
repository can also do the following in that repository:

- Name another repository's branch as the head, with `head: "OWNER:BRANCH"` or
  `head_repo`. Commits of that repository become readable through the target's
  pull request ref and diff. GitHub refuses a head repository that the
  credential does not cover, with 422 "not all refs are readable" (verified
  against github.com). The credential covers every repository bound to the
  Agent, and creation is only available while each of them has a saved grant,
  so the head can only be a repository the Agent can already read.
- Convert an existing issue into a pull request, with `issue: NUMBER`, which
  changes that issue.

A query string can carry the same fields.

Two things bound both cases. GitHub applies the permissions and repositories of
the credential. The target is always a repository for which the Agent already
holds a saved Write grant.

Issue conversion stays open: preventing it needs OpenShell to inspect request
bodies, which it does not. To rule it out, leave `pull_requests` at `read` on
the registration, which withholds creation.

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
