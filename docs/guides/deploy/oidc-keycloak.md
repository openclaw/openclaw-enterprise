# Use Keycloak for OIDC sign-in

Connect OpenClaw Enterprise (OCE) human sign-in to an organization-managed
Keycloak through the existing [OIDC integration](oidc-sign-in.md). Choose a
production Keycloak realm and create a dedicated confidential client for OCE.
Start with the checked-in [production profile input](../../../deploy/examples/production/keycloak-profile-input.json).
It admits explicitly attached pilot identities through OIDC and disables first-login
account creation. Keycloak group claims control OIDC admission; OCE IAM controls permissions.

## Prepare Keycloak and OCE

The organization deploys and operates Keycloak separately. OCE's chart configures
its OIDC client; it does not install production Keycloak. The Keycloak operator owns
production mode (`start`), a separate PostgreSQL database and database role, stable hostname and TLS,
restricted administrator access, updates, backups and restore, monitoring, and the
availability appropriate to the deployment. Follow Keycloak's
[production configuration](https://www.keycloak.org/server/configuration-production)
and [database guidance](https://www.keycloak.org/server/db). Verify database
TLS with the server CA. Encrypt the database storage, write-ahead logs, and
backups; do not share OCE's `occ` or `drizzle` schemas or credentials.
If applicable, follow the [reverse proxy guidance](https://www.keycloak.org/server/reverseproxy).
The CI and Local Setup fixture uses `start-dev` and a development file database;
it is not a production deployment.

Bootstrap Keycloak with a temporary administrative **service account**, using
`KC_BOOTSTRAP_ADMIN_CLIENT_ID` and `KC_BOOTSTRAP_ADMIN_CLIENT_SECRET` from
operator-managed Kubernetes `valueFrom.secretKeyRef` entries. Supply
`KC_DB_USERNAME` and `KC_DB_PASSWORD` from a separate database Secret.
Use the service account to create and verify a permanent, narrowly authorized
administration client. Revoke the temporary account, remove its bootstrap
variables from the workload, and verify the rollout before deleting the
temporary Secret. Keep the separate database Secret. Do not configure a human
bootstrap password. Follow Keycloak's
[service-account bootstrap procedure](https://www.keycloak.org/server/bootstrap-admin-recovery).

The real-provider CI fixture pins Keycloak **26.7.5** to
`quay.io/keycloak/keycloak:26.7.5@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85`
in [`image.json`](../../../tests/fixtures/keycloak/image.json). That is the only version
CI exercises; other versions, including other 26.x releases, are not verified.
Qualify your actual production configuration before use.

Prepare the [guarded OIDC profile](oidc-sign-in.md#requirements): one serving
controller, PostgreSQL State, native IAM, and one canonical HTTPS Console origin.
OIDC supports [native Agent access](native-admin.md). Rolling or mixed-version serving is unsupported.
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
  `https://sso.example.com/realms/acme`, must match `auth.oidc.issuer` and the
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

Use the permanent administrative service client with the
[Keycloak Admin REST API](https://www.keycloak.org/docs-api/latest/rest-api/):
`POST /admin/realms/{realm}/clients` creates the OCE client,
`POST /admin/realms/{realm}/groups` creates the pilot group, and
`POST /admin/realms/{realm}/clients/{client-uuid}/protocol-mappers/models`
creates its dedicated mapper. A service account cannot sign into the browser
Admin Console. The labels below describe the equivalent settings if a separately
provisioned, governed human administrator uses that console:

1. Under **Clients → Create client**, select `OpenID Connect` and choose a client
   ID, for example `oce-console`.
2. Turn on **Client authentication** and **Standard flow**. Turn off **Direct
   access grants**, **Implicit flow**, **Service accounts roles**, **Standard
   Token Exchange**, **OAuth 2.0 Device Authorization Grant** and **OIDC CIBA
   Grant**.
3. Set one **Valid redirect URI** to `OCC_AUTH_BASE_URL` followed by
   `/api/auth/providers/oidc/callback`, for example
   `https://console.oce.example.com/api/auth/providers/oidc/callback`. Leave **Web origins**
   empty.
4. Under **Logout settings**, turn off **Front channel logout** and **Backchannel
   logout session required**; OCE implements neither. Under **Advanced settings**,
   set **Proof Key for Code Exchange Code Challenge Method** to `S256`.
5. On **Credentials**, use **Client Id and Secret**. Save the ID and secret in
   protected files for the dedicated OCE Secret. The authenticator accepts
   `client_secret_post` and `client_secret_basic`.

For the pilot profile, add a Group Membership mapper to the OCE client's dedicated
scope, or to a scope assigned as Default only to that client.
Set the token claim name to `groups`, include it in the **ID token**, and turn
on **Full group path**. Create and govern the Keycloak group at `/oce-pilot`.
Verify that a pilot's signed ID token contains the exact value `/oce-pilot`
in its top-level `groups` array. A missing claim, different case, or a
same-named group under another parent, such as `/other/oce-pilot`, fails admission.
Do not add an audience mapper. See the [enrollment contract](../../reference/authentication/team-enrollment.md).

The checked-in realm and its fixed identities are **disposable CI/local fixtures**.
Do not import the fixture realm as a production provisioning shortcut: its test
users and placeholder credentials are not production identities or secrets. For
the test-only import and generated credentials, see the
[Keycloak OIDC lane](../../testing/kubernetes.md#keycloak-oidc-tests).

## Render the production profile

From the reviewed OCE checkout, run the public example through the primary
renderer and the production chart. The example uses synthetic domains, addresses,
image digests, and a recovery user ID; it cannot be installed as supplied.
First use the release-supported Node.js version and run `pnpm install --frozen-lockfile`
in the trusted checkout. See the [renderer prerequisites](installation-profiles.md#render-files).

```bash
set -euo pipefail
render_dir="$(mktemp -d)"
node scripts/render-installation-profile.ts --profile openclaw \
  --input deploy/examples/production/keycloak-profile-input.json \
  --out-dir "$render_dir"
jq -e '.ok and (.errors | length == 0)' "$render_dir/preflight.json"
helm template oce deploy/helm/openclaw-enterprise --namespace openclaw-system \
  --values "$render_dir/values.yaml" >/dev/null
```

Copy the JSON to a protected operator input file and replace every site value.
Copy the issuer and endpoints from Keycloak's discovery document; OCE does not
fetch it. The JSON stores Secret names and keys, never credentials. Keep the rendered
`values.yaml`, `installation.yaml`, and checksum together. Review the
preflight prerequisites, including the
actual ingress proxy CIDRs, database CA, storage class, DNS, and routing.

### Fresh installation

1. Create the operator's reviewed profile input. For the initial password-only
   bootstrap, make a separate input and render it:

   ```bash
   jq 'del(.controlPlane.oidc, .controlPlane.recoveryUserId,
           .controlPlane.passwordSignIn, .controlPlane.agentNativeAdminSessionMode)' \
     operator-keycloak.json > operator-bootstrap.json
   node scripts/render-installation-profile.ts --profile openclaw \
     --input operator-bootstrap.json --out-dir operator-bootstrap-render
   ```

   Follow the [production installation](production-installation.md) with those
   files. Retrieve the bootstrap service key for authenticated operator checks.

2. Verify the recovery administrator's password sign-in and read its actual
   `data.user.id` from `GET /api/auth/session`. Add that ID and the reviewed
   OIDC block to the operator input and rerender. After bootstrap creates the
   namespace, use the same verified kubeconfig and context to confirm the target
   and create the dedicated OIDC Secret from protected files:

   ```bash
   set -euo pipefail
   kubectl --kubeconfig "${KUBECONFIG_FILE:?}" --context "${CONTEXT:?}" \
     get namespace openclaw-system
   kubectl --kubeconfig "${KUBECONFIG_FILE:?}" --context "${CONTEXT:?}" \
     --namespace openclaw-system create secret generic occ-oidc-login \
     --from-file=client-id=/secure/occ/oidc-client-id \
     --from-file=client-secret=/secure/occ/oidc-client-secret
   ```

   Follow
   [external sign-in activation](production-installation.md#enable-external-browser-sign-in):
   close general ingress, stop every writer, run
   `activate --recovery-user <userId> --writers-stopped`, verify `status`,
   and upgrade the existing release with the reviewed rendered pair and
   initialization hooks enabled. Keep ingress restricted through steps 3 and 4.

3. For a new pilot, [add the person](../topics/iam.md#add-a-person) and grant
   the intended OCE access first. Keep existing pilots' original accounts and
   grants. As a human Installation administrator, read each pilot's current account,
   confirm its user ID and Principal, and [attach the exact Keycloak subject
   with the current account version](oidc-sign-in.md#attach-and-detach).
   Service keys cannot perform this account-only operation. Email never links
   accounts. A stale version, disabled account, or subject already assigned to
   another account returns `409`; resolve the conflict without replacing the account.
4. Through restricted ingress, verify the pilot returns to the same account
   and grants. Verify refusal for an unattached subject and for a linked user
   outside `/oce-pilot`, including a same-named subgroup, plus password recovery during an IdP outage. The
   profile sets `createAccount.enabled: false` and `groupIds: []`, so it
   creates no accounts and adds no OCE Group memberships. Reopen ingress after
   verification. Password sign-in still defaults to `all`, so the pilot rule
   limits OIDC, not ordinary password access. Consider the separate
   [recovery-only transition](../../reference/authentication/external-sign-in.md#recovery-only-password-sign-in)
   only after every ordinary account has verified its intended OIDC sign-in.

### Upgrade an existing installation

Start from the installed profile and values, not a copy of the example.
Preserve the existing password policy (`controlPlane.passwordSignIn`), issuer,
client ID, accounts, Principals, and grants. An omitted password policy defaults
to `all`; do not silently replace `recovery-only`. Apply intentional
authentication changes through stopped maintenance before an image-only upgrade.
A password-only installation uses the activation sequence above. For a direct
GitHub cutover, use the [OIDC upgrade guide](oidc-upgrade.md); qualify membership
freshness before removing the previous provider.

Before stopping writers, extract the reviewed chart's selected-image migration
program and inject the dedicated migrator connection as described in
[separate database upgrades](separate-database-upgrade.md#run-a-selected-image-migration).
Confirm that the migrator connection selects the installed database and set
`EXPECTED_HISTORY` to the expected candidate history for the
[recorded previous release](upgrade-baseline.md#record-the-database). Run the
candidate image check and compare its result. Set `DATABASE_CA_FILE` to the
approved public database CA file on the operator host. Keep the original file
protected; the image runs as `node` and cannot read its mode `0600` bind mount.
Stage a readable copy in a mode `0700` directory under the protected operator
directory. Keep `sslmode=verify-full` and set the connection URL's `sslrootcert`
to `/etc/openclaw/database-ca/ca.pem`:

```bash
set -euo pipefail
umask 077
MIGRATION_CA_DIR="$(mktemp -d "${OCC_INPUT_DIRECTORY:?}/migration-ca.XXXXXXXX")"
chmod 700 "$MIGRATION_CA_DIR"
install -m 0444 -- "${DATABASE_CA_FILE:?}" "$MIGRATION_CA_DIR/ca.pem"
docker run --rm --env NODE_ENV=production --env OCC_MIGRATION_DATABASE_URL \
  --mount "type=bind,src=${MIGRATION_CA_DIR:?}/ca.pem,dst=/etc/openclaw/database-ca/ca.pem,readonly" \
  "$CONTROLLER_IMAGE" -e "${MIGRATION_PROGRAM:?}" -- --check > migration-check.json
jq -e --arg expected "${EXPECTED_HISTORY:?}" \
  '.event == "migration.checked" and .history == $expected and .history != "empty"' \
  migration-check.json
```

Refuse an empty or unexpected history and any failed command. The check refuses unrecognized
schema history, catalog or grants, including unexpected ownership or CREATE
grants on `occ` or `drizzle`; PostgreSQL before 17 is refused. It does not
apply SQL. By default, the existing upgrade workflow owns shutdown and the Helm
hook applies migrations. For an explicitly separate database deployment, first
select `database.upgradeMigration: separate` in the reviewed candidate values
through the advanced chart path and retain the original upgrade evidence. The
helper pauses with exit 3 after both writers stop. Apply pending migrations with
the same selected image and program, then require completed history:

```bash
set -euo pipefail
umask 077
docker run --rm --env NODE_ENV=production --env OCC_MIGRATION_DATABASE_URL \
  --mount "type=bind,src=${MIGRATION_CA_DIR:?}/ca.pem,dst=/etc/openclaw/database-ca/ca.pem,readonly" \
  "$CONTROLLER_IMAGE" -e "${MIGRATION_PROGRAM:?}" --
docker run --rm --env NODE_ENV=production --env OCC_MIGRATION_DATABASE_URL \
  --mount "type=bind,src=${MIGRATION_CA_DIR:?}/ca.pem,dst=/etc/openclaw/database-ca/ca.pem,readonly" \
  "$CONTROLLER_IMAGE" -e "${MIGRATION_PROGRAM:?}" -- --require-current > migration-current.json
jq -e '.event == "migration.checked" and .history == "completed"' migration-current.json
```

After the last selected-image command, remove the staged public CA copy with
`rm -- "$MIGRATION_CA_DIR/ca.pem"` and `rmdir -- "$MIGRATION_CA_DIR"`.

Before service replacement, [resume the original upgrade](separate-database-upgrade.md#deploy-the-database).
On an uncertain outcome, keep writers stopped,
use [upgrade recovery](production-upgrade-recovery.md), and use
[UID-bound preflight cleanup](production-preflight-cleanup.md) for acknowledged
temporary resources. Never replay an uncertain create or migration.

### Advanced: manual chart values

Opt in to the existing [manual YAML path](production-installation-preparation.md#advanced-copy-manual-yaml-examples)
only when the profile cannot express a reviewed setting, such as a private IdP
CA. Follow the [OIDC chart guide](oidc-sign-in.md#configure-the-chart) and keep
the same admission, recovery, migration, and verification requirements.

## Optional GitHub broker

If Keycloak brokers GitHub, register its displayed broker redirect URI, for
example `https://sso.example.com/realms/acme/broker/github/endpoint`. For an
existing GitHub App, append that URI while preserving the original callback as
the first entry. GitHub Apps support up to ten callbacks; the broker must send
an explicit `redirect_uri` to select its callback. Without it, GitHub uses the
first callback. See [GitHub App callback URLs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url).
Qualify that the selected Keycloak broker works with the GitHub App and sends
the required URI before cutover; this interoperability is not verified by CI.
Alternatively, register a separate GitHub OAuth application for the broker;
do not assume an existing OAuth application's callback can be extended. Preserve
existing callbacks and credentials for their current consumers. The OCE client
still uses `https://console.oce.example.com/api/auth/providers/oidc/callback`.
Do not enable email-based automatic linking or Keycloak's
`Automatically Set Existing User` flow. A GitHub login alone does not prove
organization or team eligibility: govern the signed group claim and measure
removal freshness, including reused broker sessions, before cutover. See the
[membership qualification procedure](oidc-upgrade.md#qualify-membership-mapping-and-freshness).

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
