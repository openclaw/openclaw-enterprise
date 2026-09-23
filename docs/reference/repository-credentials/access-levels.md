# GitHub access levels

Choose the least access the Agent needs. Each binding selects one level for one
repository; Namespace policy determines which levels are available.

| Level        | Configuration value | Contents | Pull requests | Issues | Intended work                                       |
| ------------ | ------------------- | -------- | ------------- | ------ | --------------------------------------------------- |
| Reader       | `git-read`          | Read     | Read          | Read   | Clone/fetch code; inspect issues, PRs and checks    |
| Contributor  | `git-write`         | Write    | Write         | Read   | Reader work, plus pushes and PR creation/discussion |
| Collaborator | `git-full`          | Write    | Write         | Write  | Contributor work, plus ordinary issue management    |

Every level also requests `metadata: read`, `checks: read` and `statuses: read`.
These columns and shared permissions form the complete token permission map;
OCE requests one numeric repository ID and rejects a different returned grant.
App permissions must be approved on the installation before use.

In Agent bindings, omitting `profile` selects **Contributor**. This includes PR and read API
permissions; it is not the former Git-only write grant. Existing profile values
are unchanged, but the immutable grant fingerprint includes the permission
contract. A revision admitted under a different contract cannot silently acquire
the new authority. The Console requires an explicit choice.

## API and branch boundaries

Reader admits selected REST reads and GraphQL with a read-only installation
token. It refuses Git push and REST writes. Contributor adds supported PR writes;
Collaborator adds ordinary issue writes. GitHub shares some PR/issue comment
endpoints, so comment authorization also depends on the provider's token check.

All three levels admit unfiltered GraphQL. GitHub enforces the token's repository
and permission grant; OCE does not inspect fields, mutations or node IDs.
GraphQL can also return independently public information. Every GraphQL POST
retains possible-write accounting, including Reader requests, and uncertain
mutations are never automatically replayed.

**Contributor and Collaborator are not “open PRs but never merge” roles.**
Contents write plus GraphQL can permit merges and ref changes subject to
GitHub's repository rules. Use enforced rulesets or branch protection for
protected destinations, without granting the App a bypass. The optional
[push-ref allowlist](push-ref-guardrail.md) catches ordinary native Git mistakes;
it does not constrain API/GraphQL writes or provide a security boundary.

No level requests administration, workflow editing, Actions control, secrets,
packages or projects permissions. Granting extra permissions to the installed
App does not add them to these tokens. Pushed code may still trigger existing
repository CI; review that CI's own secret and execution policy separately.
SSH, LFS, forks and arbitrary GitHub CLI compatibility remain outside this
workflow.

## Supported commands

| Command                                           | Supported selection and options                                |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `gh repo view`                                    | Optional `OWNER/REPO`; JSON output options                     |
| `gh issue list`, `gh pr list`                     | `--state`, `--limit`; JSON output options                      |
| `gh issue view NUMBER`, `gh pr view NUMBER`       | `--comments`; JSON output options                              |
| `gh pr checks NUMBER`                             | `--required`; JSON output options                              |
| `gh pr diff NUMBER`                               | `--patch`, `--name-only`, `--color`                            |
| `gh pr create`                                    | Explicit `--head`, optional `--base`, title/body and `--draft` |
| `gh issue create`                                 | Title and body                                                 |
| `gh pr comment NUMBER`, `gh issue comment NUMBER` | Body text or body file                                         |

Except `repo view`, these commands accept `--repo`/`-R` for the selected repository. JSON output options are
`--json`, `--jq`/`-q` and `--template`/`-t`; title/body options are
`--title`/`-t`, `--body`/`-b` and `--body-file`/`-F`.
Supported short forms include state `-s`, limit `-L`, comments `-c`, head `-H`,
base `-B` and draft `-d`. Pass option values as separate arguments, not `--flag=value`.
Issue/PR selectors must be numbers, not URLs or branch names. Browser, editor,
watch, search, extension and implicit fork workflows are not supported.

Use the bundled GitHub CLI with the selected binding. Relative `gh api` requests
remain available for admitted REST routes and GraphQL. Native PR creation
requires an explicit `--head`; OCE does not implicitly push or create a fork.
The launcher validates command arguments and repository selection before
starting the CLI. A permitted command still requires the selected level's
GitHub permissions.

For token permissions, see GitHub's
[installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
and [permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).
For Agent setup, use the [team runbook](../../guides/repository-credentials/team-runbook.md).
