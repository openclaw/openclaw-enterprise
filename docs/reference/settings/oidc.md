# OIDC controller settings

`auth.oidc.enabled` enables generic OpenID Connect sign-in for the API. It requires
the [single-controller external sign-in profile](../authentication/external-sign-in.md#github-sign-in-for-existing-accounts)
and a recovery account. Use [Enable OIDC sign-in](../../guides/deploy/oidc-sign-in.md)
for setup.

| Variable                                                     | Helm value                                          | Behavior                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `OCC_AUTH_OIDC_ISSUER`                                       | `auth.oidc.issuer`                                  | The exact `iss`; with the client ID it determines the provider instance.                    |
| `OCC_AUTH_OIDC_AUTHORIZATION_URL`, `_TOKEN_URL`, `_JWKS_URL` | `auth.oidc.authorizationUrl`, `tokenUrl`, `jwksUrl` | `https:` on 443 on the issuer's DNS host, no userinfo, query or fragment. Never discovered. |
| `OCC_AUTH_OIDC_CLIENT_ID`, `OCC_AUTH_OIDC_CLIENT_SECRET`     | `auth.oidc` Secret keys                             | Read from the dedicated `auth.oidc.secretName` Secret. All required values or none.         |
| `OCC_AUTH_OIDC_TOKEN_AUTH`                                   | `auth.oidc.tokenAuth`                               | `client_secret_post` (default, not rendered) or `client_secret_basic`.                      |
| `OCC_AUTH_OIDC_DISPLAY_NAME`                                 | `auth.oidc.displayName`                             | Optional Console label, 1–40 printable characters.                                          |

With `auth.oidc.enabled`, the chart adds the API-only egress policy
`openclaw-enterprise-api-oidc-login-egress` on TCP 443. Empty `auth.oidc.egressCidrs`
allows any address except link-local `169.254.0.0/16`. The port is the destination Pod's
port; an IdP inside the cluster on another target port needs
[its own egress policy](../../guides/deploy/oidc-sign-in.md#configure-the-chart). Rendering fails on values the API refuses,
a Secret shared with GitHub, Google or any other chart Secret, `agentNativeAdmin.enabled`
with OIDC, or an HTTP base URL.

`auth.oidc.caSecretName` and `auth.oidc.caSecretKey` optionally select a public PEM
CA bundle from a Secret in the release namespace. Both default to empty; set both
or neither, and only while OIDC is enabled. The CA Secret must differ from the
OIDC client credential Secret. Helm rejects invalid names, keys and partial
configuration. Required Secret projection and the `assemble-api-ca` init container
gate API startup. Each input must contain only parseable PEM CA certificates, at
most 1 MiB, without private keys or leaf certificates. This also applies to a
selected Gateway CA bundle when OIDC CA trust is configured.

This opt-in also requires a separately selected `database.caSecretName`, distinct
from the IdP CA Secret. The application URL must use `sslmode=verify-full` and
`sslrootcert=<database.caMountPath>/<database.caKey>`; mounting the Secret alone
is insufficient. Preserve the database's approved roots in that certificate-only
PEM bundle (at most 1 MiB), including public roots if needed. Do not add IdP roots
unless they were independently approved for the database.

Before loading the server, the API checks its actual `OCC_DATABASE_URL` with the
installed PostgreSQL client parser and refuses absent, unreadable, empty or invalid
CA material, ineffective TLS settings, duplicate URL parameters and nested
connection strings. Errors omit the URL and credentials. Password and workload-identity
pools retain this explicit CA; database TLS does not inherit the added IdP roots or
Node's default roots. This checks local configuration at each API process start,
not database reachability.
Change database CA material only during stopped maintenance, then replace the Pod.

The init container combines the IdP bundle with the Gateway CA, when selected, in a
bounded memory volume. The API reads it through `NODE_EXTRA_CA_CERTS`, extending
Node's public roots process-wide for API clients using default trust, including
token/JWKS requests. Clients with an explicit CA store keep that store. IdP roots
are not added to workers, Jobs or Agents. An external Gateway issuer without a
custom CA contributes no extra roots. With no OIDC CA values, existing chart trust
wiring is unchanged. TLS verification and OIDC URL restrictions are unchanged.

Secret name/key changes replace the API Pod. Secret content changes require explicit
API Pod replacement, including changes to a combined Gateway CA: assembly and Node
trust loading happen at startup, without hot reload. Restarting only the API
container keeps the init snapshot. The single API replica is interrupted during
replacement. See [private CA setup and rotation](../../guides/deploy/oidc-sign-in.md#trust-a-private-idp-ca).
