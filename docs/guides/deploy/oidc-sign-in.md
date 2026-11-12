# Enable OIDC sign-in

OpenID Connect (OIDC) lets people sign in through an identity provider (IdP),
such as Okta or Keycloak. You can configure more than one IdP in the same
Installation. Enable [self-service linking](#link-an-existing-account) to let
users add a sign-in method to an existing OCE account.
Configure [OIDC enrollment](../../reference/authentication/team-enrollment.md)
to let eligible users create an account at first sign-in.
For existing direct GitHub installations, follow the [upgrade procedure](oidc-upgrade.md).

The [external sign-in profile](../../reference/authentication/external-sign-in.md#external-sign-in-profile)
applies. You can also enable Google sign-in.

## Requirements

- Everything the [external sign-in profile](../../reference/authentication/external-sign-in.md#external-sign-in-profile)
  requires: one serving controller, PostgreSQL State, native IAM, one canonical HTTPS
  Console origin, and an Agent DNS suffix under the same non-public domain.
  OIDC can enable [native chat and administration](native-admin.md); the existing
  `operate` and `administer` permissions select access.
- A controller image that includes OIDC sign-in.
  [Build a compatible image](production-installation.md#build-and-publish-production-images).
- An IdP that serves its issuer, authorization, token and JWKS URLs over HTTPS on port
  443 from one DNS host name, and signs ID tokens with RS256 keys of at least 2,048 bits.
- API Pod HTTPS egress to each IdP host. The browser visits the authorization URL.
- A certificate the API and users' browsers trust. Publicly trusted certificates need
  no extra chart configuration. For a private IdP CA, use the
  [CA Secret settings](#trust-a-private-idp-ca) below; browser trust is managed separately.

## Register the client

Create a confidential web client for each IdP. Enable only the authorization code flow.
Register one redirect URI per client. Use the Console base URL followed by the
path in the table.

| Configuration                           | Callback path                                |
| --------------------------------------- | -------------------------------------------- |
| Named `okta`                            | `/api/auth/providers/oidc/okta/callback`     |
| Named `keycloak`                        | `/api/auth/providers/oidc/keycloak/callback` |
| Flat settings or `legacyCallback: true` | `/api/auth/providers/oidc/callback`          |

For example, the named Okta client can use
`https://occ.example.com/api/auth/providers/oidc/okta/callback`.
The controller sends PKCE and a nonce. It requests `openid`, plus `email`,
`profile` and any configured scopes when enrollment is enabled.

For first-login account creation, configure the IdP to include a standard `email`
and the admission group claim in its signed ID token. Send one group as a string
or several groups as an array of strings. Set `createAccount.requireVerifiedEmail`
to `false` in the provider's enrollment policy only if your policy permits account
creation with unverified email. The default is `true`. See the
[enrollment settings](../../reference/authentication/team-enrollment.md) for the
configuration paths, claim validation, and initial access.

Copy four values from the IdP's discovery document
(`<issuer>/.well-known/openid-configuration`): `issuer`, `authorization_endpoint`,
`token_endpoint` and `jwks_uri`. The controller never fetches the discovery document, so
these values are reviewed configuration. Each must be `https:` on port 443 with a DNS
host name, no user name, query or fragment, and all four must share the issuer's host.
Copy the issuer without a port. Keep the trailing slash if the token's `iss` includes it.

| IdP      | Values that fit                                                                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keycloak | Issuer `https://<host>/realms/<realm>`; endpoints `…/protocol/openid-connect/{auth,token,certs}`; a confidential client. Verified in CI; see [Keycloak](oidc-keycloak.md).       |
| Okta     | Org server `https://<org>.okta.com` with `/oauth2/v1/…`, or a custom server `https://<org>.okta.com/oauth2/<id>` with `/oauth2/<id>/v1/…`.                                       |
| Auth0    | Issuer `https://<tenant>.auth0.com/` (with the trailing slash) or the custom domain for all four values; the application must sign with RS256.                                   |
| Entra ID | Tenant **v2** only: `https://login.microsoftonline.com/<tenant>/v2.0`, `/oauth2/v2.0/{authorize,token}`, `/discovery/v2.0/keys`. The v1 issuer `sts.windows.net` does not match. |

## Configure the chart

Put the client ID and client secret for each provider in the protected files
shown below. Create one Kubernetes Secret per provider in the release namespace.

```bash
for provider in okta keycloak; do
  kubectl -n openclaw-system create secret generic "occ-${provider}-login" \
    --from-file="client-id=/secure/occ/${provider}-client-id" \
    --from-file="client-secret=/secure/occ/${provider}-client-secret"
done
```

Add these settings to your Helm values file. The file gives Helm the name of each
Secret. Kubernetes reads the client ID and secret from that Secret when it starts
the API Pod.

```yaml
auth:
  recoveryUserId: "<recovery administrator user ID>"
  oidc:
    enabled: true
    providers:
      okta:
        displayName: Okta
        issuer: https://example.okta.com/oauth2/default
        authorizationUrl: https://example.okta.com/oauth2/default/v1/authorize
        tokenUrl: https://example.okta.com/oauth2/default/v1/token
        jwksUrl: https://example.okta.com/oauth2/default/v1/keys
        secretName: occ-okta-login
        tokenAuth: client_secret_basic
      keycloak:
        displayName: Keycloak
        issuer: https://sso.example.com/realms/acme
        authorizationUrl: https://sso.example.com/realms/acme/protocol/openid-connect/auth
        tokenUrl: https://sso.example.com/realms/acme/protocol/openid-connect/token
        jwksUrl: https://sso.example.com/realms/acme/protocol/openid-connect/certs
        secretName: occ-keycloak-login
```

Set each client's token authentication method to match `tokenAuth`. The default
is `client_secret_post`. For a single provider with a flat configuration, put its
settings directly under `auth.oidc`. See [OIDC controller settings](../../reference/settings/oidc.md)
for optional fields and installation profiles.

OIDC supports [native browser access](native-admin.md); enable it separately
when users need Agent chat or administration.

Set `egressCidrs` for each provider to limit the API Pod's HTTPS access to the
configured IPv4 ranges. If any provider has an empty list, the Pod can reach
TCP 443 on every IPv4 address outside link-local `169.254.0.0/16`.

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

Enable OIDC during [stopped maintenance](google-sign-in.md#enable-it). When the
API Pod is ready, open the Console. Check that it shows a button for each provider.
`GET /api/auth/providers` lists the labels and authorization URLs without a session.

### Keep an existing callback path

To add a second provider, move your current provider's settings into
`auth.oidc.providers.<key>`. Keep its issuer and client ID so that existing account
links still work. Set `legacyCallback: true` in that entry to keep
`/api/auth/providers/oidc/callback`. Register the named callback path for each
provider that you add.

## Trust a private IdP CA

Put only approved CA certificates in the PEM bundle. Use one bundle for all
providers that use private CAs. Create a separate Secret for the bundle in the
OCE namespace.

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

Replacing the single API replica interrupts Console requests and closes open Agent
connections. After the API is ready, reload the named Agent page. With the same
authentication settings, a live Console session and an unexpired host-only handle
can reopen the same Agent revision. If the handle expired or the revision changed,
open the Agent again from the Console. Ordinary leaf renewal under the same CA
needs no restart.

## Link an existing account

Set `allowSelfLink: true` on both named providers. The default is `false`.
Enable it on providers that you trust to open the same accounts with the same
existing access.

In the Console, select **Link an existing account**, then sign in with the
provider you want to add. When the Console asks, sign in again with a different
provider that is already on your account. You can then use either provider to
open that account.

An administrator can [attach an identity](#attach-and-detach) regardless of this
setting. Use attachment for users who have no working OIDC method to confirm
the link.

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
account's `id`. Set `PROVIDER_PATH` to `oidc/<key>` for a named provider or `oidc`
for the flat settings. Read the account version and attach the identity.

```bash
VERSION="$(curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" -H "Origin: $OCC_ORIGIN" \
  "$OCC_URL/api/auth/accounts/$USER_ID" | jq -er .data.version)" &&
jq -n --arg subject '<sub>' --argjson version "$VERSION" \
  '{subject: $subject, expectedVersion: $version}' |
  curl --fail-with-body --silent --show-error \
    --cookie "$OCC_SESSION_COOKIE_JAR" -H "Origin: $OCC_ORIGIN" \
    -H 'Content-Type: application/json' --data-binary @- \
    "$OCC_URL/api/auth/accounts/$USER_ID/providers/$PROVIDER_PATH"
```

The subject is 1–255 printable ASCII characters without spaces. The call returns `409`
when OIDC is off, the version is stale, the account is disabled, or another account
holds the subject ("The external identity is already assigned."). Attachment advances
the account version and ends the account's sessions. The method's `providerId` starts
with `oidc:`; detach it with `POST /api/auth/accounts/:userId/methods/:methodId/detach`.
Detaching removes that provider from the account and ends every session, including password
sessions, but other enabled sign-in methods remain usable.

To create an account before attaching its first provider, follow
[Add a person](../topics/iam.md#add-a-person).

## Changes, rotation and outages

- Changing the issuer or client ID creates a new provider instance. When the
  replacement API starts, it ends sessions for the old or removed instance.
  Restoring that instance keeps its attachments. Users must sign in again.
  To move to a new instance, attach identities to it and detach the old methods.
  Detaching an old method ends every session of that account.
- Rotating only the client secret needs one API restart. Attachments and
  sessions remain. See [Rotate the client secret](oidc-operations.md#rotate-the-client-secret)
  and [Rotate the IdP signing key](oidc-operations.md#rotate-the-idp-signing-key).
- During an IdP outage, users can sign in with another configured provider
  already on their account. Existing sessions and the recovery password keep
  working. See [Read an outage](oidc-operations.md#read-an-outage).
- OCE does not learn when the IdP disables someone, and sign-out is local. For
  offboarding, see [Offboard a person](oidc-operations.md#offboard-a-person).

## Related

- [External sign-in reference](../../reference/authentication/external-sign-in.md)
- [Google sign-in](google-sign-in.md)
- [Operate OIDC sign-in](oidc-operations.md)
- [Keycloak for OIDC sign-in](oidc-keycloak.md)
- [Sign-in maintenance](auth-maintenance.md)
- [Production settings](../../reference/settings/oidc.md)
