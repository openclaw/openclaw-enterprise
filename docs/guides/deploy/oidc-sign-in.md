# Enable OIDC sign-in

Generic OpenID Connect (OIDC) sign-in lets enrolled accounts sign in through one
identity provider (IdP) such as Keycloak, Okta, Microsoft Entra ID or Auth0. It works
like [Google sign-in](google-sign-in.md): an Installation administrator attaches a
person's exact IdP identity to an existing OpenClaw Enterprise (OCE) account, and that
person can then sign in with the IdP or with the account password. OIDC sign-in creates
no account, maps no groups or roles, and never matches accounts by email address.

It uses the same guarded
[single-controller profile](../../reference/authentication/external-sign-in.md#github-sign-in-for-existing-accounts)
as GitHub and Google: exact `Origin` checks, PKCE (`S256`), one-use state, the
`__Host-` browser-binding cookie, the shared admission limits, eight-hour sessions, and
the `attemptId`, login receipt and one-use result exchange. You can enable OIDC alone or
together with GitHub and Google. One issuer is supported per Installation.

## Requirements

- Everything the [GitHub profile](../../reference/authentication/external-sign-in.md#github-sign-in-for-existing-accounts)
  requires: one serving controller, PostgreSQL State, native IAM, one canonical HTTPS
  Console origin, and `agentNativeAdmin.enabled: false`.
- A controller image that includes OIDC sign-in.
  [Build a compatible image](production-installation.md#build-and-publish-production-images).
- An IdP that serves its issuer, authorization, token and JWKS URLs over HTTPS on port
  443 from one DNS host name, and signs ID tokens with RS256 keys of at least 2,048 bits.
- API Pod HTTPS egress to that host. Browsers, not the API, visit the authorization URL.
- A certificate the API trusts. The API uses Node's default CA store; for a private CA,
  add `NODE_EXTRA_CA_CERTS` to the API Pod.

## Register the client

Create a confidential web client (authorization code flow, no implicit grant) with one
redirect URI: `OCC_AUTH_BASE_URL` followed by `/api/auth/providers/oidc/callback`, for
example `https://occ.example.com/api/auth/providers/oidc/callback`. The controller
requests only the `openid` scope, sends PKCE and a nonce, and never reads email or
profile claims. Save the client ID and secret to protected files.

Copy four values from the IdP's discovery document
(`<issuer>/.well-known/openid-configuration`): `issuer`, `authorization_endpoint`,
`token_endpoint` and `jwks_uri`. The controller never fetches the discovery document, so
these values are reviewed configuration. Each must be `https:` on port 443 with a DNS
host name, no user name, query or fragment, and all four must share the issuer's host.
Copy the issuer exactly, without a port: the controller compares it byte for byte with the
token's `iss`.

| IdP      | Values that fit                                                                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keycloak | Issuer `https://<host>/realms/<realm>`; endpoints `…/protocol/openid-connect/{auth,token,certs}` behind a TLS proxy on 443; a confidential client.                               |
| Okta     | Org server `https://<org>.okta.com` with `/oauth2/v1/…`, or a custom server `https://<org>.okta.com/oauth2/<id>` with `/oauth2/<id>/v1/…`.                                       |
| Auth0    | Issuer `https://<tenant>.auth0.com/` (with the trailing slash) or the custom domain for all four values; the application must sign with RS256.                                   |
| Entra ID | Tenant **v2** only: `https://login.microsoftonline.com/<tenant>/v2.0`, `/oauth2/v2.0/{authorize,token}`, `/discovery/v2.0/keys`. The v1 issuer `sts.windows.net` does not match. |

The `issuer` value must equal the ID token's `iss` exactly, trailing slash included.

## Configure the chart

Create a dedicated Secret, distinct from every other Secret the chart reads, including
the GitHub and Google ones:

```bash
kubectl -n openclaw-system create secret generic occ-oidc-login \
  --from-file=client-id=/secure/occ/oidc-client-id \
  --from-file=client-secret=/secure/occ/oidc-client-secret
```

Then set these values:

```yaml
auth:
  recoveryUserId: "<recovery administrator user ID>"
  oidc:
    enabled: true
    issuer: https://sso.example.com/realms/acme
    authorizationUrl: https://sso.example.com/realms/acme/protocol/openid-connect/auth
    tokenUrl: https://sso.example.com/realms/acme/protocol/openid-connect/token
    jwksUrl: https://sso.example.com/realms/acme/protocol/openid-connect/certs
    secretName: occ-oidc-login
    clientIdKey: client-id
    clientSecretKey: client-secret
    tokenAuth: client_secret_post # or client_secret_basic
    displayName: Acme SSO # optional button label, up to 40 characters
    egressCidrs: [] # optional IPv4 CIDRs
agentNativeAdmin:
  enabled: false
```

Rendering fails on the URL rules above, a shared Secret, an HTTP base URL, native
administration, an unknown `tokenAuth`, a label over 40 characters, or an invalid CIDR;
the API refuses the same values at startup. The chart adds the API-only NetworkPolicy
`openclaw-enterprise-api-oidc-login-egress` on TCP 443. Empty `egressCidrs` allows any
address except link-local `169.254.0.0/16`; list the IdP's ranges to narrow it.

The policy matches the destination Pod port after the Service forwards the connection,
not the Service port. An IdP outside the cluster is reached on 443. For an IdP that runs
in the cluster behind a Service whose `targetPort` is not 443 (for example, an ingress
gateway Service mapping 443 to Pod port 10443), the API's connection is refused, and
sign-in fails with audit reason `PROVIDER_UNAVAILABLE`. `egressCidrs` cannot help,
because the port is fixed. Add your own egress policy for the API Pod to the IdP's Pods
on their target port:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: openclaw-enterprise-api-in-cluster-idp-egress
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: openclaw-enterprise
      app.kubernetes.io/component: api
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: idp-gateway # the IdP Service's Namespace
          podSelector:
            matchLabels:
              app: idp-gateway # the Pods behind the IdP Service
      ports:
        - protocol: TCP
          port: 10443 # the Service's targetPort
```

The API reads these variables; see
[production settings](../../reference/settings/production.md#oidc-sign-in):

| Variable                                                     | Source                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| `OCC_AUTH_OIDC_ISSUER`                                       | `auth.oidc.issuer`                                        |
| `OCC_AUTH_OIDC_AUTHORIZATION_URL`, `_TOKEN_URL`, `_JWKS_URL` | `auth.oidc.authorizationUrl`, `tokenUrl`, `jwksUrl`       |
| `OCC_AUTH_OIDC_CLIENT_ID`, `OCC_AUTH_OIDC_CLIENT_SECRET`     | `auth.oidc` Secret keys                                   |
| `OCC_AUTH_OIDC_TOKEN_AUTH`                                   | `auth.oidc.tokenAuth`, rendered only when not the default |
| `OCC_AUTH_OIDC_DISPLAY_NAME`                                 | `auth.oidc.displayName`, rendered only when set           |
| `OCC_AUTH_GITHUB_RECOVERY_USER_ID`                           | `auth.recoveryUserId`                                     |

Enable it with the same stopped maintenance as
[Google](google-sign-in.md#enable-it). `GET /api/auth/providers` then returns
`oidc: true` and `oidcSignIn: {label, authorizationUrl}`, and the Console shows
**Continue with** the label (default "single sign-on"). That route needs no session, so
anyone who can reach the Console can read the label and the IdP's authorization URL, as
they could by starting a sign-in; neither is secret, but choose a label you are content to
publish.

## Find a person's subject

OCE identifies an IdP account only by the ID token's `sub` claim for this issuer.

- **Keycloak:** the user's ID on the user's **Details** page in the admin console.
- **Okta:** the user ID (`00u…`) in the user's profile URL or the Users API.
- **Auth0:** the `user_id` (for example `auth0|…`) on the user's page.
- **Entra ID:** `sub` is pairwise per application and is not shown in the portal; OCE
  does not yet offer another claim. Entra ID is not verified with OCE.

## Attach and detach

As a human Installation administrator, [sign in as a human administrator](../../reference/authentication/service-api-keys.md#sign-in-as-a-human-administrator)
so `OCC_URL`, `OCC_ORIGIN` and `OCC_SESSION_COOKIE_JAR` are set, and set `USER_ID` to the
account's `id`. Read the account version, then attach:

```bash
VERSION="$(curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" -H "Origin: $OCC_ORIGIN" \
  "$OCC_URL/api/auth/accounts/$USER_ID" | jq -er .data.version)" &&
jq -n --arg subject '<sub>' --argjson version "$VERSION" \
  '{subject: $subject, expectedVersion: $version}' |
  curl --fail-with-body --silent --show-error \
    --cookie "$OCC_SESSION_COOKIE_JAR" -H "Origin: $OCC_ORIGIN" \
    -H 'Content-Type: application/json' --data-binary @- \
    "$OCC_URL/api/auth/accounts/$USER_ID/providers/oidc"
```

The subject is 1–255 printable ASCII characters without spaces. The call returns `409`
when OIDC is off, the version is stale, the account is disabled, or another account
holds the subject ("The external identity is already assigned."). Attachment advances
the account version and ends the account's sessions. The method's `providerId` starts
with `oidc:`; detach it with `POST /api/auth/accounts/:userId/methods/:methodId/detach`,
which ends every session of the account, password sessions included.

Accounts are created with a password, and an OIDC identity can be attached only
afterwards. To add someone who should sign in only through the IdP, follow
[Add a person](../topics/iam.md#add-a-person), which covers the password left behind.

## Changes, rotation and outages

- The provider instance is derived from the issuer and client ID. Changing either is a
  new instance: attach every identity again, then detach the old methods. Sessions
  signed in through the old instance, or through OIDC once it is removed, end on their
  next request. Detaching an old method ends every session of that account.
- Rotating only the client secret keeps attachments and voids pending sign-ins.
- The API reads the JWKS on every callback, so IdP key rotation needs no restart.
- OCE does not learn when the IdP disables someone: offboarding also means detaching or
  disabling the account in OCE. Sign-out is local; while the IdP session lives, one
  click signs in again.
- An IdP outage, blocked egress or a rejected ID token fails that sign-in closed and
  returns the browser to `/console/?authError=oidc`; the recovery account's password
  still signs in. OIDC shares the external sign-in budgets with GitHub and Google.
  An IdP that cannot answer, or that refuses the configured client
  (`cause: client_rejected`), also logs `authentication.provider-unavailable-warning`
  with the failing step and cause; see the
  [external sign-in reference](../../reference/authentication/external-sign-in.md#github-sign-in-for-existing-accounts).

## Related

- [External sign-in reference](../../reference/authentication/external-sign-in.md)
- [Google sign-in](google-sign-in.md)
- [Sign-in maintenance](auth-maintenance.md)
- [Production settings](../../reference/settings/production.md#oidc-sign-in)
