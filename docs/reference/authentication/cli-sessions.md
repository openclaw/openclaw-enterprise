# CLI sign-in for people

`occ login` gives a person a short-lived CLI session that acts with their own
current permissions. They approve it in the [platform console](../console.md)
with the browser session they already have, so the identity provider sees only
that ordinary sign-in. Automation and CI keep using
[service API keys](service-api-keys.md). The design is
[RFC-0019](https://github.com/openclaw/openclaw-enterprise/pull/1235).

## Sign in

```bash
export OCC_URL='https://occ.example.com'
occ login                      # or: occ login --namespace <namespace-id>
occ auth status
occ namespace list
occ logout
```

`occ login` prints an eight-letter code such as `BCDF-GHJK` and the address of
`/console/cli-login`. Open that page in a signed-in browser, type the code,
check the request and choose **Approve** or **Deny**. The page shows the client
label that `occ` reported (unverified), the address the request came from, any
Namespace pin and the exact end time. It warns when the request came from a
different network address than the browser. Without
[trusted proxies](../settings/production.md#github-sign-in-and-trusted-proxies)
both addresses are the ingress's. Only approve a code you just started yourself.

The code expires after 10 minutes and works once. `occ` polls every 5 seconds
and backs off when asked to.

## What a CLI session is

- **Lifetime.** It ends at the earlier of the approving browser session's end
  and `auth.cliSessions.maxLifetimeSeconds` (default 8 hours). It is never
  refreshed; run `occ login` again.
- **Permissions.** It resolves the same Principal as the person's browser
  session and checks current IAM policy on every request. Nothing is copied
  into it, so a removed binding takes effect on the next request.
- **Namespace pin.** With `--namespace`, Installation-level routes and other
  Namespaces are refused, as for a Namespace service key.
- **Header.** `occ` sends the token as `x-occ-cli-session`. It never falls back
  to a cookie: a bad token, or the header together with `x-api-key`, gets
  `401`. No `Origin` is needed. The token starts with `occcli_`, and audit and
  log redaction remove it.
- **Browser-only routes.** A CLI session gets `403` on account reads and
  changes, service-key issue and revoke, CLI sign-in approval, native admin
  UI, and `GET /api/auth/session`, so a copied token cannot extend its reach or
  lifetime.
- **Limits.** A browser session can hold at most 10 unexpired CLI sessions.
  Starting a sign-in is limited to 30 per minute per client address and 1,000
  pending in total; wrong codes on the approval page share a budget of 5 per
  minute per account and address.

## End a CLI session

| Event                                            | Effect                                     |
| ------------------------------------------------ | ------------------------------------------ |
| `occ logout`                                     | That session ends and the local file goes. |
| **Revoke** under Settings, CLI sessions          | That session ends.                         |
| Sign-out or end of the approving browser session | All of its CLI sessions end.               |
| Account disable or revoke, method detach         | All of the account's CLI sessions end.     |
| A grant or binding is removed                    | The next request gets `403`.               |
| The account is disabled at the identity provider | It continues until it expires (≤ 8 h).     |

The person sees and revokes only their own CLI sessions
(`GET` and `DELETE /api/auth/cli-sessions`).

## Where `occ` keeps it

One file per OCC origin under the user configuration directory
(`$XDG_CONFIG_HOME/occ/sessions/` on Linux), mode `0600` in a `0700` directory.
`occ` refuses a symlink, a group- or world-readable file, or a file issued by
another origin, and sends the token only to that origin without following
redirects. An explicit `--service-key-file` or `OCC_SERVICE_KEY_FILE` always
wins, so scripts are unchanged. The OS keychain is not supported yet.

An `occ` that reaches a controller without CLI sign-in gets `404` and says so.

## Settings

| Helm value                            | Environment variable                        | Meaning                                                                                       |
| ------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `auth.cliSessions.enabled`            | `OCC_AUTH_CLI_SESSIONS`                     | `enabled` (default) or `disabled`: sign-in answers `404` and existing CLI sessions get `401`. |
| `auth.cliSessions.maxLifetimeSeconds` | `OCC_AUTH_CLI_SESSION_MAX_LIFETIME_SECONDS` | 900 to 28,800 (default) seconds; caps every new CLI session.                                  |

CLI sign-in needs the PostgreSQL composition; the in-memory development
controller answers `404`.

## Audit

Events carry IDs, never a token or code. An approval, exchange or revoke whose
audit cannot be written issues or changes nothing and returns `503`.

- `openclaw.auth.cli-sessions.approve` and `.deny`: the authorization, the
  requesting address, the client label and the Namespace pin.
- `openclaw.auth.cli-sessions.issue`: the CLI session, its parent session and
  its end time.
- `openclaw.auth.cli-sessions.revoke`: logout and console revoke.

Requests made with a CLI session are admitted as method `cli_session`. The
runtime trace is in the [CLI sign-in flow](../../flows/cli-sign-in.md).
