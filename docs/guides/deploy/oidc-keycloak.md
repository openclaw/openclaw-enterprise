# Use Keycloak for OIDC sign-in

Connect OpenClaw Enterprise (OCE) human sign-in to an organization-managed
Keycloak through the existing [OIDC integration](oidc-sign-in.md). Choose a
production Keycloak realm and create a dedicated confidential client for OCE.
A person can use Keycloak to sign in only after an Installation administrator
attaches that person's Keycloak subject to an existing OCE account; Keycloak
groups, roles, and email do not grant OCE permissions.

## Prepare Keycloak and OCE

The organization deploys and operates Keycloak separately. OCE's chart configures
its OIDC client; it does not install production Keycloak. The Keycloak operator owns
production mode (`start`), a supported persistent database, stable hostname and TLS,
restricted administrator access, updates, backups and restore, monitoring, and the
availability appropriate to the deployment. Follow Keycloak's
[production configuration](https://www.keycloak.org/server/configuration-production)
and, if applicable, [reverse proxy guidance](https://www.keycloak.org/server/reverseproxy).
The CI and Local Setup fixture uses `start-dev` and a development file database;
it is not a production deployment.

The proposed OCE compatibility policy is Keycloak 26.x, pending team acceptance. The real-provider CI fixture
currently pins **26.7.5** by digest in
[`image.json`](../../../tests/fixtures/keycloak/image.json); the pin is the version
exercised by that fixture, not qualification of every 26.x deployment. Other major
versions are not verified. Qualify your actual production configuration before use.

Prepare the [guarded OIDC profile](oidc-sign-in.md#requirements): one serving
controller, PostgreSQL State, native IAM, one canonical HTTPS Console origin, and
`agentNativeAdmin.enabled: false`. Rolling or mixed-version serving is unsupported.
Verify access to a password recovery administrator before making changes. Configure
[trusted proxy settings](../../reference/settings/production.md#github-sign-in-and-trusted-proxies) when
the API otherwise sees a shared proxy address, so sign-in admission limits use the
intended client address.

The following route assumes a Keycloak HTTPS endpoint with a publicly trusted
certificate. OCE requires:

- **One HTTPS host on port 443:** the issuer, authorization, token and JWKS URLs
  use the same DNS host. Write the issuer without a port; the authorization, token
  and JWKS URLs may explicitly include `:443`. Browsers reach and trust the
  authorization endpoint; the API must reach and trust the token and JWKS endpoints.
- **A stable issuer:** configure Keycloak's fixed hostname, for example
  `https://sso.example.com` or `https://sso.example.com/auth` for a context path.
  The discovery document's issuer, such as
  `https://sso.example.com/realms/acme`, must match `auth.oidc.issuer` and the
  ID token's `iss` exactly. Do not use a `*.localhost` name for a Keycloak the API
  must reach from a Pod: the controller image resolves it to loopback.
- **RS256 and a client-only audience:** ID tokens must use an RSA signing key of
  at least 2,048 bits named by its `kid` in the JWKS. Keep the client ID token
  signature algorithm at RS256 and do not add an audience mapper: OCE rejects an
  additional audience.

For a private CA, the chart version covered by this guide has no OIDC CA value
or turnkey mount. Use an explicit, upgrade-safe deployment customization to mount a combined public CA
bundle for the API, configure `NODE_EXTRA_CA_CERTS` to read it, and restart the
Node process after trust changes. Preserve any existing Gateway CA roots in that
bundle: the chart may already set `NODE_EXTRA_CA_CERTS` for Gateway routing, so
replacing it with only the Keycloak CA can break Gateway trust. See
[Gateway trust and rotation](../../reference/gateway-routing.md#tls-and-certificate-lifecycle).
Verify the customized deployment and its trust after each upgrade.

The chart's OIDC NetworkPolicy permits API egress on TCP 443. For an in-cluster
Keycloak endpoint behind a Service with a non-443 `targetPort`, add a separate
[egress policy](oidc-sign-in.md#configure-the-chart) for the destination Pod port;
`auth.oidc.egressCidrs` alone cannot change that port. Verify the selected topology
and policy in your deployment.

## Create the OCE client

Choose an organization-managed realm. Realm login settings, password and user
policies, enrollment, and federation are the organization's responsibility. People
may already exist in the realm or come from a federated identity source; OCE does
not require fixture users or create Keycloak users.

In the Keycloak admin console, create a client dedicated to OCE:

1. Under **Clients → Create client**, select `OpenID Connect` and choose a client
   ID, for example `oce-console`.
2. Turn on **Client authentication** and **Standard flow**. Turn off **Direct
   access grants**, **Implicit flow**, **Service accounts roles**, **Standard
   Token Exchange**, **OAuth 2.0 Device Authorization Grant** and **OIDC CIBA
   Grant**.
3. Set one **Valid redirect URI** to `OCC_AUTH_BASE_URL` followed by
   `/api/auth/providers/oidc/callback`, for example
   `https://occ.example.com/api/auth/providers/oidc/callback`. Leave **Web origins**
   empty.
4. Under **Logout settings**, turn off **Front channel logout** and **Backchannel
   logout session required**; OCE implements neither. Under **Advanced settings**,
   set **Proof Key for Code Exchange Code Challenge Method** to `S256`.
5. On **Credentials**, use **Client Id and Secret**. Save the ID and secret in
   protected files for the dedicated OCE Secret. The authenticator accepts
   `client_secret_post` and `client_secret_basic`.

Leave client scopes and mappers at their defaults unless your organization has
verified that changes meet OCE's token requirements. OCE requests only `openid`
and reads no email or profile claims.

The checked-in realm and its fixed identities are **disposable CI/local fixtures**.
Do not import the fixture realm as a production provisioning shortcut: its test
users and placeholder credentials are not production identities or secrets. For
the test-only import and generated credentials, see the
[Keycloak OIDC lane](../../testing/keycloak.md).

## Configure and enable OCE

1. Read the discovery document at `<issuer>/.well-known/openid-configuration`.
   Confirm that its issuer and same-host HTTPS endpoints meet the requirements
   above. For example, realm `acme` on `sso.example.com` supplies:

   ```yaml
   auth:
     oidc:
       issuer: https://sso.example.com/realms/acme
       authorizationUrl: https://sso.example.com/realms/acme/protocol/openid-connect/auth
       tokenUrl: https://sso.example.com/realms/acme/protocol/openid-connect/token
       jwksUrl: https://sso.example.com/realms/acme/protocol/openid-connect/certs
       tokenAuth: client_secret_post # client_secret_basic is also available
   ```

   These are example values; copy and review your own discovery values. OCE does
   not fetch discovery for configuration. Verify API Pod DNS, TLS trust, and
   network access to the token and JWKS endpoints.

2. Create the dedicated Secret from the protected client ID and secret files and
   configure `auth.oidc.enabled`, `secretName`, the Secret keys,
   `auth.recoveryUserId`, and the other chart values in
   [Configure the chart](oidc-sign-in.md#configure-the-chart).
3. Follow the linked [stopped maintenance procedure](google-sign-in.md#enable-it):
   close ingress, stop identity writers, upgrade, and verify through restricted
   access before reopening ingress. Retain the verified password recovery account.
4. Find each person's Keycloak `sub` and
   [attach it to the person's existing OCE account](oidc-sign-in.md#attach-and-detach)
   as a human Installation administrator. Grant the OCE permissions the person
   needs using [IAM](../topics/iam.md); an attachment alone grants no permissions.
   Verify browser sign-in and the person's expected OCE access.
5. Verify that a valid, unattached Keycloak identity is refused and that the
   recovery administrator can still sign in with a password, including during an
   IdP outage. Password sign-in defaults to `all`. After every ordinary account
   has an attached external identity and each person has verified sign-in, follow
   the staged [recovery-only procedure](../../reference/authentication/external-sign-in.md#recovery-only-password-sign-in)
   if you choose to restrict password sign-in to the recovery administrator.

## Find a person's subject

OCE attaches the ID token's `sub`, which for Keycloak is the user's ID:

- **Admin console:** **Users →** the user **→ Details**, the **ID** field.
- **Admin API:** `GET /admin/realms/<realm>/users?username=<name>&exact=true`
  returns it as `id`.

Confirm the subject belongs to the intended person and issuer before attachment.
See [Attach and detach](oidc-sign-in.md#attach-and-detach) for the guarded API
procedure.

## Operate and verify

Qualify the actual production deployment with browser sign-in, expected OCE
permissions, unattached-user refusal, recovery during provider outage, Keycloak
restart and persistence, signing-key and client-secret rotation, and offboarding.
Record the results for the topology and versions you operate. The fixture evidence
below does not qualify a production Keycloak deployment.

OCE sign-out ends the local OCE session, not the Keycloak session; a person may
sign in again while the Keycloak session remains active. Disabling a user in
Keycloak prevents new provider sign-ins but does not end an existing OCE session.
For offboarding, disable the OCE account and separately revoke applicable service
keys. Follow
[Changes, rotation and outages](oidc-sign-in.md#changes-rotation-and-outages) for
session limits, client-secret rotation, issuer or client-ID changes, and recovery.

## CI verification and limits

The `keycloak-oidc` CI lane uses the pinned real Keycloak and Chromium, the
imported test realm, `start-dev` storage, fixture TLS and test HTTPS ingress. It
composes the production API in a host process; it does not deploy a production
Keycloak topology. The lane runs in full-mode pull request CI and on pushes to
`main`, but is not a dependency of `CI Required`; documentation-only and test-only
CI modes do not run it.

The lane checks discovery and the signing key, attached sign-in with both client
authentication methods, signing-key rotation, refusal of an unattached user, and
local sign-out and user disablement behavior. See the
[Keycloak OIDC lane](../../testing/keycloak.md#verified-flows) for each test and
its evidence. Keycloak behind a TLS proxy, Keycloak in the same cluster as the API,
other major versions, and a production `start` deployment with a persistent external
database are not qualified by this fixture. Operator browser and recovery checks
remain necessary for the actual deployment.

## Related

- [Enable OIDC sign-in](oidc-sign-in.md)
- [External sign-in reference](../../reference/authentication/external-sign-in.md)
- [Keycloak OIDC lane](../../testing/keycloak.md)
