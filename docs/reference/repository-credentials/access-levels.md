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
held by the Gateway. A registration with only metadata and contents permissions
grants Git only.

Before installing or renewing the credential, OCE checks that the expected
Sandbox is the Provider's sole recipient and the workspace has no additional
members. Operators must retain exclusive control of workspace, Sandbox and
Provider writes for this delivery mode.

Native GitHub App REST access on stock OpenShell 0.1.9 follows the selected
repository's Namespace `permissions` and the Agent's saved repository grant.
GitHub App permissions that are not configured on the Namespace registration do
not grant Agent access.

| Operation                              | Namespace `permissions` entry      | Saved grant   |
| -------------------------------------- | ---------------------------------- | ------------- |
| List issues or read one issue          | `issues`: `read` or `write`        | Read or Write |
| Create an issue                        | `issues`: `write`                  | Write         |
| List pull requests or read one of them | `pull_requests`: `read` or `write` | Read or Write |
| Create a pull request                  | `pull_requests`: `write`           | Write         |

GitHub's issue routes also return pull requests as issue records, so Issues read
can expose pull request titles and descriptions. Use the supplied `GITHUB_TOKEN`
placeholder with stock `gh api`:

```sh
gh api --method GET repos/OWNER/REPO/issues
gh api --method GET repos/OWNER/REPO/issues/NUMBER
gh api --method GET repos/OWNER/REPO/pulls
gh api --method GET repos/OWNER/REPO/pulls/NUMBER
```

`NUMBER` must be a positive decimal number of at most 19 digits. OpenShell
checks the method and path before forwarding and injects the Gateway-held
credential. The Agent holds only a placeholder. OCE generates the rules at
deployment and renews the credential, with no request-time callback. GitHub
applies the token's own permissions and repository scope. Native v9 revision
custody and recipient checks remain unchanged. Comments, reviews, PR updates or
merges, other issue-write routes, GraphQL, and direct access to ungranted
repositories remain denied. See [Known limits](#known-limits) for indirect effects.

#### API limits

Omit `apiLimits` for the Contributor defaults in the table above. To narrow
direct REST access, set `apiLimits` on the selected native Namespace
registration for the repository. Git access stays the same.

Each resource, `issues` or `pull_requests`, accepts `none` (no routes), `read`
(list and detail) or `write` (read and create). A limit cannot add permissions,
override the saved grant or bypass the pull request safeguard. Creation always
requires read access to the same resource.

| Example `apiLimits`                    | Effect on eligible routes                    |
| -------------------------------------- | -------------------------------------------- |
| `{ issues: "read" }`                   | Block issue creation only                    |
| `{ pull_requests: "none" }`            | Block direct pull request reads and creation |
| `{ default: "none", issues: "write" }` | Keep only issue reads and creation           |
| `{ default: "none" }`                  | Git only                                     |

An omitted resource inherits eligible access. Set `default: "none"` to block
all unlisted resources, including future ones. OCE rejects any other default,
an empty object, unknown keys and invalid values.

Any explicit limit requires a saved repository network policy and native
enforcement, even without API permissions. If either is missing, OCE refuses
credential delivery and renewal. Withdrawal and Stop remain available.

#### Issue creation

Namespace `permissions.issues: write` and saved Agent Write permit
`POST /repos/{owner}/{repo}/issues` unless an API limit blocks creation. Read-only
or denied repositories bound to the same credential do not block issue creation
in a writable repository.

Save the request in `issue.json` and send it with stock `gh api`:

```json
{ "title": "Investigate failure", "body": "Steps to reproduce" }
```

```sh
gh api --method POST repos/OWNER/REPO/issues --input issue.json
```

Inspect the repository before retrying an uncertain creation result.

#### Cut over existing registrations

Remove the retired `scopedRest`, `createIssues` and `apiActions` fields. Review each
Namespace's Issues and Pull requests permissions and any `apiLimits`
before deployment. An existing Agent draft can gain eligible REST routes at its
next deployment. Changed grant identities can interrupt an older revision's
credential preparation or renewal, affecting Git and REST until recovery. Edit
the normal draft and redeploy, then verify retirement of the old Sandbox. A
registration edit does not immediately revoke a running Sandbox's loaded policy
or current credential.

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
and can send notifications. A parent link from writable B can affect read-only A
or denied C when GitHub gives the caller triage access to both repositories, even
though a direct issue POST to A or C is denied. Other indirect effects remain
unverified. Broader rollout is on hold pending safety review. Controlled-origin
results do not qualify live GitHub effects. Disable issue creation if these
effects are unacceptable.

The [existing pull-request rule](https://github.com/openclaw/openclaw-enterprise/pull/7135)
remains independent. Blocking issue creation does not prevent conversion of an issue
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

### Repository token Source

A Namespace registration can set `credentialSource` to the ID of a
[`github` Source](../credential-sources/managed-static.md#register-a-github-repository-token)
in that Namespace. Native Git then uses the Source's fine-grained personal access
token instead of a GitHub App token. The Agent still holds only the placeholder.

Registry validation refuses:

- a value that is not a Source ID (`cs_…`);
- the field without `nativeGit: "v1"` and the `github-repository` profile, with
  `scopedRest`, or with a `permissions` key other than `metadata` and `contents`;
- without the App's `appId` and `githubInstallationId`: a registration without
  `credentialSource`, standing approvals, and `installationAccess`.

An Installation without a GitHub App leaves the chart's
`repositoryCredentials.appKeySecretName` empty, so the Worker gets no App key.
The repository broker (`repositoryCredentials.enabled`) still requires it. Keep
the Worker's `repository.preparedGitHub.privateKeyPath`: the Worker reads the key
only when the registry has the App. With the App and no readable key, the Worker
does not start and logs `PREPARED_GITHUB_APP_KEY_INVALID`.

An Agent's bindings must resolve to one credential: the App, or one Source.
Naming another Source changes the grant, so earlier revisions go stale.

Saving the repository policy and deploying check the Source again:

| Condition                                                                                 | Result                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| The caller or the Agent's principal lacks `credential_source:operate`                     | `403`                                    |
| The Source is missing, not `ready`, in another Namespace or TokenService, or not `github` | `409`                                    |
| A saved grant exceeds the Source's repository ceiling                                     | `409`, detail `/repositoryNetworkPolicy` |
| The bindings mix the App and a Source, or two Sources                                     | `409`; `400` when the Agent is saved     |
| `DELETE` of the Source, or a ceiling change, while the registry names it                  | `409`                                    |
| `DELETE` of the Source while a deployed copy of it is not confirmed retired               | `409`                                    |

The Worker lends the value for at most 15 minutes and renews it every 7.5 minutes.
At each loan it checks the Source's state, owner, preset and ceiling, the Agent
principal's `operate` and the token class. The ceiling check compares the
revision's saved grants, not every bound repository. A ceiling lowered since
deploy refuses the loan with reason `source_ceiling_exceeded` (a granted
repository left out) or `source_access_exceeded` (write lowered to read);
redeploy within it. A refused loan logs
`REPOSITORY_SOURCE_LOAN_REFUSED` once per revision, Source version and reason, with the
`reason`, `credentialSourceId` and `credentialSourceVersion` and never the value. The current loan stays in the
Sandbox until it ends.

- **Replacement.** `PATCH` of the Source's `secret` commits the replacement.
  The Worker's next refresh (every 10 seconds) rotates it into the same Provider,
  with no redeploy, and logs `worker.openshell-git-delivery-confirmed` with
  `credentialSourceId` and `credentialSourceVersion` once OpenShell reports it
  installed. Read these in the Worker's own log: the Collector does not export them.
  The log keeps the Source ID only as a `cs_` UUID and the version only as a
  UUID, which TokenService picks at random for each value. Revoke the old token
  at GitHub once every running Agent that uses the Source has logged that event
  for the new version, or 15 minutes after the replacement. A `github` Source has
  no Credential Proxy Provider, so
  [manual delivery retry](../credential-sources.md#retry-credential-delivery)
  does not apply to it: `"all"` skips it and naming it returns `409`.
- **Revocation.** Removing the Agent principal's `operate`, narrowing the
  registration, or changing the registry stops the next loan. Access ends when
  the current loan does, at most 15 minutes later. Revoke the token at GitHub to
  end it at once.
- **Stop and retirement.** A stopped Agent's route is withdrawn: nothing is lent
  or renewed for it. Each deploy that selects the Source records the revision's
  copy before the deployment is queued, and the Worker lends the value only to a
  revision whose copy is recorded and not retired (otherwise it logs
  `REPOSITORY_SOURCE_LOAN_REFUSED` with reason `source_copy_unrecorded`; redeploy
  the Agent). The Worker retires a copy by deleting the revision's
  `oce-github-token-` Provider, and records it only once a fresh listing no
  longer shows that Provider, or once the Gateway answers that the Workspace no
  longer exists (reason `workspace_absent`). It tries when the revision's Sandbox
  is gone (Stop, redeploy or a deployment that ends without a Sandbox), at Worker
  start, and every five minutes for each copy whose revision no longer runs.
  `DELETE` of the Source answers `409` with reason
  `unretired_repository_source_copy` while any copy is unretired, even after the
  registry no longer names the Source. The answer gives the count and, when you
  may read that Agent, the oldest copy's Agent and revision with the Worker's
  last reason. To clear it, stop or redeploy without the Source each Agent whose
  revision uses it. A copy whose Provider OpenShell still lists, or whose Gateway
  does not answer, stays unretired and the Worker logs
  `worker.openshell-git-copy` with status `retained` and reason
  `provider_present` or `gateway_unavailable` until a later pass retires it.
  Without OpenShell Git configured, the Worker runs no retirement pass: restore
  its repository configuration (the registry may leave the Source out), restart
  the Worker, then delete the Source and, after it, the Namespace.

Replacement and retirement wait while the Worker holds the Source's catalog row.
The Worker limits the hold to 60 seconds and confirms it before and after the
Provider write. When the Worker is frozen or cut off from the database,
PostgreSQL ends its idle session. The same limit applies to the Worker's
transaction the checks run in, which holds the Namespace row that replacement
and retirement lock first. A missing hold prevents dispatch. If confirmation fails after
dispatch, the Worker blocks the route as `write_unknown` and does not retry or
confirm delivery. The Gateway may still install the submitted credential with
its original expiry. Stop the Agent and verify the Sandbox has retired before
redeploying. For immediate revocation, revoke the token on GitHub.

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
