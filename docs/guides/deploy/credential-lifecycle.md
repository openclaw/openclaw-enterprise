# Manage credential renewal and revocation

Replace or revoke OpenClaw Control Plane (OCC) service keys,
provider credentials, and runtime Secrets. First identify the credential's owner
and every application or Agent that uses it. After replacing a credential,
verify it through the affected application before revoking the old value, unless
the old value has been compromised.

## Before changing a credential

Record the responsible administrator, non-secret credential ID, expiry, affected
Namespaces and Agents, and where the value is stored. Include shared accounts,
Configurations, and automation clients. Keep credential values out of tickets,
logs, shell history, and Configuration documents.

Verify that you have another working administrator credential before changing
controller credentials.
Arrange a maintenance window when a replacement needs process restarts or the
upstream provider cannot overlap credentials. Record the required verification
and who can stop affected workloads if access must be revoked immediately.

## Choose the credential owner

| Credential                           | Owner and consumer                                                                                                             | Supported change and effect                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human password and session           | The administrator owns the account; Better Auth verifies sessions for OCC API clients.                                         | Sign-out revokes the current session. Admins create accounts; no endpoint resets passwords. External sign-in adds online disable and revocation; password-only ends others' sessions only by [stopped maintenance](auth-maintenance.md#choose-the-operation). See [authentication](../../reference/authentication.md#session-lifecycle). |
| OCC service API key                  | An Installation administrator issues keys for a non-Agent IAM service principal; automation clients consume them.              | Multiple keys may overlap. Revocation rejects subsequent requests; an already-authorized request may finish. See [service keys](../../reference/authentication/service-api-keys.md).                                                                                                                                                     |
| Backend-managed account credential   | The selected ServiceAccount Driver manages the upstream account, credential, and account-owned Secret.                         | Issuance is separate from creation. A second issuance conflicts; refresh and rotation are not implemented. See [service accounts](../../reference/service-accounts.md#account-and-credential-lifecycle).                                                                                                                                 |
| Native OCC ServiceAccount credential | The operator owns the referenced source Secret.                                                                                | The API can replace a native `api_key` reference; that reference cannot select model authentication. See [native API-key references](../../reference/service-accounts.md#native-api-key-references).                                                                                                                                     |
| Harness API key                      | The upstream provider issues the key; the selected Secret Driver stores it as an OCC Secret.                                   | Bind its exact same-Namespace reference through Agent `harnessAuth`. Update the source, explicitly deploy each consumer, verify model access, then revoke the old key upstream.                                                                                                                                                          |
| Generated transport credentials      | The selected Compute Driver generates per-Agent transport material before the first revision.                                  | Supported Agent creation or the first deployment creates missing transport Secrets. Neither rotates existing values. Replacing transport credentials requires a separate stopped-runtime procedure when supported. See [runtime credentials](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials). |
| OCC Secret bindings                  | The Secret Driver stores harness and channel values; Agent `harnessAuth` and Configurations bind them to authorized consumers. | Value updates preserve the reference. They do not restart consumers or remove delivered values. Channel Secrets are projected only to selected gateways after explicit deployment. See [update and redeploy](../../reference/drivers/kubernetes-secret.md#update-and-redeploy).                                                          |
| Private gateway-routing service key  | The operator manages the Envoy credential and OCC's mounted client key.                                                        | Use the separate [routing key rotation](workspace-routing.md#rotate-the-service-key-and-certificates) procedure; OCC reads the file for each operation. This is not an OCC API key.                                                                                                                                                      |
| Auth signing and bootstrap material  | The operator protects the mounted auth Secret and bootstrap password/key output.                                               | Auth-secret changes require API restart. Bootstrap does not regenerate existing credentials or recover missing output. See [production settings](../../reference/settings/production.md) and [bootstrap recovery](../../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap).                                   |

## Replace an OCC service API key

For routine renewal, follow [issue a service key](../../reference/authentication/service-api-keys.md#issue-a-service-key)
using an authorized administrator. Store the one-time value privately and retain
its non-secret ID and expiry. Switch the client to the replacement, then confirm
that an operation the client normally performs succeeds. For a principal with
narrower grants than the Installation service administrator, also check that an
operation outside them returns `403`.

Only after these checks, [revoke the old key](../../reference/authentication/service-api-keys.md#revoke-or-rotate-a-service-key)
and verify that it returns `401`. Issuing or revoking a key does not change IAM
grants, revoke other keys for the principal, or cancel running Agent work. To end
a human operator session, use [sign-out](../../reference/authentication/service-api-keys.md#sign-in-as-a-human-administrator)
and verify that a protected request with the old session fails.

## Replace runtime values and verify consumption

Obtain replacement API keys and channel credentials through the provider's
supported process. For a harness API key or Configuration channel Secret, use its
[supported value update](../../reference/drivers/kubernetes-secret.md#update-and-redeploy)
instead of editing its backing object directly. Generated transport credentials
are separate from channel Secrets; the current initial provisioning flow does not
rotate an existing generated bundle.

List all affected applications or Agents before restarting or deploying them.
`occ secret get "$SECRET_ID" -o json` lists a Secret's consuming Agents in
`consumers.agents`; a nonzero `consumers.unreadable` means some references are
hidden from you (see [Find a Secret's consumers](../../reference/drivers/kubernetes-secret.md#find-a-secrets-consumers)).
A running process keeps the environment variables it received, even after the
source Secret changes. For a model API key, the supported sequence is:

1. Update the existing OCC Secret through its API, retaining the Secret reference.
2. Run `occ agent deploy "$AGENT_ID"` for each consuming Agent, even when its
   Configuration and `harnessAuth` reference are unchanged.
3. Wait for the new revision to become active, then perform a
   [real model request](../operate/model-verification.md).

With Kubernetes Compute, OCE preparation refreshes the Harness's DP credential
projection from the CP source. Recreating its Pod or running `kubectl rollout restart` reads the existing
projection and is not a substitute for this OCE deployment.

For a channel credential, explicitly deploy each consumer and exercise the
affected channel workflow; a successful model turn does not prove channel authentication. For transport tokens, coordinate
both endpoints and clients, and verify a fresh allowed connection and rejection
of the old token. No automatic coordinated transport-token rotation is provided.

Where the provider permits overlap, revoke the old upstream credential after
successful replacement checks. A stored credential status does not show that
the provider accepts the value. Dedicated Gateway restarts read current canonical
channel values; Harness restarts read their existing runtime projection.
Revision history does not restore old source values.

Backend-managed account credentials require separate handling: OCC cannot
refresh, rotate, or manually replace an issued token. Monitor expiry and arrange
a separately issued replacement account before it expires. Bind that account
and explicitly deploy each intended consumer. Account deletion performs upstream
cleanup and is blocked by Agent drafts, active revisions, and pending deployments;
inactive history alone does not retain the source indefinitely.

## Use a personal Codex login

Codex OAuth login is **Experimental**. It requires dedicated Codex and a selected
Credential Gateway with device login, warm access-token lookup and external-token
attachments, plus its paired Sandbox's token injection. The OpenShell PoC requires
the [custom gateway and supervisor](../../reference/drivers/openshell-credential-gateway.md#experimental-codex-oauth-poc);
the stock pinned images do not support this flow. There is no installation opt-in flag.

1. Choose **ChatGPT OAuth (Experimental)** when creating an Agent. Open the
   verification link, enter the displayed code, and complete sign-in.
2. Search and select plugins using the resulting credential source, then create
   and deploy the Agent. The Console grants the Agent service principal exact
   source `operate` permission. Deployment still requires a successful native
   model probe.
3. For later plugin edits, use the saved source. OCE asks the Credential Gateway
   for a warm access token; the token service owns refresh. Another device login
   is needed only when replacing or recovering the connection.
4. To replace the connection, sign in from the credential editor, save the new
   source, and deploy. Saving a draft does not change the running revision.

Starting requires Agent-create, Secret-create and credential-source-create in the
Namespace, plus `operate` on the resulting session Secret and source. For an
existing Agent, exact Agent `read`/`update` replaces Agent-create. Only the actor
who started a session can poll or close it. Source use has its own exact
`credential_source:operate` authorization; it is not tied to the login session.

The session Secret stores only an opaque login handle and source identity.
Access and refresh tokens stay with the external service. A pending session uses
the provider deadline; a completed session closes after 24 hours on its next
access. **Close login** discards the handle without revoking the source or
interrupting a deployed Agent. Failed and abandoned sources remain visible in
credential-source management; delete unused sources separately and remove their
unreferenced session Secrets. An uncertain exchange requires a new login.

If sign-in is unavailable, check the selected Gateway's capabilities. For a
`503 DEPENDENCY_UNAVAILABLE`, check connectivity from OCC to that Gateway and its
upstream provider. OCC does not exchange the device code directly with the
provider. See [storage and limits](../../reference/drivers/kubernetes-compute/codex-oauth-storage.md).

## Preserve administrator recovery

Replace the mounted auth signing Secret through the deployment owner and restart
the API processes that consume it. Verify fresh human sign-in and authenticated
API access; do not assume existing sessions survive. This change does not replace
human passwords or runtime provider credentials.

The initial bootstrap service key expires after 30 days. Preserve authorized
administrator access and renew automation credentials before expiry. Deleting a
local delivery copy does not revoke its credential. An already-bootstrapped
Installation will not reissue lost passwords or keys; follow [key recovery](../../reference/authentication/service-api-keys.md#recover-a-lost-or-exposed-service-key)
and preserve uncertain bootstrap state for investigation.

For a compromised credential, prioritize containment over routine overlap: stop
the affected workloads and revoke at the credential's authority. Updating or
deleting a Secret alone cannot remove values from running processes. Verify
rejection, provision replacements through the appropriate path above, and resume
only the intended applications or Agents. To stop an Agent, use its exact stop
endpoint. To permanently remove it, [delete the Agent](../../reference/agents.md#deletion);
teardown is asynchronous. IAM revocation prevents OCC from accepting or starting
later operations, but it cannot retract credentials already delivered to a process.
