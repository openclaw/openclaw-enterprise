# Backends (experimental)

> **Experimental / work in progress.** Backends are an unfinished Installation
> integration abstraction. The contracts and workflows below describe the current
> implemented subset; they are not a general model-provider catalog.

A Backend is Installation-owned configuration that gives related Drivers an
authenticated client. The bundled ChatGPT client manages upstream service
accounts. Its nullable Agent `backendId` association neither grants permissions
nor changes model or Harness selection. The GitHub Backend owns repository
credential configuration for the selected `RepoDriver` and uses the separate
Agent `repositoryBindings` selection.
Backends have no OCC resource or write API. Installation administrators can
discover nonsecret configured IDs and types through `GET /backends`.

[Configure the ChatGPT Backend](../guides/integrations/chatgpt.md) for the
operator workflow. The bundled Backend types are ChatGPT and GitHub.

A **model provider** identifies the service used by a model (for example, OpenAI).
The **Provider → Model** choice in Agent setup selects model configuration; a
Backend supplies clients to Installation Drivers. These are independent choices.
An Agent using an existing OpenAI API key does not need a Backend.

## Read configured Backends

`GET /backends` returns `{data:[{id,type}],meta:{requestId}}` after the selected
IAM Driver authorizes `administer` on the singleton Installation. Namespace
access alone does not grant discovery. The [console](console.md) route
`/console/backends` uses this Installation-wide inventory regardless of the
selected Namespace. Its sidebar tab is hidden while the concept is experimental;
the Create Agent model-provider selector does not query this inventory.

The API projects the validated definitions loaded at startup. It returns no
credentials, paths, workspace identifiers, Driver settings, or full configuration,
and makes no upstream request. A configured Backend is not a health or activation
claim. Authorized empty configuration returns `200` with `data:[]`; unavailable
discovery wiring or IAM is an error, never an empty inventory. Changes take effect
through the existing startup configuration lifecycle below.

## Installation configuration

Add this fragment to the required `occ` and ordinary Driver settings:

```yaml
backend:
  - id: openai
    type: chatgpt
    configuration:
      workspaceId: "11111111-1111-4111-8111-111111111111"
      apiKeyPath: /etc/openclaw/chatgpt/admin-key
      credentialTtlSeconds: 2592000
    drivers:
      service_account: chatgpt-service-accounts
drivers:
  service_account:
    id: chatgpt-service-accounts
    configuration: {}
```

The singular `backend` key is an array; omission or `[]` means none. IDs are
unique strings of 1–200 characters without leading/trailing whitespace or ASCII
control characters. `openai` is an operator-chosen ID. The bundled types are
`chatgpt` and `github`; each has its own closed configuration and required member
Driver. A ChatGPT workspace UUID identifies the upstream workspace, not a Namespace.

`apiKeyPath` must be an absolute mounted file path. The key needs
`chatgpt.enterprise.service_account.write` and authority for that workspace.
Inline keys and configurable upstream URLs are unsupported. Credential TTL
accepts 1–2,592,000 seconds and defaults to 2,592,000 (30 days); changing it does
not renew issued credentials. Retired `integrations` and `adminKeyPath` keys fail.

`backend[].drivers` declares required membership. The ChatGPT Backend and its
selected `service_account` Driver must be configured together with matching IDs.
OCC selects one Driver per capability, so only one ChatGPT Backend is supported.
Missing, conflicting, or unselected members reject configuration.

### GitHub repository credentials

The GitHub Backend selects one canonical nonsecret JSON registry:

```yaml
backend:
  - id: github-primary
    type: github
    configuration:
      registryPath: /etc/openclaw/repository-registry/registry.json
    drivers:
      repo: repository-credentials
drivers:
  repo:
    id: repository-credentials
    configuration:
      controlSocket: /run/openclaw/repository-control/private/control.sock
      sessionDurationSeconds: 86400
      publicCaPath: /etc/openclaw/repository-ca/ca.crt
```

Keep the ordinary required Driver settings alongside this fragment. One GitHub
Backend is supported and may coexist with one ChatGPT Backend. Its member ID
must match the selected `repo` Driver. The registry's Backend
ID must match the definition, and the session duration must fit the registry's
maximum. Unsupported Driver packages or configuration keys fail startup.

The API, worker, and credential service consume the same immutable, versioned
registry ConfigMap. Its exact Namespace, repository, and profile policies own
admission; no repository list is stored in Helm values. Follow the
[repository credential reference](repository-credentials.md) for registry fields
and the [operator guide](../guides/repository-credentials.md) for service setup.
The capability requires the bundled Kubernetes Compute Driver without a Sandbox
Driver; admitted Agents must use a supported
[runtime and authentication combination](repository-credentials.md).

## Driver and client contract

The [Backend contract](../../packages/contracts/src/index.ts) groups an ID,
concrete client, and declared member IDs. Composition constructs
`Backend<ChatGPTClient>` and injects it into `ChatGPTServiceAccountDriver`.
Membership is established there; the ordinary Driver registry retains its
`(capability, id)` identities and has no generic Backend ownership field.

Only the API reads the ChatGPT admin key and constructs its client and
ServiceAccount Driver. The worker receives nonsecret ChatGPT definitions for reconciliation.
Existing Driver lifecycle, controller/state injection, Compute credential
storage, installed factory signatures, and package trust rules remain unchanged.

For GitHub, API and worker construct `GitHubRepoDriver` from
`Backend<RepositoryCredentialControlClient>`, the validated registry, and the
selected duration. Construction reads the public CA but never connects the
private control socket. API resolution is local policy; the worker invokes
session operations. The Backend client validates full private control responses;
the Driver then returns the [four-field public status](repository-credentials.md#repo-driver-contract).
Only the separate service owns the App key, private TLS material, token
acquisition, and forwarding engine.

## Agent association and immutable deployment

[Agent create and PATCH](agents.md#backend-association) use these rules:

| Input                   | Create       | PATCH                        |
| ----------------------- | ------------ | ---------------------------- |
| Omitted                 | Save `null`. | Preserve current value.      |
| `null`                  | Save `null`. | Clear the draft reference.   |
| Known ChatGPT ID        | Save the ID. | Replace the draft reference. |
| Malformed or unknown ID | Reject.      | Reject.                      |

PATCH still requires `configurationId`. Malformed/empty IDs return
`400 INVALID_REQUEST`; unknown nonempty IDs return `404 NOT_FOUND`.
No Backend is inferred from model configuration or an account, and saving an
Agent makes no upstream call. Deployment copies `backendId` into an immutable
AgentRevision; later draft edits cannot change that snapshot. PostgreSQL stores
the snapshot in the immutable revision row's `backend_id` column.

A GitHub Backend ID is invalid in this field; the general `/backends` inventory
includes both types. Configure this association through the Agent API or a Preset.
The Create Agent model-provider selector does not configure it. Repository access
uses the separate admitted binding policy.

Secret-backed API-key harness bindings support Agents without a Backend. Managed `access_token` deployment requires dedicated Codex
execution and an exact same-Namespace binding matching the Backend, member
Driver, workspace, and recorded issuance. A mismatch returns
`409 RESOURCE_CONFLICT`; credential kind alone does not prove ownership.

The worker repeats ownership checks after IAM reauthorization and before
Compute effects. It reads only binding metadata, never external IDs or admin
credentials. Mismatches prevent candidate activation; database read failures
use normal retries. The account-owned token/workspace Secret is delivered only
to its compatible dedicated Codex workload.

## Startup identity and safe Backend changes

Startup validates configuration and required dependencies, without scanning
saved Agent references or managed bindings. A stale reference therefore does
not prevent the API from starting so an authorized operator can repair it.
Create/PATCH/deploy and reconciliation still require configured Backend IDs;
issuance, deletion, admission, and reconciliation reject mismatched bindings.

Removing or retargeting a Backend does not reassign its existing accounts or
revoke their credentials. Affected operations fail closed until the original
configuration is restored or their references are repaired. Retain the original
configuration for exact upstream cleanup. To replace a managed deployment,
detach its account, clear/change `backendId`, supply valid independent
credentials, deploy, and wait for predecessor retirement before deleting the
unused account. Failed cleanup retains state for retry. Key/TTL changes preserve
ownership and do not rewrite existing credentials.

Unsupported state predating Backend composition requires explicit cleanup and recreation of the
selected disposable state, as recorded in the
[implementation specification](../../specs/17-provider-driver-abstraction/contract.md#migration-and-implementation-boundaries).
Ownership is never inferred or backfilled. Draft edits and API shutdown do not
stop workloads; exact upstream cleanup still needs the original configuration.

## Production packaging and verification

Helm uses this packaging object separately from the Installation array:

```yaml
backend:
  chatgpt:
    enabled: true
    secretName: occ-chatgpt-admin
    key: admin-key
    providerCidr: "203.0.113.10/32" # Example only; replace with the approved destination.
```

Enable it with the Installation Backend. The dedicated Secret mounts only in
the API Pod at `/etc/openclaw/chatgpt/admin-key`; `apiKeyPath` must match.
`providerCidr` adds one IPv4 `/32` destination on TCP/443 to the API Pod's
NetworkPolicy. It configures no DNS, routing, or application proxy. The bundled
client sends HTTPS directly to `api.chatgpt.com`; the upstream URL is fixed,
and the chart configures no HTTP CONNECT or `HTTPS_PROXY` transport. Entering
an ordinary forward proxy's IP will not cause the client to use it.

Before enabling the Backend, have your network operator confirm that the
address the NetworkPolicy sees for `api.chatgpt.com:443` is the configured
destination. You can use a reviewed direct route where the hostname resolves
to that address, or transparent egress already provided by your cluster that
works with the client's direct HTTPS request and preserves the hostname and
certificate validation. The chart provisions neither. It supports only one
IPv4 address; if the direct hostname resolves to multiple or changing addresses,
do not rely on a single DNS lookup. Arrange suitable egress before enabling the
Backend. Disabled defaults keep `occ-chatgpt-admin`, `admin-key`, and an empty
CIDR. See the [deployment guide](../guides/deploy.md) and
[security boundary](security.md).

To verify the admin key and route, [issue a service-account credential](../guides/integrations/chatgpt.md#verify-backend-access).
`GET /backends` only reads Installation configuration and makes no upstream
request. Successful issuance does not prove that an Agent can reach its model.

The [lifecycle flow](../flows/service-account-driver-credential-delivery.md) names code and proof
boundaries. Local API, PostgreSQL, Driver, and packaging tests do not prove live
provider calls or model execution. See
[service-account testing](../testing/service-accounts.md) for real provider
verification requirements.

## Deferred behavior

Optional member Drivers, per-Agent Driver selection, automatic account creation,
clientless Backends, installed Backend loading/injection, Backend detail,
creation, and management UI, OAuth/refresh, renewal, and a common inference API
remain out of scope.

## Related

- [Agents](agents.md)
- [Service accounts](service-accounts.md)
- [Driver selection](drivers/selection.md)
- [Platform design](../design/drivers.md#drivers-and-backends)
