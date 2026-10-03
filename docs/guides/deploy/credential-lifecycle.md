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
| Human password and session           | The administrator owns the account; Better Auth verifies sessions for OCC API clients.                                         | Sign-out revokes the current session. General account management and password-reset endpoints are not exposed. See [authentication](../../reference/authentication.md#session-lifecycle).                                                                                                                                                |
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
its non-secret ID and expiry. Switch the client to the replacement, then exercise
an operation the client normally performs. Verify that its permissions allow
that operation and reject one outside its grants.

Only after that check, [revoke the old key](../../reference/authentication/service-api-keys.md#revoke-or-rotate-a-service-key)
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

Codex OAuth login is **Experimental** and has limited, incomplete support.
The launch MVP covers the first deployment of a new Agent on Kubernetes with
Compute-owned dedicated Codex, no selected Sandbox or Credential Gateway, and
fresh private credential storage. The normal deployment prerequisites still
apply: configured runtime images, provisionable storage, provider connectivity,
and access to the selected model. Readiness requires a successful native model probe.

Choose **ChatGPT OAuth (Experimental)** with dedicated Codex when creating an Agent. Open the
provided verification link, enter the displayed code, and complete sign-in.
Device authorization must be enabled for the upstream account or workspace.
The API Pods start and complete the login at `auth.openai.com`, and the chart's
default network policy grants them no such egress: add its IPv4 `/32` addresses to
Helm `api.modelDiscoveryCidrs` (see
[model discovery](../../reference/console/create-and-deploy.md#create-an-agent)) or
allow it in your cluster's egress controls. Without it, **Sign in with OAuth**
fails with `503 DEPENDENCY_UNAVAILABLE` ("OCC could not reach the sign-in
service…"), at once when the connection is refused or after about 10 seconds when
the network drops it, and the API logs a `device_authorization.start_failed`
warning with the error code (for example `ECONNREFUSED` or `TimeoutError`).
OCE stores the resulting native bundle in its Secret backend; the browser receives
only a source reference. Use that login to search and select plugins, then create
and deploy the Agent. Starting login requires Agent-create and Secret-create
permission in the Namespace; polling and use also require exact Secret `operate`.
Only the user who started a login can poll, cancel, or use it through these
operations. The staged login is still an ordinary Secret: anyone with `operate`
on it can bind or project it like any other Secret until the first deployment
consumes it.

The first deployment copies the bundle to the Agent's private persistent disk,
confirms the copy, and erases OCE's credential copy before starting Codex. Codex
then owns refresh. Later revisions preserve the selected source and reuse the
current bundle on that disk. The Secret Driver refuses ordinary updates to a
source once handoff starts; delete it through the Secret API when no Agent uses
it. Its retained metadata identifies the owning Agent and storage.

For plugin changes on an existing Agent, connect again in the plugin editor.
This login is scoped to that Agent and requires Agent `read`/`update` plus Secret
permissions. It supplies discovery without changing the deployed source. Saving
plugin selections preserves the running Agent's credential. Cancelling a login
only discards OCE's local copy; OCE does not revoke the upstream session.

A pending login expires after the provider's device deadline, at most 15 minutes.
A completed login is available in OCE for 24 hours before handoff; OCE does not
refresh it. If discovery rejects an expired access token, start a fresh login.
The first poll, cancel, or discovery request after expiry erases the stored
credential bytes. A login nobody touches again keeps them, so discard abandoned
logins, then delete their unreferenced Secrets through the normal Secret API.
An interrupted token exchange requires a fresh login; a controller crash during
polling can leave the old login pending until expiry.

To rotate the login, or if private storage or its credential file is lost, use
the Agent credential editor to connect again, save the new source, and deploy.
The replacement empties the Agent's Codex home, including previous sessions and
history, before installing the new bundle after the previous workload stops. An
unchanged or consumed source can never reseed a bundle. Provider revocation also
requires reconnecting. Ordinary revision changes do not need another runtime
login. Deploying a revision with another authentication method removes the
Codex home; switching back needs a new login.

Durable token brokerage is separate work in progress. Automatic cleanup and
replacement recovery are follow-up work; they are not
first-deploy acceptance requirements. See the
[known runtime limitations](../../reference/drivers/kubernetes-compute/codex-oauth-storage.md#oauth-launch-limits)
and [verification gaps](../../reference/drivers/kubernetes-compute/codex-oauth-storage.md#device-login-verification).

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
