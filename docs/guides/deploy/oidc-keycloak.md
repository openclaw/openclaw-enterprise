# Use Keycloak for OIDC sign-in

Connect OpenClaw Enterprise (OCE) human sign-in to an organization-managed
Keycloak through the [OIDC integration](oidc-sign-in.md). Choose a production
realm and create a dedicated confidential client for OCE. You can use Keycloak
as the only provider or alongside other sign-in providers.

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

The real-provider CI fixture pins Keycloak **26.7.5** by digest in
[`image.json`](../../../tests/fixtures/keycloak/image.json). That is the only version
CI exercises; other versions, including other 26.x releases, are not verified.
Qualify your actual production configuration before use.

Prepare the [guarded OIDC profile](oidc-sign-in.md#requirements): one serving
controller, PostgreSQL State, native IAM, and one canonical HTTPS Console origin.
Rolling or mixed-version serving is unsupported.
Verify access to a password recovery administrator before making changes. Configure
[trusted proxy settings](../../reference/settings/production.md#external-sign-in-and-trusted-proxies) when
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
  `https://sso.example.com/realms/acme`, must match the configured issuer and the
  ID token's `iss` exactly. Do not use a `*.localhost` name for a Keycloak the API
  must reach from a Pod: the controller image resolves it to loopback.
- **RS256 and a client-only audience:** ID tokens must use an RSA signing key of
  at least 2,048 bits named by its `kid` in the JWKS. Keep the client ID token
  signature algorithm at RS256 and do not add an audience mapper: OCE rejects an
  additional audience.

For a private CA, set `auth.oidc.caSecretName` and `auth.oidc.caSecretKey`; see
[Trust a private IdP CA](oidc-sign-in.md#trust-a-private-idp-ca). The chart combines
the Keycloak root with any selected Gateway CA for the API only. Do not set
`NODE_EXTRA_CA_CERTS` separately.

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
3. Set one **Valid redirect URI** to the Console base URL followed by
   `/api/auth/providers/oidc/keycloak/callback`, for example
   `https://occ.example.com/api/auth/providers/oidc/keycloak/callback`. Replace
   `keycloak` with your provider key. If you use flat settings or set
   `legacyCallback: true`, use `/api/auth/providers/oidc/callback`. Leave
   **Web origins** empty.
4. Under **Logout settings**, turn off **Front channel logout** and **Backchannel
   logout session required**; OCE implements neither. Under **Advanced settings**,
   set **Proof Key for Code Exchange Code Challenge Method** to `S256`.
5. On **Credentials**, use **Client Id and Secret**. Save the ID and secret in
   protected files for the dedicated OCE Secret. The authenticator accepts
   `client_secret_post` and `client_secret_basic`.

OCE requests `openid`. With [OIDC enrollment](../../reference/authentication/team-enrollment.md)
it also requests `email`, `profile`, and any scopes that you configure.
If your enrollment rules use a group claim, configure a Keycloak mapper to put
that claim in the ID token. Check the token requirements above after changing
scopes or mappers.

The checked-in realm and its fixed identities are **disposable CI/local fixtures**.
Do not import the fixture realm as a production provisioning shortcut: its test
users and placeholder credentials are not production identities or secrets. For
the test-only import and generated credentials, see the
[Keycloak OIDC lane](../../testing/kubernetes.md#keycloak-oidc-tests).

## Configure and enable OCE

1. Read the discovery document at `<issuer>/.well-known/openid-configuration`.
   Confirm that its issuer and same-host HTTPS endpoints meet the requirements
   above. For example, realm `acme` on `sso.example.com` supplies:

   ```yaml
   auth:
     oidc:
       enabled: true
       providers:
         keycloak:
           displayName: Keycloak
           issuer: https://sso.example.com/realms/acme
           authorizationUrl: https://sso.example.com/realms/acme/protocol/openid-connect/auth
           tokenUrl: https://sso.example.com/realms/acme/protocol/openid-connect/token
           jwksUrl: https://sso.example.com/realms/acme/protocol/openid-connect/certs
           secretName: occ-keycloak-login
   ```

   These are example values; copy and review your own discovery values. OCE does
   not fetch discovery for configuration. Verify API Pod DNS, TLS trust, and
   network access to the token and JWKS endpoints.

2. Create the dedicated Secret from the protected client ID and secret files and
   set `auth.recoveryUserId` and any other required chart values in
   [Configure the chart](oidc-sign-in.md#configure-the-chart).
3. Follow the linked [stopped maintenance procedure](google-sign-in.md#enable-it):
   close ingress, stop identity writers, upgrade, and verify through restricted
   access before reopening ingress. Retain the verified password recovery account.
4. Choose how people get access. An Installation administrator can
   [attach a Keycloak identity](oidc-sign-in.md#attach-and-detach) to an
   existing account. To let eligible users create an account at first sign-in,
   [configure enrollment](../../reference/authentication/team-enrollment.md).
   To let users connect Keycloak to an existing OCE account, enable
   [self-service linking](oidc-sign-in.md#link-an-existing-account) on Keycloak
   and the provider they already use.
5. Verify browser sign-in, the expected OCE permissions, and refusal for an
   identity that has neither an attachment nor permission to enroll. Verify that
   the recovery administrator can sign in with a password during a Keycloak
   outage. Password sign-in defaults to `all`. After every ordinary account
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
keys. Follow [Operate OIDC sign-in](oidc-operations.md) for offboarding commands,
client-secret and signing-key rotation, outages and the audit record.

## CI verification and limits

The `keycloak-oidc` CI lane uses the pinned real Keycloak and Chromium, the
imported test realm, `start-dev` storage, fixture TLS and test HTTPS ingress. It
composes the production API in a host process; it does not deploy a production
Keycloak topology. The lane runs in full-mode pull request CI and on pushes to
`main`, and `CI Required` requires it. Documentation-only CI does not run it;
test-only CI runs it when its test changes.

The lane checks discovery and the signing key, attached sign-in with both client
authentication methods, signing-key rotation, refusal of an unattached user, and
local sign-out and user disablement behavior. See the
[Keycloak OIDC lane](../../testing/kubernetes.md#verified-keycloak-flows) for each test and
its evidence. Keycloak behind a TLS proxy, Keycloak in the same cluster as the API,
other major versions, and a production `start` deployment with a persistent external
database are not qualified by this fixture. Operator browser and recovery checks
remain necessary for the actual deployment.

## Related

- [Enable OIDC sign-in](oidc-sign-in.md)
- [External sign-in reference](../../reference/authentication/external-sign-in.md)
- [Keycloak OIDC lane](../../testing/kubernetes.md#keycloak-oidc-tests)
