# OIDC controller settings

`auth.oidc.enabled` enables generic OpenID Connect sign-in for the API. It requires
the [single-controller external sign-in profile](../authentication/external-sign-in.md#external-sign-in-profile)
and a recovery account. Use [Enable OIDC sign-in](../../guides/deploy/oidc-sign-in.md)
for setup.

To configure named providers, put the settings below under
`auth.oidc.providers.<key>`. Start each key with a lowercase letter. Use a maximum
of 32 lowercase letters, digits, and hyphens. Give each provider its own `secretName`
and a distinct button label. Label comparison ignores case and surrounding
spaces. For example, `Équipe` and `équipe` count as the same label. The default
label is the provider key. The default Secret keys are `client-id` and
`client-secret`.

Helm sets `OCC_AUTH_OIDC_PROVIDERS` to the comma-separated list of provider keys.
For each named provider it inserts the uppercase key after `OCC_AUTH_OIDC_` and
changes hyphens to underscores. For example, `keycloak-sso` uses
`OCC_AUTH_OIDC_KEYCLOAK_SSO_ISSUER`. For a single provider you can use the flat
settings and variables in the table.

| Variable                                                     | Helm value                                          | Behavior                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `OCC_AUTH_OIDC_ISSUER`                                       | `auth.oidc.issuer`                                  | The exact `iss`; with the client ID it determines the provider instance.                    |
| `OCC_AUTH_OIDC_AUTHORIZATION_URL`, `_TOKEN_URL`, `_JWKS_URL` | `auth.oidc.authorizationUrl`, `tokenUrl`, `jwksUrl` | `https:` on 443 on the issuer's DNS host, no userinfo, query or fragment. Never discovered. |
| `OCC_AUTH_OIDC_CLIENT_ID`, `OCC_AUTH_OIDC_CLIENT_SECRET`     | `auth.oidc` Secret keys                             | Read from the dedicated `auth.oidc.secretName` Secret. All required values or none.         |
| `OCC_AUTH_OIDC_TOKEN_AUTH`                                   | `auth.oidc.tokenAuth`                               | `client_secret_post` (default, not rendered) or `client_secret_basic`.                      |
| `OCC_AUTH_OIDC_DISPLAY_NAME`                                 | `auth.oidc.displayName`                             | Optional Console label, 1–40 printable characters.                                          |

The `enrollment` setting becomes an `ENROLLMENT` variable with the JSON
[OIDC enrollment policy](../authentication/team-enrollment.md). This policy
controls account creation at first sign-in.

The `legacyCallback` setting keeps the existing `/api/auth/providers/oidc/callback`
path. Set it to `true` on at most one named provider. Helm sets the provider's
`LEGACY_CALLBACK` variable. Other named providers use
`/api/auth/providers/oidc/<key>/callback`.

The named provider setting `allowSelfLink` defaults to `false`. Set it to `true`
on both providers to permit [self-service linking](../authentication/external-sign-in.md#external-sign-in-profile)
between them. Helm sets the provider's `ALLOW_SELF_LINK` variable. Administrator
attachment and enrollment use their own rules.

In an installation profile, put named provider settings under
`controlPlane.oidc.providers.<key>`. For the flat settings, use `controlPlane.oidc`.

With `auth.oidc.enabled`, the chart adds the API-only egress policy
`openclaw-enterprise-api-oidc-login-egress` on TCP 443. The policy allows the ranges
from each provider's `egressCidrs`. An empty list for any provider opens TCP 443
to every IPv4 address outside link-local `169.254.0.0/16`. The port is the destination Pod's
port; an IdP inside the cluster on another target port needs
[its own egress policy](../../guides/deploy/oidc-sign-in.md#configure-the-chart). Rendering rejects invalid endpoint settings,
a Secret shared with Google or another chart credential Secret, or an HTTP base URL.
OIDC supports native Agent access.

`auth.oidc.caSecretName` and `auth.oidc.caSecretKey` select an optional public PEM
CA bundle for all configured providers from a Secret in the release namespace.
Set both values when you enable OIDC with a private CA. The CA Secret must not be a credential
Secret the chart reads or `database.caSecretName`; it may share a public trust bundle
Secret with `gatewayRouting.caSecretName` or `repositoryCredentials.publicCaSecretName`.
Helm rejects invalid names, keys, shared credential Secrets and partial
configuration. Required Secret projection and the `assemble-api-ca` init container
gate API startup. Each input must contain only parseable PEM CA certificates, at
most 1 MiB, without private keys or leaf certificates. This also applies to a
selected Gateway CA bundle when OIDC CA trust is configured.

This opt-in also requires a separately selected `database.caSecretName`, distinct
from the IdP CA Secret. The application URL must name the database by DNS hostname
and use `sslmode=verify-full` and
`sslrootcert=<database.caMountPath>/<database.caKey>`; mounting the Secret alone
is insufficient. IP literal and Unix socket hosts are refused: the PostgreSQL client
sends no TLS server name for an IP host, so Node would check the certificate against
`localhost` instead of the address. Preserve the database's approved roots in that certificate-only
PEM bundle (at most 1 MiB), including public roots if needed. Do not add IdP roots
unless they were independently approved for the database.

Before loading the server, the API checks its actual `OCC_DATABASE_URL` with the
installed PostgreSQL client parser and refuses absent, unreadable, empty or invalid
CA material, ineffective TLS settings, IP or socket hosts (including a `host`
parameter), duplicate URL parameters and nested connection strings. Errors omit the URL and credentials. Password and workload-identity
pools retain this explicit CA; database TLS does not inherit the added IdP roots or
Node's default roots. This checks local configuration at each API process start,
not database reachability.
Change database CA material only during stopped maintenance, then replace the Pod.

The init container combines the IdP bundle with the Gateway CA, when selected, in a
memory volume with a 4 MiB size limit. The API reads it through `NODE_EXTRA_CA_CERTS`, extending
Node's public roots process-wide for API clients using default trust, including
token/JWKS requests. Clients with an explicit CA store keep that store. IdP roots
are not added to workers, Jobs or Agents: the chart also sets `OCC_GATEWAY_CA_PATH`
to the Gateway-only bundle (empty without one), and Harness node enrollment reads
that instead of the combined bundle. An external Gateway issuer without a
custom CA contributes no extra roots. With no OIDC CA values, existing chart trust
wiring is unchanged. TLS verification and OIDC URL restrictions are unchanged.

Secret name/key changes replace the API Pod. Secret content changes require explicit
API Pod replacement, including changes to a combined Gateway CA: assembly and Node
trust loading happen at startup, without hot reload. Restarting only the API
container keeps the init snapshot. The single API replica is interrupted during
replacement. See [private CA setup and rotation](../../guides/deploy/oidc-sign-in.md#trust-a-private-idp-ca).
