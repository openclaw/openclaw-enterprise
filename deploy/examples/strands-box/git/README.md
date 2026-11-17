# Use stock Git and gh in a protected Strands Box execution

> [!WARNING]
> Prototype stage. Box injects the GitHub App installation token on every
> request to `github.com` and `api.github.com` without asking OCE, so OCE does
> not authorize individual requests. See the
> [known gaps](../KNOWN-GAPS.md#github-access-through-box-stage-a-prototype).

The [paired protected registration](../driver/README.md#paired-protected-registration)
gives one admitted execution access to the repositories in its repository
assignment. OCE's Token Service mints the installation token. The Worker
delivers it to the Box host, and the host gives it to `box run` as the secret
of two Box egress routes. The workload never holds the token:

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

The installation token's repository selection and permissions, and the
repository's rules, decide what GitHub accepts. OCE does not restrict the
branch, the base or the number of pull requests in this stage. Keep branch
protection on the base branch.

## Refusals

- Another repository in the same account: GitHub refuses it because the
  installation token covers only the assigned repository.
- Any other host: Box refuses the connection.
- After withdrawal: OCE revokes the installation token at GitHub, so fresh
  requests fail with `401`. The execution and its chat keep running.
- After renewal: OCE renews the installation token before its one-hour expiry
  and retires the installed one, which ends the execution's GitHub access. Box
  reads its secrets once at start, so the renewed token is not installed.

The [paired Driver tests](../../../../tests/conformance/strands-box-protected.test.ts)
run these commands with stock `git` and `gh` against a controlled GitHub origin
through a stand-in for Box egress. They do not qualify an installed Box run.
