# Use stock Git and gh in a protected Strands Box execution

> [!WARNING]
> Dogfood stage. Box asks OCE for every request, but OCE applies no draft or
> branch rule to `gh`'s API requests, and the host needs a Box build with the
> request-time credential source. See the
> [known gaps](../KNOWN-GAPS.md#oce-applies-no-draft-or-branch-rule-to-ghs-github-api-requests).

The [paired protected registration](../driver/README.md#paired-protected-registration)
gives one admitted execution access to the repositories in its repository
assignment. Box injects the credential on two egress routes and asks OCE for
each request: the host relays Box's ask to the Worker, and OCE decides, records
the use, and returns the installation token for that one request or a refusal.
The workload never holds the token:

| Route        | Destination      | Placement                                                                | What the workload sends                                            |
| ------------ | ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `github-git` | `github.com`     | Basic authentication `x-access-token:<token>`, attached to every request | nothing; Git's first request carries no credential, so Box adds it |
| `github-api` | `api.github.com` | `Authorization: token <token>`, replacing Box's placeholder              | `GITHUB_TOKEN`, which holds only the placeholder                   |

Box's policy admits only those two hosts on port 443 over intercepted TLS:
`GET` and `POST` on `github.com`, and `GET`, `POST`, `PATCH`, `PUT` and
`DELETE` on `api.github.com`. Box sets `HTTPS_PROXY` and its CA files for the
workload.

## Push and open a draft

Use the ordinary clients with GitHub's canonical URLs:

```sh
git clone https://github.com/example/review.git
cd review
git switch -c agent-review
# change files, commit
git push https://github.com/example/review.git agent-review
gh pr create --draft --repo example/review --head agent-review --base main \
  --title "Review change" --body "Summary of the change"
```

`gh` reads `GITHUB_TOKEN` from the environment, so no `gh auth login` step is
needed. Box records nothing about the token in the workspace, the Git
configuration or `gh`'s state directory.

OCE checks each request's repository, method and route. The installation
token's permissions and the repository's rules decide the rest. OCE does not
restrict the branch, the base or the number of pull requests for `gh`'s API
requests. Keep branch protection on the base branch.

## Refusals

- Another repository: OCE refuses the request before Box sends it, with
  `request_not_allowed`.
- Any other host: Box refuses the connection. OCE is not asked.
- After withdrawal: OCE refuses the next request before Box sends it, with
  `access_withdrawn`. The execution and its chat keep running.
- After renewal: the next request gets the renewed token. Box keeps running.
  Until the Worker confirms the renewed version, about a second, requests are
  refused with `route_not_ready`.

Box reports a refusal to the workload as `403` with
`credential refused by its source: <code>`.

The [paired Driver end-to-end test](../../../../tests/conformance/strands-box-protected-gh.test.ts)
runs these commands with stock `git` and `gh` against a controlled GitHub origin
through a stand-in for Box egress. They do not qualify an installed Box run.
