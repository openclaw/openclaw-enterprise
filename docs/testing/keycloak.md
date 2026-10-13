# Keycloak OIDC lane

The `keycloak-oidc` lane checks OIDC sign-in against a real, digest-pinned Keycloak
instead of the `fakeOidc` fixture. It runs as the `Keycloak OIDC` job in the
[CI workflow](../../.github/workflows/ci.yml) in full-mode pull request CI and on pushes to
`main`, and in the Full Integration `all` run. It is **not** a `CI Required`
dependency yet. The proposed design is RFC-0019 ([#1117](https://github.com/openclaw/openclaw-enterprise/pull/1117)).

## What it runs

| Piece     | Source                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Realm     | [`tests/fixtures/keycloak/realm-oce.json`](../../tests/fixtures/keycloak/realm-oce.json)                                  |
| Image pin | [`tests/fixtures/keycloak/image.json`](../../tests/fixtures/keycloak/image.json), shared with the OpenShell refresh proof |
| Server    | [`scripts/ci/keycloak.mjs`](../../scripts/ci/keycloak.mjs), started by `prepare.keycloak: true`                           |
| Lane      | [`scripts/ci/test-suites/keycloak-oidc.json`](../../scripts/ci/test-suites/keycloak-oidc.json)                            |
| Tests     | [`keycloak-oidc-sign-in.test.mjs`](../../tests/integration/keycloak-oidc-sign-in.test.mjs)                                |

The realm is `oce` with one confidential client, `oce-console`: authorization code
only, PKCE `S256` required, one redirect URI and no audience mapper. Users `alice`
and `carol` have fixed IDs, so their `sub` values are known. The realm file holds
no secret: the client secret, redirect URI and user passwords are `${VAR}`
placeholders that `--import-realm` fills from the server's environment.

Keycloak imports an unset placeholder as its literal text. This was observed with
the pinned 26.7.5 image: an unset `OCE_KEYCLOAK_CLIENT_SECRET` produced the client
secret `${OCE_KEYCLOAK_CLIENT_SECRET}`. Preparation therefore refuses to start
while any placeholder variable is empty, and readiness fails if the admin API
shows a placeholder or any secret other than the generated one.

## Preparation

`node scripts/ci/prepare.mjs --lane keycloak-oidc --state <state-file>` runs these
steps. A failure names its step (`Keycloak <step> step failed: ...`).

1. **image**: pull the pinned image through the bounded `pullImage` retry and
   verify the repository digest.
2. **port**: fail if anything accepts connections on `127.0.0.1:443`, then
   select an available loopback port for the test's HTTPS Console origin. The realm's
   redirect URI is `https://127.0.0.1:<port>/api/auth/providers/oidc/callback`.
3. **placeholders**: generate the client secret, user passwords and Keycloak
   administrator password into a `0600` `secrets.json`; refuse an unset placeholder.
4. **certificates**: a two-day private CA with leaves for `keycloak.oce.localhost`
   and `127.0.0.1`, made with `openssl`.
5. **hosts**: unless `keycloak.oce.localhost` resolves to exactly `127.0.0.1`,
   append `127.0.0.1 keycloak.oce.localhost # openclaw-ci keycloak <container>` to
   `/etc/hosts` with `sudo -n`. A `::1` answer against the IPv4-only publication flakes.
6. **start**: `start-dev --import-realm` with HTTPS on the Keycloak leaf,
   `--hostname=https://keycloak.oce.localhost`, a 1.5 GiB memory limit and the
   HTTPS port published on `127.0.0.1:443`. Secrets reach the container through
   its environment, never the command line.
7. **readiness**: within 180 seconds, discovery must return the issuer
   `https://keycloak.oce.localhost/realms/oce`, and the admin API must show the
   generated client secret and the selected redirect URI. The container's last
   log lines are printed on failure.

The test process receives `OCC_TEST_KEYCLOAK_*` paths and values and
`NODE_EXTRA_CA_CERTS` pointing at the lane CA. `scripts/ci/cleanup.mjs` removes the
container, the hosts line it added and the private directory, also after a failed
preparation.

## Verified flows

The browser tests compose the production API in-process (`composeProductionSignIn`)
from the chart's OIDC upgrade settings, listening on loopback behind the HTTPS ingress
from [`console-app.mjs`](../../tests/helpers/console-app.mjs) on the selected port with
the `127.0.0.1` leaf. That origin is `OCC_AUTH_BASE_URL` and matches the realm's one
redirect URI. The lane's PostgreSQL holds one bootstrapped Installation per run; its
recovery administrator creates `alice`'s account and attaches her fixed subject, and
`carol` gets no account. Playwright's Chromium trusts exactly the two lane leaves
through `--ignore-certificate-errors-spki-list`, opens a fresh context per test and
fills Keycloak's own login form. Browser requests are observed, never stubbed, and the
controller reaches the token and JWKS endpoints through its production transport.

| Test                                                                                              | Proves                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery matches the configured endpoints and the JWKS offers an RS256 key of 2,048 bits or more | Production OIDC configuration parsing accepts Keycloak's issuer and endpoints; the controller transport reads the JWKS.                                                                                                                                                            |
| Attached alice signs in with `client_secret_post`                                                 | The authorization request carries `scope=openid`, `S256`, a nonce and the realm's redirect URI; the callback lands on `/console/` with alice's session.                                                                                                                            |
| Attached alice signs in with `client_secret_basic`                                                | The same flow with the API recomposed for HTTP Basic client authentication at the token endpoint.                                                                                                                                                                                  |
| A higher-priority realm key signs the next sign-in                                                | The admin API adds a 2,048-bit `rsa-generated` key at priority 200; the active `RS256` kid changes, the JWKS publishes it, and alice signs in again through the same controller.                                                                                                   |
| Unattached carol is refused                                                                       | Her callback redirects to `/console/?authError=oidc`, the Console shows the refusal, `EXTERNAL_IDENTITY_REJECTED` is audited and no user or session appears.                                                                                                                       |
| Sign-out, one-click sign-in and a disabled user                                                   | Console sign-out deletes alice's OCE session row; one click signs her in again with no login form (Keycloak answers 302) while its session lives. Disabling her in Keycloak leaves that OCE session working, and her next sign-in stops at "Account is disabled" with no callback. |

The rotation test removes its key afterwards and the lifecycle test enables alice again,
so the order of the tests does not matter. Every wait is bounded: Playwright's default
timeout in the browser and ten seconds per Keycloak or JWKS request. The suite audit lists
the expected tests; a skip or a missing case fails the lane.

## Run it on a developer host

You need Docker, `openssl`, Node.js 24, a browser prepared as for
[Console browser checks](local.md#console-browser-checks) and a free `127.0.0.1:443`. Rootless engines
must be allowed to publish port 443. Hold one Keycloak at a time per host:

```sh
state="$PWD/.ci-state/keycloak-oidc.json"
node scripts/ci/prepare.mjs --lane keycloak-oidc --state "$state" &&
  node scripts/ci/run-tests.mjs run keycloak-oidc --state "$state" --results "$PWD/.ci-state/results.json"
node scripts/ci/cleanup.mjs --state "$state"
```

Without passwordless `sudo`, add the hosts line yourself before preparing, and
remove it afterwards:

```sh
echo '127.0.0.1 keycloak.oce.localhost' | sudo tee -a /etc/hosts
```

The line only helps when `/etc/hosts` is read before other resolvers. If
`nsswitch.conf` lists `resolve` first, systemd-resolved answers `*.localhost` with
`::1` as well and the hosts step fails.

The hosts step logs the resolver's answer (`Keycloak hosts: ...`) and whether it added
a line. Observed behaviour:

| Host                                                               | Answer for `keycloak.oce.localhost`               | Hosts line           |
| ------------------------------------------------------------------ | ------------------------------------------------- | -------------------- |
| Developer host, private network namespace with `hosts: files` only | `127.0.0.1` from the bind-mounted `/etc/hosts`    | not added            |
| `blacksmith-8vcpu-ubuntu-2404` runner                              | `127.0.0.1` and `::1`; `127.0.0.1` after the line | added with `sudo -n` |

## Troubleshooting

| Failure                             | Meaning                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Keycloak image step failed`        | The registry refused the pinned digest or the pull outlived its retries.                       |
| `Keycloak port step failed`         | Another service, or another Keycloak lane, holds `127.0.0.1:443`.                              |
| `Keycloak placeholders step failed` | The realm gained a placeholder that preparation does not set.                                  |
| `Keycloak hosts step failed`        | `sudo -n` was refused or the resolver still answers with another address.                      |
| `Keycloak readiness step failed`    | Read the printed container log; a literal placeholder means the import read an unset variable. |

To bump Keycloak, change `image.json` to a new 26.x digest and rerun the lane; the
login-form selectors (`#username`, `#password`, `#kc-login`) are tied to that version.
The Full Integration `openshell` lane's refresh proof shares the pin, so run it too.
