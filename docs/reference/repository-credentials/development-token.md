# Development GitHub token authority

The standalone credential service can use a static GitHub token instead of a
GitHub App, for local development only: a fine-grained or classic personal
access token, or the token the host `gh` CLI holds. The token stays inside the
service process. Clients receive the same per-session gateway bearer, Git
configuration and `gh` configuration as with the App, and the same
[access levels](access-levels.md) apply. The decision record is
[RFC-0060](https://github.com/openclaw/openclaw-enterprise/pull/1196).

This is **not a production authority**. Kubernetes projection, Helm, the k3d
launcher and registry mode accept only the GitHub App. `occ dev up` stays on the
App. The [local guide](../../guides/repository-credentials/development-token.md)
runs the service and client containers with a host token.

## Enable it

Two explicit opt-ins are required. If either is missing, `check-config` prints
`invalid-configuration` and the service exits with `repository credential
service failed`:

1. The protected configuration selects `backend.kind: "github-token"` with the
   literal `developmentOnly: true`.
2. The process starts with `--development-authority`, which appears in `ps` and
   `docker inspect`. `pnpm credentials:check-config FILE --development-authority`
   checks the configuration the same way.

`sessionPolicy.maximumDurationSeconds` must be at most 28800 (eight hours), and
`limits.gitPushInputBytes` at most 67108864 (64 MiB), because the gateway buffers
each push in memory to inspect it. The
[development example](../../../deploy/examples/repository-credentials/service-config.development-token.json)
uses four hours and 64 MiB.

| Backend field                                                       | Rule                                                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `providerInstanceId`, `configVersion`, `repositoryId`, `repository` | As for the App backend; one repository per service.                                    |
| `tokenFile`                                                         | Absolute path to a protected file holding the token.                                   |
| `developmentOnly`                                                   | Required literal `true`.                                                               |
| `pushRefAllowlist`                                                  | Required, in [guardrail syntax](push-ref-guardrail.md); `[]` denies every push.        |
| `allowGraphql`                                                      | Optional, default `false`. Allowed only for a fine-grained token.                      |
| `leaseSeconds`                                                      | Optional integer 900 to 86400, default 3600; must cover one exchange plus two margins. |

App fields (`appId`, `installationId`, `privateKeyFile`) and any other key are
rejected.

## Token file

The token file follows the App key rules: a private regular file owned by root
or the service user, in trusted directories, with no symlink or replacement
during the read. One trailing newline (LF or CRLF) is removed, so
`gh auth token > file` works. The rest must be 1 to `accessTokenBytes`
non-space printable ASCII bytes. Create it fresh so the umask applies, and never
print it:

```sh
rm -f "$INPUTS/token"
(umask 077; gh auth token > "$INPUTS/token")
stat -c '%a %u' "$INPUTS/token"   # expect 600 and the service UID
```

The service reads the token once at startup. To rotate it, replace the file and
restart the service. A revoked token appears as an upstream 401 on the next
request; the service never revokes the token.

`check-config` and one `started` line on standard error report
`authority: "github-token-development"` and a `tokenClass` derived from the
prefix: `fine-grained` (`github_pat_`), `classic` (`ghp_`), `oauth` (`gho_`, what
`gh auth token` returns), `app-user`, `app-installation` or `unknown`. Neither
output contains the token or its path.

## Scope

A static token cannot be narrowed per session, so the gateway enforces scope:

- **REST** uses the same repository-pinned route allowlist and per-profile write
  routes as the App. The profile's permission map is a route allowlist here, not
  provider-checked token permissions.
- **GraphQL** is refused for `git-read` always, and for other profiles unless
  `allowGraphql: true` is set with a fine-grained token. Even then it is
  read-only: the gateway refuses any body containing a `mutation`, because
  mutations such as `updateRef` would write refs outside the push allowlist. `gh`
  commands built on mutations, such as `gh pr create` or `gh pr comment`, fail.
  Only one plain query document is accepted, without batches or extensions.
- **Pushes** are checked at the gateway. Before any byte goes upstream, the
  gateway reads the receive-pack commands and refuses the whole push with 400 if
  any ref fails the allowlist. Bypassing or replacing the client hook does not
  change the result. Signed pushes (`push-cert`) are refused.
- `git-read` never reaches receive-pack.

Upstream sees every action as the token owner. A leaked session bearer reaches
what the token reaches through these routes until the session closes or expires.
Prefer a fine-grained token limited to one scratch repository, ideally on a
scratch account, and revoke it when you finish.

## Custody and identity

Each acquisition lends a copy of the token into the session's custody slot for
`leaseSeconds`. Nothing is sent to GitHub to obtain it, and there is no
retirement call. The backend declares `cleanup: "expiry-only"`, so the common
owner releases a copy as soon as it is superseded, refused or no longer needed
after close. A closed session reaches DISPOSED without waiting for the lease.
For this backend the `expired` cleanup counter counts released copies.

Token grant identities include the authority, a static capability policy, the
push allowlist and the profile's route map, so a token service never honors an
App binding and an App service never honors a token binding.

## Not supported

SSH keys, agent forwarding and mounting `~/.ssh` into any container are out of
scope; the gateway speaks HTTPS only. The token authority has no Kubernetes path,
no registry mode and no repository metadata lookups.
