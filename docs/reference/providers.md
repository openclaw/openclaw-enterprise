# Providers

A Provider is Installation-owned configuration that gives related Drivers an
authenticated client. Agents may reference it through nullable `providerId`;
this neither grants permissions nor changes model or Harness selection.
The bundled ChatGPT client manages upstream service accounts, not inference.
Providers have no OCC resource or write API. Installation administrators can
discover nonsecret configured IDs and types through `GET /providers`.

## Read configured Providers

`GET /providers` returns `{data:[{id,type}],meta:{requestId}}` after the selected
IAM Driver authorizes `administer` on the singleton Installation. Namespace
access alone does not grant discovery. The [console](console.md) uses this
Installation-wide inventory regardless of the selected Namespace.

The API projects the validated definitions loaded at startup. It returns no
credentials, paths, workspace identifiers, Driver settings, or full configuration,
and makes no upstream request. A configured Provider is not a health or activation
claim. Authorized empty configuration returns `200` with `data:[]`; unavailable
discovery wiring or IAM is an error, never an empty inventory. Changes take effect
through the existing startup configuration lifecycle below.

## Installation configuration

Add this fragment to the required `occ` and ordinary Driver settings:

```yaml
provider:
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

The singular `provider` key is an array; omission or `[]` means none. IDs are
unique strings of 1–200 characters without leading/trailing whitespace or ASCII
control characters. `openai` is an operator-chosen ID; `chatgpt` is the only
bundled type. Its workspace UUID identifies the upstream workspace, not a Namespace.

`apiKeyPath` must be an absolute mounted file path. The key needs
`chatgpt.enterprise.service_account.write` and authority for that workspace.
Inline keys and configurable upstream URLs are unsupported. Credential TTL
accepts 1–2,592,000 seconds and defaults to 2,592,000 (30 days); changing it does
not renew issued credentials. Retired `integrations` and `adminKeyPath` keys fail.

`provider[].drivers` declares required membership. The ChatGPT Provider and its
selected `service_account` Driver must be configured together with matching IDs.
OCC selects one Driver per capability, so only one ChatGPT Provider is supported.
Missing, conflicting, or unselected members reject configuration.

## Driver and client contract

The [Provider contract](../../packages/contracts/src/index.ts) groups an ID,
concrete client, and declared member IDs. Composition constructs
`Provider<ChatGPTClient>` and injects it into `ChatGPTServiceAccountDriver`.
Membership is established there; the ordinary Driver registry retains its
`(capability, id)` identities and has no generic Provider ownership field.

Only the API reads the admin key and constructs the client and ServiceAccount
Driver. The worker receives nonsecret Provider definitions for reconciliation.
Existing Driver lifecycle, controller/state injection, Compute credential
storage, installed factory signatures, and package trust rules remain unchanged.

## Agent association and immutable deployment

[Agent create and PATCH](agents.md#provider-association) use these rules:

| Input                   | Create       | PATCH                        |
| ----------------------- | ------------ | ---------------------------- |
| Omitted                 | Save `null`. | Preserve current value.      |
| `null`                  | Save `null`. | Clear the draft reference.   |
| Known ID                | Save the ID. | Replace the draft reference. |
| Malformed or unknown ID | Reject.      | Reject.                      |

PATCH still requires `configurationId`. Malformed/empty IDs return
`400 INVALID_REQUEST`; unknown nonempty IDs return `404 NOT_FOUND`.
No Provider is inferred from model configuration or an account, and saving an
Agent makes no upstream call. Deployment copies `providerId` into an immutable
AgentRevision; later draft edits cannot change that snapshot. PostgreSQL stores
the snapshot in the immutable revision row's `provider_id` column.

Native API-key accounts and independently supplied model credentials support
providerless Agents. Managed `access_token` deployment requires dedicated Codex
execution and an exact same-Namespace binding matching the Provider, member
Driver, workspace, and recorded issuance. A mismatch returns
`409 RESOURCE_CONFLICT`; credential kind alone does not prove ownership.

The worker repeats ownership checks after IAM reauthorization and before
Compute effects. It reads only binding metadata, never external IDs or admin
credentials. Mismatches prevent candidate activation; database read failures
use normal retries. The account-owned token/workspace Secret is delivered only
to its compatible dedicated Codex workload.

## Startup identity and safe Provider changes

Startup validates configuration and required dependencies, without scanning
saved Agent references or managed bindings. A stale reference therefore does
not prevent the API from starting so an authorized operator can repair it.
Create/PATCH/deploy and reconciliation still require configured Provider IDs;
issuance, deletion, admission, and reconciliation reject mismatched bindings.

Removing or retargeting a Provider does not reassign its existing accounts or
revoke their credentials. Affected operations fail closed until the original
configuration is restored or their references are repaired. Retain the original
configuration for exact upstream cleanup. To replace a managed deployment,
detach its account, clear/change `providerId`, supply valid independent
credentials, deploy, and wait for predecessor retirement before deleting the
unused account. Failed cleanup retains state for retry. Key/TTL changes preserve
ownership and do not rewrite existing credentials.

Unsupported pre-Provider state requires explicit cleanup and recreation of the
selected disposable state, as recorded in the
[implementation specification](../../specs/17-provider-driver-abstraction/contract.md#migration-and-implementation-boundaries).
Ownership is never inferred or backfilled. Draft edits and API shutdown do not
stop workloads; exact upstream cleanup still needs the original configuration.

## Production packaging and verification

Helm uses this packaging object separately from the Installation array:

```yaml
provider:
  chatgpt:
    enabled: true
    secretName: occ-chatgpt-admin
    key: admin-key
    providerCidr: "203.0.113.10/32" # Replace with the approved provider/proxy IP.
```

Enable it with the Installation Provider. The dedicated Secret mounts only in
the API Pod at `/etc/openclaw/chatgpt/admin-key`; `apiKeyPath` must match. Only
the API receives provider TCP/443 egress to the approved `/32`. Disabled defaults
keep `occ-chatgpt-admin`, `admin-key`, and an empty CIDR. See the
[deployment guide](../guides/deploy.md) and [security boundary](security.md).

The [lifecycle flow](../flows/service-account-driver-credential-delivery.md) names code and proof
boundaries. Local API, PostgreSQL, Driver, and packaging tests do not prove live
provider calls or model execution. See
[service-account testing](../testing/service-accounts.md) for real provider
verification requirements.

## Deferred behavior

Optional member Drivers, per-Agent Driver selection, automatic account creation,
clientless Providers, installed Provider loading/injection, Provider detail,
creation, and management UI, OAuth/refresh, renewal, and a common inference API
remain out of scope.

## Related

- [Agents](agents.md)
- [Service accounts](service-accounts.md)
- [Driver selection](drivers/selection.md)
- [Platform design](../design/drivers.md#drivers-and-providers)
