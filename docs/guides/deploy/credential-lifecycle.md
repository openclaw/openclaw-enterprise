# Manage credential renewal and revocation

Replace or revoke OpenClaw Control Plane (OCC) service keys,
provider credentials, and runtime Secrets. First identify the credential's owner
and every application or Agent that uses it. After replacing a credential,
verify it through the affected application before revoking the old value, unless
the old value has been compromised.

For managed Sources, see [Credential Proxy setup](../credential-proxy.md).
For a release still using Credential Gateway or Credential Refresh, follow its
[pre-cutover lifecycle procedures](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/guides/deploy/credential-lifecycle.md).

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
| Prepared Git session                 | The worker issues, renews, and retires the token. The repository sender uses it for approved requests.                         | Renewal preserves the finite session deadline. Standing approval can authorize a new session for the running Agent. See [prepared Git sessions](../../reference/repository-credentials.md#token-service-lifecycle).                                                                                                                      |
| ChatGPT ServiceAccount PAT           | In the cutover candidate, the ServiceAccount Driver issues and revokes the PAT, and TokenService stores it in a Source.        | [Issue and bind a replacement account](#replace-a-backend-managed-account-credential) before the old PAT expires.                                                                                                                                                                                                                        |
| Native OCC ServiceAccount credential | The operator owns the referenced source Secret.                                                                                | The API can replace a native `api_key` reference; that reference cannot select model authentication. See [native API-key references](../../reference/service-accounts.md#native-api-key-references).                                                                                                                                     |
| Secret-backed Harness API key        | The upstream provider issues the key; the selected Secret Driver stores it as an OCC Secret.                                   | Bind its exact same-Namespace reference through Agent `harnessAuth`. Update the source, explicitly deploy each consumer, verify model access, then revoke the old key upstream.                                                                                                                                                          |
| OCC TokenService-managed model key   | OCC TokenService holds the credential for a managed Source; Credential Proxy manages its delivery copy.                        | Update the Source, retry a failed delivery, and verify a model request. See [managed model key replacement](#replace-an-occ-tokenservice-managed-model-key).                                                                                                                                                                             |
| Generated transport credentials      | The selected Compute Driver generates per-Agent transport material before the first version.                                   | Supported Agent creation or the first deployment creates missing transport Secrets. Neither rotates existing values. Replacing transport credentials requires a separate stopped-runtime procedure when supported. See [runtime credentials](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials). |
| OCC Secret bindings                  | The Secret Driver stores harness and channel values; Agent `harnessAuth` and Configurations bind them to authorized consumers. | Value updates preserve the reference. They do not restart consumers or remove delivered values. Channel Secrets are projected only to selected gateways after explicit deployment. See [update and redeploy](../../reference/drivers/kubernetes-secret.md#update-and-redeploy).                                                          |
| Private gateway-routing service key  | The operator manages the Envoy credential and OCC's mounted client key.                                                        | Use the separate [routing key rotation](workspace-routing.md#rotate-the-service-key-and-certificates) procedure; OCC reads the file for each operation. This is not an OCC API key.                                                                                                                                                      |
| Auth signing and bootstrap material  | The operator protects the mounted auth Secret and precreated bootstrap password/key inputs.                                    | Auth-secret changes require API restart. Bootstrap does not rotate existing credentials, renew expiry, or recover lost inputs. See [production settings](../../reference/settings/production.md) and [bootstrap recovery](../../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap).                           |

For Source-backed Git in the cutover candidate, see
[GitHub App access for an OpenShell Agent](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/guides/repository-credentials.md#set-github-app-access-for-an-openshell-agent).
TokenService renews the GitHub token independently of the Agent's saved
Repository grant.

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
supported process. A stored status does not prove that the provider accepts
the replacement.

### Replace an OCC TokenService-managed model key

This development integration requires OCC TokenService and a compatible Credential
Proxy delivery Driver. Check the [managed Source prerequisites](../../reference/credential-sources/managed-static.md#deploy-an-agent-with-the-source).

1. Send `PATCH /namespaces/:namespaceId/credential-sources/:credentialSourceId`
   with `credential_source:update`. In the cutover candidate, pass
   `{"secret":"<replacement>"}` as a write-only value. On main before cutover,
   use its [managed Source request format](../../reference/credential-sources/managed-static.md#update-a-source).
   Omit `config` to preserve the provider preset. TokenService commits the new
   credential and notifies the selected Credential Proxy.
2. If delivery fails after the commit, the replacement stays in custody.
   [Retry credential delivery](../../reference/credential-sources.md#retry-credential-delivery)
   from an active Agent that still uses the Source. Confirm the Source result is
   `succeeded`.
3. Send a new model request through each affected running Agent and verify the
   response. If the provider permits overlap, revoke the old key and verify
   another response. Updating the Source creates no Agent revision. The
   [cutover verification](https://github.com/openclaw/openclaw-enterprise/pull/7224)
   covers same-revision Codex OAuth and Git token rotation. Managed API-key
   replacement in a running Harness still needs live qualification.

For native OpenShell custody, see the [development preview on main](../../reference/credential-sources.md#implementation-status) and check what a [credential push confirms](../../reference/credential-sources.md#retry-credential-delivery).

### Replace a Secret-backed model key

List all affected applications or Agents before restarting or deploying them.
`occ secret get "$SECRET_ID" -o json` lists a Secret's consuming Agents in
`consumers.agents`; a nonzero `consumers.unreadable` means some references are
hidden from you (see [Find a Secret's consumers](../../reference/drivers/kubernetes-secret.md#find-a-secrets-consumers)).
A running process keeps the environment variables it received, even after the
source Secret changes.

1. [Update the existing OCC Secret](../../reference/drivers/kubernetes-secret.md#update-and-redeploy), retaining its reference.
2. Run `occ agent deploy "$AGENT_ID"` for each consuming Agent, even when its
   Configuration and `harnessAuth` reference are unchanged.
3. Wait for OCC to select the new version, then perform a
   [real model request](../operate/model-verification.md). If the provider permits
   overlap, revoke the old key after verification.

With Kubernetes Compute, OCE preparation refreshes the Harness's DP credential
projection from the CP source. Recreating its Pod or running `kubectl rollout restart` reads the existing
projection and is not a substitute for this OCE deployment. Version history does
not restore old source values.

### Replace channel or transport credentials

For a channel credential, [update its Configuration Secret](../../reference/drivers/kubernetes-secret.md#update-and-redeploy),
explicitly deploy each consumer, and exercise the affected channel workflow. A
successful model turn does not prove channel authentication. If the provider permits
overlap, revoke the old credential after verification. Dedicated Gateway restarts
read current canonical channel values. Initial provisioning creates a separate
transport credential bundle and leaves an existing bundle in place. For transport
tokens, coordinate both endpoints and clients, and verify a fresh allowed
connection and rejection of the old token. No automatic coordinated
transport-token rotation is provided.

### Replace a Backend-managed account credential

For a ChatGPT ServiceAccount PAT in the cutover candidate, issue a replacement
account before the old token expires. Select its TokenService Source and deploy
each intended consumer. Normal ServiceAccount deletion revokes the upstream
token. If the Backend has been removed, forced deletion can skip that
revocation. After removing the Agent references, retire the old Source
separately. See [issued PAT handling](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/guides/deploy/credential-lifecycle.md#issued-chatgpt-serviceaccount-pats).

## Use a personal Codex login

In the cutover candidate, Codex OAuth login is experimental. Use dedicated Codex with OCC TokenService
and the paired OpenShell Sandbox and native Credential Proxy.
[Candidate Driver selections](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/drivers/selection.md#supported-selections)

1. In **Create Agent**, choose **ChatGPT OAuth (Experimental)**, then open the
   verification link and complete sign-in using the displayed code.
2. Use the ready Source with the [Agent API deployment path](deploy-first-agent.md#1-select-or-register-the-model-credential).
   Guided creation cannot deploy a managed Source. The Installation must allow
   the Codex executable to reach `chatgpt.com:443`. Verify a successful model
   response after deployment.
3. For later Plugin edits, select the saved Source. For reauthorization, sign
   in again, select the replacement Source, stop the running Agent, and deploy
   the new draft. Delete the old Source after removing its Agent references.

Starting a login requires Agent-create and Source-create permissions in the
Namespace. For an existing Agent, exact Agent `read` and `update` replace
Agent-create. The person who started the login can poll or close it while
retaining those Agent permissions. Completing a pending login rechecks
`credential_source:create`. Replaying a ready session requires
`credential_source:operate` on the resulting Source.

For API clients, the start response contains the session ID and Namespace ID.
Use the same device-authorizations route to send `POST …/{id}/poll` or
`DELETE …/{id}`. A pending login expires at the provider deadline. Cancel it
to close it sooner. A completed login handle expires after 24 hours. Clearing
the selection closes its handle and keeps the Source.

For a `403`, give your platform operator the request ID to find the denied
permission in the [audit event](../topics/audit-log.md#access-and-limitations).
Once the operator restores access, retry the Agent check or ready replay
before the login expires. If Source creation was denied during completion,
cancel the login and start a new one. Keep the provider's sign-in code private.

If sign-in reports that `auth.openai.com` is unreachable, check DNS, routing,
and HTTPS connectivity from the API Pods. OCC TokenService uses the issuer
for enrollment and renewal. If deployment reports dependency failure, also
check the selected Proxy's connection to OpenShell.
[Candidate device-login procedure](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/guides/deploy/credential-lifecycle.md#use-a-personal-codex-login)

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
