# Manage credential renewal and revocation

Identify the credential's owner and every consumer before changing it. OpenClaw
Control Plane (OCC) service keys, provider credentials, and runtime Secrets have
different replacement paths. This guide helps operators choose a supported path
and verify that the intended consumer uses the replacement.

## Before changing a credential

Record the responsible administrator, non-secret credential ID, expiry, affected
Namespaces and Agents, and protected storage location. Include shared accounts,
Configurations, and automation clients. Keep values out of tickets, logs, shell
history, and Configuration documents.

Verify independent administrator access before changing controller credentials.
Arrange a maintenance window when a replacement needs process restarts or the
upstream provider cannot overlap credentials. Record the required verification
and who can stop affected workloads if access must be revoked immediately.

## Choose the credential owner

| Credential                                      | Owner and consumer                                                                                                | Supported change and effect                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human password and session                      | The administrator owns the account; Better Auth verifies sessions for OCC API clients.                            | Sign-out revokes the current session. General account management and password-reset endpoints are not exposed. See [authentication](../../reference/authentication.md#session-lifecycle).                                                                                       |
| OCC service API key                             | An Installation administrator issues keys for a non-Agent IAM service principal; automation clients consume them. | Multiple keys may overlap. Revocation rejects subsequent requests; an already-authorized request may finish. See [service keys](../../reference/authentication/service-api-keys.md).                                                                                            |
| Provider-managed account credential             | The selected ServiceAccount Driver manages the upstream account, credential, and account-owned Secret.            | Issuance is separate from creation. A second issuance conflicts; refresh and rotation are not implemented. See [service accounts](../../reference/service-accounts.md#account-and-credential-lifecycle).                                                                        |
| Native account API-key source                   | The upstream provider and operator own the key and source Secret; the OCC account records its reference.          | The reference can be replaced. Existing revision snapshots retain their reference; the operator must materialize the source into each intended Agent's model Secret. See [native API-key references](../../reference/service-accounts.md#native-api-key-references).            |
| Per-Agent model, channel, and transport Secrets | The operator provisions exact-Agent Kubernetes Secrets; Compute projects them into their intended workloads.      | Initial console provisioning creates missing groups only; it cannot rotate existing values. Updating environment sources requires new consumer processes. See [runtime credentials](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials). |
| OCC Secret bindings                             | The Secret Driver stores the value; Configurations bind it to authorized consuming gateways.                      | Value updates preserve the reference. They do not restart consumers or remove delivered values. See [update and redeploy](../../reference/drivers/kubernetes-secret.md#update-and-redeploy).                                                                                    |
| Private gateway-routing service key             | The operator manages the Envoy credential and OCC's mounted client key.                                           | Use the separate [routing key rotation](workspace-routing.md#rotate-the-service-key-and-certificates) procedure; OCC reads the file for each operation. This is not an OCC API key.                                                                                             |
| Auth signing and bootstrap material             | The operator protects the mounted auth Secret and bootstrap password/key output.                                  | Auth-secret changes require API restart. Bootstrap does not regenerate existing credentials or recover missing output. See [production settings](../../reference/settings/production.md) and [bootstrap recovery](service-keys.md#recover-an-incomplete-bootstrap).             |

## Replace an OCC service API key

For routine renewal, follow [issue a service key](service-keys.md#issue-a-service-key)
using an authorized administrator. Store the one-time value privately and retain
its non-secret ID and expiry. Switch the client to the replacement, then exercise
its normal exact-scope operation. Expect success for an allowed operation and
denial outside its grants.

Only after that check, [revoke the old key](service-keys.md#revoke-or-rotate-a-service-key)
and verify that it returns `401`. Issuing or revoking a key does not change IAM
grants, revoke other keys for the principal, or cancel running Agent work. To end
a human operator session, use [sign-out](service-keys.md#sign-in-as-a-human-administrator)
and verify that a protected request with the old session fails.

## Replace runtime values and verify consumption

For native API keys and channel credentials, obtain the replacement through the
provider's supported process. Update the exact protected Kubernetes Secret through
the operator's Secret-management workflow. For an OCC Secret binding, use its
[supported value update](../../reference/drivers/kubernetes-secret.md#update-and-redeploy)
instead of editing its backing object directly.

Inventory all consumers before restarting or deploying them. An environment
variable already delivered to a process does not change when its source Secret
changes. Deploy each intended Agent again, confirm the expected active revision,
then perform a [real workload check](production-agents.md#verify-production-workloads).
For a channel credential, exercise the affected channel workflow; a successful
model turn does not prove channel authentication. For transport tokens, coordinate
both endpoints and clients, and verify a fresh allowed connection and rejection
of the old token. No automatic coordinated transport-token rotation is provided.

Where the provider permits overlap, revoke the old upstream credential after
successful replacement checks. A stored credential status proves storage only.
Do not use it as evidence of provider acceptance. Restarting an older revision
also reads the current Secret value; revision history does not restore old values.

Provider-managed account credentials require separate handling: OCC cannot
refresh, rotate, or manually replace an issued token. Monitor expiry and arrange
the supported account lifecycle before it expires. Account deletion performs
upstream cleanup and is blocked while an Agent's current association references
it; inspect deployed revision references too before deleting an account.

## Preserve administrator recovery

Replace the mounted auth signing Secret through the deployment owner and restart
the API processes that consume it. Verify fresh human sign-in and authenticated
API access; do not assume existing sessions survive. This change does not replace
human passwords or runtime provider credentials.

The initial bootstrap service key expires after 30 days. Preserve authorized
administrator access and renew automation credentials before expiry. Deleting a
local delivery copy does not revoke its credential. An already-bootstrapped
Installation will not reissue lost passwords or keys; follow [key recovery](service-keys.md#recover-a-lost-or-exposed-service-key)
and preserve uncertain bootstrap state for investigation.

For a compromised credential, prioritize containment over routine overlap: stop
the affected workloads and revoke at the credential's authority. Updating or
deleting a Secret alone cannot remove values from running processes. Verify
rejection, provision replacements through the appropriate path above, and resume
only the intended consumers. OCC does not provide an Agent deletion or general
stop endpoint; workload intervention belongs to the infrastructure operator.
