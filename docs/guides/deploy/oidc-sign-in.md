# Enable OIDC sign-in

Generic OpenID Connect (OIDC) sign-in lets enrolled accounts sign in through one
identity provider (IdP) such as Keycloak, Okta, Microsoft Entra ID or Auth0. It works
like [Google sign-in](google-sign-in.md): an Installation administrator attaches a
person's exact IdP identity to an existing OpenClaw Enterprise (OCE) account, and that
person can then sign in with the IdP or with the account password. OIDC sign-in creates
no account, maps no groups or roles, and never matches accounts by email address — except
under the experimental [trust claim](#trust-claim-enrolment-experimental) below.

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
- A certificate the API and users' browsers trust. Publicly trusted certificates need
  no extra chart configuration. For a private IdP CA, use the
  [CA Secret settings](#trust-a-private-idp-ca) below; browser trust is managed separately.

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
| Keycloak | Issuer `https://<host>/realms/<realm>`; endpoints `…/protocol/openid-connect/{auth,token,certs}`; a confidential client. Verified in CI; see [Keycloak](oidc-keycloak.md).       |
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
[production settings](../../reference/settings/oidc.md):

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

## Trust a private IdP CA

Create a Secret in the OCE namespace, distinct from the OIDC client credential
Secret, containing only approved CA certificates in PEM format. Do not
include private keys or leaf certificates:

```bash
kubectl -n openclaw-system create secret generic occ-oidc-ca-v1 \
  --from-file=ca.pem=/secure/occ/idp-ca-bundle.pem
```

First select the database's existing approved CA roots through
`database.caSecretName`. The application database URL must name the database by
DNS hostname, not an IP address, and use
`sslmode=verify-full&sslrootcert=/etc/openclaw/database-ca/ca.pem` (adjust the path
to `database.caMountPath` and `database.caKey`). A mounted CA without this URL
selection, or an IP database host, is refused before the API starts. See the
[database trust prerequisite](../../reference/settings/oidc.md) for accepted configuration.

Add these values alongside the enabled OIDC configuration:

```yaml
auth:
  oidc:
    caSecretName: occ-oidc-ca-v1
    caSecretKey: ca.pem
```

Set both values or neither. Clear both when disabling OIDC. The IdP CA Secret may
be the public trust bundle Secret named by `gatewayRouting.caSecretName` (with its
own key), never a credential Secret or `database.caSecretName`. The API's
`assemble-api-ca` init container validates this bundle and any selected Gateway
CA bundle, then combines them. Each input must contain only PEM CA certificates
and be no larger than 1 MiB. Before enabling this setting, check that any
existing Gateway bundle also meets these requirements. On the protected host,
every certificate in the file should show `CA:TRUE`:

```bash
openssl storeutl -noout -text -certs /secure/occ/idp-ca-bundle.pem | grep -E '^ +Subject:|CA:'
```

A trust-only change, where the upgrade changes nothing but these values, needs no
writer stop and no ingress closure, like
[rotating the client secret](oidc-operations.md#rotate-the-client-secret). The API
Deployment uses `Recreate`, so it answers `503` while its single Pod is replaced; the
worker keeps running. If the same upgrade also changes the image or other sign-in
settings, follow that change's procedure. Run `helm upgrade`, then wait for the API:

```bash
kubectl -n openclaw-system rollout status deployment/openclaw-enterprise-api --timeout=5m
```

`helm upgrade` prints `STATUS: deployed` even when the bundle is bad. The rollout then
times out with the Pod in `Init:Error` or `Init:CrashLoopBackOff` and ingress answering
`503`. Read the init container's error:

```bash
kubectl -n openclaw-system logs deployment/openclaw-enterprise-api -c assemble-api-ca
```

It is one line that names the value, Secret and key you set and the problem, for example:

```text
assemble-api-ca: auth.oidc.caSecretName Secret "occ-oidc-ca-v1" key "ca.pem": certificate 1 of 1 (CN=sso.example.com) is not a CA certificate; use the issuing root or intermediate CA, not the server certificate
```

A Gateway bundle problem names `gatewayRouting.caSecretName` (or the chart-managed
Gateway root) the same way. A database CA problem stops the `api` container instead,
with a `check-api-database-ca:` line naming `database.caSecretName` and its key. A
missing Secret or key leaves the Pod at `Init:0/1`; its events
(`kubectl -n openclaw-system describe pod -l app.kubernetes.io/component=api`) show
`FailedMount`. To recover, restore the previous values and run `helm upgrade`, or fix the
input as described under [Rotate the IdP CA](#rotate-the-idp-ca).

Once the rollout succeeds, list the roots the API trusts. The image has no `openssl`,
so this uses its Node and changes nothing:

```bash
kubectl -n openclaw-system exec deployment/openclaw-enterprise-api -c api -- node -e '
const { X509Certificate } = require("node:crypto");
const pem = require("node:fs").readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8");
for (const block of pem.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g)) {
  const certificate = new X509Certificate(block);
  console.log(certificate.subject.replace(/\n/g, ", "), "|", certificate.fingerprint256);
}'
```

It prints the IdP roots, then any Gateway roots. Then check recovery password sign-in,
IdP sign-in and Gateway access.

This extends public trust **process-wide in the API** for clients that use
Node's default trust. The chart does not add IdP roots to workers or Jobs, and
dedicated Agent (Harness) Pods receive only the Gateway CA through
`OCC_GATEWAY_CA_PATH`, or no extra CA without one. It preserves the Gateway CA selected by the chart, including an
external issuer's `gatewayRouting.caSecretName` and `caSecretKey`. Do not replace
`NODE_EXTRA_CA_CERTS` separately. URL, port, hostname, certificate and token checks
still apply. If the IdP certificate already chains to a root in the
`gatewayRouting.caSecretName` bundle, the API trusts it without these values, but that
bundle also reaches workers and database clients; use these values to keep IdP trust
API-only with isolated database trust. See the [trust contract](../../reference/settings/oidc.md).

### Rotate the IdP CA

The init container copies the inputs once, when the Pod starts. Prefer a new
versioned Secret for every change: changing `caSecretName` changes the Pod template,
so `helm upgrade` alone replaces the API Pod.

1. Overlap: create `occ-oidc-ca-v2` holding the old and new CA certificates together,
   set `caSecretName: occ-oidc-ca-v2`, run `helm upgrade` and the `rollout status`
   check above, and list the trusted roots.
2. Move the IdP to certificates from the new CA, and check IdP sign-in.
3. Remove the old CA: create `occ-oidc-ca-v3` holding only the new CA, and upgrade and
   check the same way.
4. Delete the superseded Secrets once you no longer need them to roll back:
   `kubectl -n openclaw-system delete secret occ-oidc-ca-v1 occ-oidc-ca-v2`.

Editing a Secret in place, including a combined Gateway CA Secret, changes nothing
until the API Pod is replaced, and restarting only the API container keeps the old
snapshot. The plain `kubectl create secret` command fails once the Secret exists, so
replace its contents and then the Pod:

```bash
kubectl -n openclaw-system create secret generic occ-oidc-ca-v2 \
  --from-file=ca.pem=/secure/occ/idp-ca-bundle.pem \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n openclaw-system rollout restart deployment/openclaw-enterprise-api
kubectl -n openclaw-system rollout status deployment/openclaw-enterprise-api --timeout=5m
```

Replacing the single API replica interrupts service until it is ready. Ordinary leaf
renewal under the same CA needs no restart.

## Find a person's subject

OCE identifies an IdP account only by the ID token's `sub` claim for this issuer.

- **Keycloak:** the user's ID on the user's **Details** page in the admin console; see
  [Keycloak](oidc-keycloak.md#find-a-persons-subject).
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
with `oidc:`; detach it with `POST /api/auth/accounts/:userId/methods/:methodId/detach`.
Detaching removes that provider from the account and ends every session, including password
sessions, but other enabled sign-in methods remain usable.

Accounts are created with a password, and an OIDC identity can be attached only
afterwards. To add someone who should sign in only through the IdP, follow
[Add a person](../topics/iam.md#add-a-person), which covers the password left behind.

## Trust-claim enrolment (experimental)

This capability is experimental and deliberately departs from the attached-only posture
described above. The Helm chart does not render it yet; configure it as environment
variables on the API Pod:

| Variable                          | Value                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `OCC_AUTH_OIDC_TRUST_CLAIM`       | The ID-token claim name that vouches for realm members.                           |
| `OCC_AUTH_OIDC_TRUST_VALUE`       | The exact string value that claim must carry.                                     |
| `OCC_AUTH_OIDC_TRUST_EMAIL_CLAIM` | Optional: the claim the same token carries the account email in. Default `email`. |

Set the claim and value together or not at all, or the API refuses to start; the email
claim requires them. Configure the IdP to issue these claims into the ID token itself: the
controller still requests only the `openid` scope, so no extra scope is asked for.

When a person from the trusted realm signs in and their **verified** ID token carries the
claim with the exact value, OCE authenticates them even though no account exists yet. It
just-in-time provisions a human account with:

- **No grants.** The account's Principal holds no Role or AccessBinding; every authorized
  operation stays refused until an administrator grants one.
- **The token's email address, when it carries a usable one.** The value of the configured
  email claim (default `email`) is stored trimmed and lower-cased like every other account
  email, and marked verified only when the token asserts `email_verified` exactly true.
  Without a usable value the account gets a deterministic placeholder address
  `oidc.<digest>@users.openclaw.invalid`. An address another account already holds is
  refused, not linked: accounts are never matched by email, so attach the identity to that
  account instead. Changing the address later is not yet implemented (follow-up).
- No password; the IdP identity is the only sign-in method.

A second sign-in of the same subject reuses the same account. A token without the claim, or
with a different value, is refused exactly as before, and the claim never overrides account
disablement. Pending attempts keep the attached-identity currentness rule: an account change
after the attempt began (for example an administrator revoking its sessions) refuses the
callback, and two simultaneous first sign-ins for one subject enroll exactly one account,
with the later-arriving callback refused until the person signs in again. Each enrolment is
audited as `authentication.account.self-enrol` before the `authentication.login` event.

## Changes, rotation and outages

- The provider instance is derived from the issuer and client ID. Changing either is a
  new instance: attach every identity again, then detach the old methods. Sessions
  signed in through the old instance, or through OIDC once it is removed, end on their
  next request. Detaching an old method ends every session of that account.
- Rotating only the client secret needs one API restart and keeps attachments; signing-key
  rotation needs none. See [Rotate the client secret](oidc-operations.md#rotate-the-client-secret).
- An IdP outage fails sign-in closed while sessions and the recovery password keep
  working. When the IdP is down before the person reaches it, OCE sees nothing; when it
  fails after, the Console says sign-in is unavailable. OIDC shares the external sign-in
  budgets with GitHub and Google. See [Read an outage](oidc-operations.md#read-an-outage).
- OCE does not learn when the IdP disables someone, and sign-out is local. For
  offboarding, see [Offboard a person](oidc-operations.md#offboard-a-person).

## Related

- [External sign-in reference](../../reference/authentication/external-sign-in.md)
- [Google sign-in](google-sign-in.md)
- [Operate OIDC sign-in](oidc-operations.md)
- [Keycloak for OIDC sign-in](oidc-keycloak.md)
- [Sign-in maintenance](auth-maintenance.md)
- [Production settings](../../reference/settings/oidc.md)
