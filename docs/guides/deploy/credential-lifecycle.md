# Manage credential renewal and revocation

Replace or revoke OpenClaw Control Plane (OCC) service keys,
provider credentials, and runtime Secrets. First identify the credential's owner
and every application or Agent that uses it. After replacing a credential,
verify it through the affected application before revoking the old value, unless
the old value has been compromised.

For Credential Proxy setup, protected source withdrawal, and Gateway replacement,
use [Credential Proxy setup](../credential-proxy.md) and its
[upgrade procedure](credential-proxy-upgrade.md). Existing static Gateway owners
can remain. Do not apply a copied-key rotation procedure to live Secret resolution
or worker-prepared tokens: their owners and recovery requirements differ.

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
| GitHub repository token              | The worker issues, renews, and retires the token. The repository sender uses it for approved requests.                         | A finite grant ends at its original deadline even after [token renewal](../../reference/repository-credentials.md#token-service-lifecycle). Standing approval can authorize a new session for the same running Agent. To end access, follow the [withdrawal procedure](../credential-proxy.md#withdraw-repository-access).               |
| Backend-managed account credential   | The selected ServiceAccount Driver manages the upstream account, credential, and account-owned Secret.                         | Issuance is separate from creation. A second issuance conflicts; refresh and rotation are not implemented. See [service accounts](../../reference/service-accounts.md#account-and-credential-lifecycle).                                                                                                                                 |
| Native OCC ServiceAccount credential | The operator owns the referenced source Secret.                                                                                | The API can replace a native `api_key` reference; that reference cannot select model authentication. See [native API-key references](../../reference/service-accounts.md#native-api-key-references).                                                                                                                                     |
| Harness API key                      | The upstream provider issues the key; the selected Secret Driver stores it as an OCC Secret.                                   | Bind its exact same-Namespace reference through Agent `harnessAuth`. Update the source, explicitly deploy each consumer, verify model access, then revoke the old key upstream.                                                                                                                                                          |
| Generated transport credentials      | The selected Compute Driver generates per-Agent transport material before the first version.                                   | Supported Agent creation or the first deployment creates missing transport Secrets. Neither rotates existing values. Replacing transport credentials requires a separate stopped-runtime procedure when supported. See [runtime credentials](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials). |
| OCC Secret bindings                  | The Secret Driver stores harness and channel values; Agent `harnessAuth` and Configurations bind them to authorized consumers. | Value updates preserve the reference. They do not restart consumers or remove delivered values. Channel Secrets are projected only to selected gateways after explicit deployment. See [update and redeploy](../../reference/drivers/kubernetes-secret.md#update-and-redeploy).                                                          |
| Private gateway-routing service key  | The operator manages the Envoy credential and OCC's mounted client key.                                                        | Use the separate [routing key rotation](workspace-routing.md#rotate-the-service-key-and-certificates) procedure; OCC reads the file for each operation. This is not an OCC API key.                                                                                                                                                      |
| Auth signing and bootstrap material  | The operator protects the mounted auth Secret and precreated bootstrap password/key inputs.                                    | Auth-secret changes require API restart. Bootstrap does not rotate existing credentials, renew expiry, or recover lost inputs. See [production settings](../../reference/settings/production.md) and [bootstrap recovery](../../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap).                           |

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
3. Wait for OCC to select the new version, then perform a
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
Version history does not restore old source values.

Backend-managed account credentials require separate handling: OCC cannot
refresh, rotate, or manually replace an issued token. Monitor expiry and arrange
a separately issued replacement account before it expires. Bind that account
and explicitly deploy each intended consumer. Account deletion performs upstream
cleanup and is blocked by Agent drafts, selected versions, and pending deployments;
inactive history alone does not retain the source indefinitely.

## Use a personal Codex login

Codex OAuth login is **Experimental**. It requires dedicated Codex, the selected
TokenService, and native OpenShell Credential Proxy and Sandbox delivery. The
Harness receives a placeholder and account metadata; TokenService retains the
OAuth grant. See the [native Codex request policy](../../reference/credential-sources.md#codex-account-model-requests).

The initial Codex exchange runs in the OCE API Pods. If sign-in reports
`auth.openai.com` unreachable, check API Pod DNS, routing, and HTTPS connectivity
to that issuer, then retry. The refresh Worker also needs issuer connectivity.

1. Choose **ChatGPT OAuth (Experimental)** when creating an Agent. Open the
   verification link, enter the displayed code, and complete sign-in.
2. Search and select plugins using the resulting credential source, then create
   the Agent. Grant its service principal exact Source `operate` permission and
   allow the selected Codex binary and `chatgpt.com:443` within the Installation
   network ceiling before deployment. Deployment requires a successful native model probe.
3. For later plugin edits, use the saved Source. Authorized hosted Apps discovery
   resolves a usable access token through TokenService. Another device login is
   needed only when replacing or recovering the connection.
4. To replace the connection, sign in from the credential editor and save the new
   Source. Complete **Stop** before deploying the replacement; deploying managed
   credentials over an active revision returns `409`. Once no Agent, active
   revision, or pending deployment references the old Source,
   [delete it](../../reference/credential-sources.md#delete-a-source). A refused
   deletion leaves the Source and grant unchanged.

Starting requires Agent-create and credential-source-create in the Namespace.
For an existing Agent, exact Agent `read` and `update` replace Agent-create.
Only the person who started the login can poll or close it, while retaining
those Agent permissions. Completing a pending login rechecks
`credential_source:create`; replaying a ready session requires
`credential_source:operate` on the new Source. The temporary login needs no
separate grant. If polling returns `403`, give your platform operator the
request ID. They can find the exact permission and resource in the
[denial audit event](../topics/audit-log.md#access-and-limitations). After access
is restored, select **Retry login check** for a denied Agent check or ready
replay before the login expires. If Source creation was denied during completion,
select **Cancel login** and start a new login. Keep the provider's sign-in code
private.

For API clients, the start response includes a `session` handle with `id` and
`namespaceId`. Use the same device-authorizations route that started the login:
send `POST …/{id}/poll` to check it or `DELETE …/{id}` to cancel.

A pending login expires at the provider deadline. A completed login handle
expires after 24 hours. **Close login** closes the session; a completed Source
remains available. No Source is created before the issuer authorizes the grant.
Deleting a Source that an Agent or revision still references returns `409`; withdraw and
remove those references first.

New or reauthorized Codex account Sources cannot currently deploy with Repository
credentials on the same Agent; deployment returns `409`. Existing Gateway-bound
Repository Agents continue serving.

If sign-in is unavailable, check the selected TokenService device-login capability.
For `503 DEPENDENCY_UNAVAILABLE`, check API or Worker connectivity to the issuer
and selected Proxy connectivity to OpenShell. See the [Credential source lifecycle](../../flows/credential-source-lifecycle.md).

### Recover an interrupted Codex sign-in

If the Console says **Sign-in may have started**, do not start again. The Console
did not receive a usable login handle, so it cannot poll or cancel that
attempt. Give an administrator the time, Namespace, Agent ID if already saved,
and OCC request ID if available. Keep the device code private.

Using [approved audit access](../topics/audit-log.md#access-and-limitations), look
for a successful `openclaw.agents.device_authorization.start` for that actor and
request with `details.phase: "session_pending"`. OCC commits this event with the
login session before sending the reply. The event confirms that OCC saved the
session. It omits the session ID.

The `source_registering` and `source_ready` phases confirm only source registration;
they can exist even when provider login fails before OCC saves a session. A missing
`session_pending` event does not rule out a partial start. Do not guess the session
from a name or timestamp, or start again while the outcome is unknown.

If the Console says **Cancel this login and sign in again** while checking a known
session, choose **Cancel login**. Start a new sign-in only after cancellation
succeeds. Cancelling discards the session without revoking the Credential Source.
OCC does not repeat an exchange whose outcome is uncertain. A **Service unavailable**
message alone does not tell you whether OCC reached that exchange.

## Preserve administrator recovery

Replace the mounted auth signing Secret through the deployment owner and restart
the API processes that consume it. Verify fresh human sign-in and authenticated
API access. OCC derives the device-login encryption key from the auth secret.
After rotation, users must restart pending Codex logins. OCC also loses access
to the challenge for a completed login, so it cannot return that login's poll
response again. Existing credential sources and human passwords remain valid.

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
