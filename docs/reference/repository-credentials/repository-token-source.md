# Repository token Source

A Namespace registration can set `credentialSource` to the ID of a
[`github` Source](../credential-sources/managed-static.md#register-a-github-repository-token)
in that Namespace. Native Git then uses the Source's fine-grained personal access
token instead of a GitHub App token. The Agent still holds only the placeholder.

Registry validation refuses:

- a value that is not a Source ID (`cs_…`);
- the field without `nativeGit: "v1"` and the `github-repository` profile, with
  `scopedRest`, or with a `permissions` key outside `metadata`, `contents`, `issues` and `pull_requests`;
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

Catalog references of the form `pat-api-` followed by 64 lowercase hexadecimal
digits are reserved for API grants. Use the reference returned by the catalog,
and avoid this pattern in configured `repositoryRef` values.

## Issues and pull requests

At enrollment, append `:api` to each Source entry that may use GitHub REST, for
example `octo/app:write:api,octo/docs:read:api`. Bare entries remain Git-only.
Use a new Source to expand API access or change the set of repositories while API access is enabled. Upgrade all Workers and
controllers before using this syntax. Older readers reject it.

Use a dedicated fine-grained token. At enrollment and replacement, verify the
resource owner, match GitHub's selected repositories to the declared set and
check the minimum required permissions. Stop if you cannot verify them. GitHub
also grants read access to public repositories. That access does not create a
direct Sandbox route. OCE cannot verify or reduce the token's GitHub rights.

Set the Namespace registration's `permissions.issues` and
`permissions.pull_requests` to `read` or `write` as needed. Omission grants
no direct routes for that resource. Select the repository from the Agent's
repository catalog, review [API limits and stock gh api examples](access-levels.md#api-limits),
and deploy. For a PAT registration with effective API routes, the catalog
reference identifies the Source, repository, Namespace, permissions and API
limits. A registration change that changes this identity invalidates the old
selection, including on the first deployment of a saved draft. Select the
repository again. If a saved repository policy exists, the editor also needs
Agent `manage_policy` and SandboxPolicy `read` and `update`. Replacing the token
within the same scope preserves the selection. Git-only and App references do
not change. Read-only permits eligible list and detail requests. Contributor
also permits eligible issue and PR creation. An unenrolled API route refuses
save, deploy and loans. Disable the APIs on that registration or enroll a
matching Source. To keep a grant Git-only, replace its entire `apiLimits` object
with `{"default":"none"}`. An explicit resource override takes precedence over
the default.

An ungranted bound repository disables PR creation. If PR creation is otherwise
enabled and the Source declares another repository outside the Agent's grants,
OCE refuses the policy. Turn off **Open pull requests** or narrow the Source.
Issue creation stays available with PR creation disabled.

GitHub processes fields in allowed requests. A PR head can expose commits from
another private repository in the same fork network if the PAT can read it.
Issue parents can link to another repository where the token has triage access.
Turning off **Create issues** does not prevent PRs from converting issues.
Before broader rollout, obtain separately authorized GitHub evidence that
read-only repositories did not change and excluded private repositories were
neither exposed nor changed. Keep rollout restricted while either outcome is
unknown. See [known limits](access-levels.md#known-limits).

## Admission and renewal

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
principal's `operate` and the token class. The Git check compares the
revision's saved grants. API checks also apply the PR safeguard above. A ceiling lowered since
deploy refuses the loan with reason `source_ceiling_exceeded` (a granted
repository left out) or `source_access_exceeded` (including withdrawn API authority).
Deploy again within the new ceiling. A refused loan logs
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
