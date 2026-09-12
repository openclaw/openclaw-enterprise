# Feature Spec: ChatGPT Service Account Driver: contract

[Spec overview](../11-service-account-driver.md). Original record; decisions and status are preserved.

## Contract

### Provider clients and Driver ownership

A Driver implements one OCC-selected capability and receives an authorized, scoped operation.
`ChatGPTClient` is one concrete, reusable provider dependency injected into Drivers; it owns HTTP
transport and provider authentication, not OCC resources or a selected Driver capability. Its initial
operations create/delete provider accounts and issue/revoke provider credentials. Future
permission/plugin Drivers may reuse the client with independently required authentication and scopes;
additional client facets are deferred. `IAMDriver` remains authorization-only.

Installation startup configuration optionally selects `drivers.service_account` and defines a `chatgpt`
integration with its fixed `workspaceId`, mounted admin-key file path, and bounded credential TTL. Default
the TTL to the existing provider client's 30 days; allow a smaller explicit Installation setting when the
workspace enforces a stricter maximum. Hardcode the trusted `https://api.chatgpt.com/v1` endpoint.
Existing native-only Installations need no provider integration.

Both existing processes use the shared Installation configuration loader. Instantiate `ChatGPTClient` and
`ChatGPTServiceAccountDriver` only from the existing API entrypoint after shared configuration loads;
read the admin key from a dedicated Secret mounted only into that API Pod. The worker keeps its existing
entrypoint and never constructs the client, initializes the service-account Driver, or reads the admin
key. No `role` parameter or alternate Installation initialization path is required. Keep admin
credentials out of startup YAML, PostgreSQL, resources, HTTP responses, logs, Agent workloads, and
worker Pods.

The workspace ID identifies the configured provider backend, not an OCC Namespace. OCC Namespaces retain
their independent existing scope; multiple Namespaces may create separately owned account links against
the same configured workspace. The provider checks the admin key's organization, workspace authority,
and `chatgpt.enterprise.service_account.write` scope independently of OCC authorization.

```ts
interface ServiceAccountCredential {
  readonly kind: "api_key" | "access_token" | "oauth_access_token";
  readonly secretRef: SecretRef;
}

interface ServiceAccount {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly credential?: ServiceAccountCredential;
}

interface ServiceAccountDriver extends Driver {
  readonly capability: "service_account";
  create(account: ServiceAccount): Promise<void>;
  createCredential(account: ServiceAccount): Promise<ServiceAccountCredential>;
  delete(account: ServiceAccount): Promise<void>;
}

class ChatGPTServiceAccountDriver implements ServiceAccountDriver {
  constructor(
    private readonly client: ChatGPTClient,
    private readonly controller: OpenClawController,
    private readonly state: PostgresPlatformState,
    private readonly compute: ComputeDriver,
  ) {}
}
```

The concrete Driver calls `/v1/manage/workspaces/{workspaceId}/service-accounts` for account creation and
`.../service-accounts/{externalAccountId}/credentials` for credential issuance; requests exactly
`chatgpt.workspace.feature.allow-codex-local-access.access`; and sends the explicitly bounded TTL.
It looks up the exact persisted upstream credential ID internally for deletion. Provider denial of an
excessive TTL fails closed; expiration does not trigger renewal. Account names sent upstream must be
unique across OCC Namespaces sharing the provider workspace. The issued access token exists only in the
API process while the Driver hands it directly to Kubernetes Compute for storage; its returned Driver
result contains only the generic credential kind and Secret reference. These components are in-process,
not process-isolated. Provider
behavior is defined by the workspace account Admin API
and existing typed ChatGPT client.

### Account identity, operations, and authorization

Keep the existing Namespace-owned OCC `ServiceAccount` provider-agnostic: its `sa_*` identity owns
authorization, association, and audit; its optional credential contains only a generic kind and exact
Namespace-local `secretRef`. Add the provider-neutral `access_token` kind; preserve `api_key` and the
representable-but-undeployable `oauth_access_token`. Never add `chatgpt`, `provider`, workspace identity,
upstream account identity, or upstream credential identity to the public account contract.

`ChatGPTServiceAccountDriver` privately persists one binding for each managed OCC account:

```ts
{
  serviceAccountId: "sa_...",
  namespaceId: "ns_...",
  driverId: "...",
  externalAccountId: "...",
  externalCredentialId: "...", // Present after issuance; required for exact deletion/reconciliation.
  workspaceId: "...",
}
```

The binding belongs to the Driver, not the public OCC account or API schema. Enforce exact account and
Namespace ownership, immutable Driver/upstream account/workspace identity, and durable upstream
credential identity through private persistence. The Driver participates in the same existing
outer OCC transaction as its account and credential mutations by joining `OpenClawController.transact`
and querying its existing `PostgresPlatformState` transaction context. Keep provider-specific binding
repositories out of the public `PlatformUnitOfWork`; do not introduce an independent pool, a parallel
transaction, or a second transaction context. Persist upstream credential IDs for exact deletion and
future rotation/reconciliation without placing them in API responses, OCC account contracts, or Agent
revisions.

Account creation remains `POST /namespaces/:namespaceId/service-accounts`. With the selected Driver, OCC
authorizes `create` against the exact Namespace collection, allocates the OCC identity, creates the
provider account through the selected Driver, and commits its private binding with the OCC account.
Credential creation is a distinct
`POST /namespaces/:namespaceId/service-accounts/:serviceAccountId/credentials`: authorize `update` on
that exact account, verify its exact Namespace and private Driver binding, reject an existing credential
with `409`, invoke the Driver, and persist only its returned generic credential metadata in the OCC
account. Return `201` with the existing `{ data: ServiceAccount, meta: { requestId } }` envelope; account
responses include only the generic credential kind and Secret reference, never provider identity,
upstream credential identity, workspace identity, or credential bytes.
Existing manual
`PATCH .../credential` remains the existing native/API-key operation and cannot overwrite a provider
account's managed credential. Agent create, update, and deployment additionally require exact account
`read`; an associated account cannot be deleted. Deleting an unassociated provider-linked account removes
its exact source Secret and upstream account; provider or Kubernetes failures leave the operation
unconfirmed and expose only safe cleanup identifiers.

Authorization denial happens before upstream or Kubernetes side effects. OCC audit identifies the actual
OCC principal; the upstream provider independently attributes the call to its authenticated admin key.
OCC permission does not grant provider privileges, and provider admin privileges do not bypass OCC IAM.
An admitted Agent revision snapshots only the exact OCC account ID, generic credential kind, and Secret
reference; no snapshot contains provider identity, workspace identity, upstream credential identity, or
token bytes.

### Compute-owned credential storage and Codex execution

Kubernetes Compute stores an issued access token in one deterministically named, account-owned Secret in
the account's exact backing Kubernetes namespace, labeled with the OCC Namespace and account identities.
The Secret stores the access token and its workspace ID as separate keys; the workspace remains private
driver/runtime data, not public OCC account metadata. The Driver invokes one Compute credential-storage
operation and receives only the token's `{ name, key }`. The API identity creates and deletes this
account Secret. During `prepareRevision`, the worker uses the immutable account identity and generic
Secret reference to project both required keys directly into the associated dedicated Codex Pod through
`secretKeyRef`. Kubernetes resolves both references; neither the worker nor workload receives Kubernetes
Secret API access. Agents associated with the same account intentionally share its one credential. Do not
create an Agent-specific copy.

The dedicated Codex workload receives `CODEX_ACCESS_TOKEN` and the pinned workspace ID directly from the
same Secret; its separate gateway never receives either the account token or admin key. Configure Codex
using that projected workspace and authenticate through stdin with
`codex -c forced_chatgpt_workspace_id="<workspace-id>" login --with-access-token`; store required login
state only in the existing bounded ephemeral Agent volume. Clear the token environment variable after
login. Preserve the existing `OPENAI_API_KEY` / `codex login --with-api-key` path for API-key accounts
and embedded OpenClaw; reject generic access-token deployment for every unsupported Harness/topology
before admission.
The existing Codex service-account integration
demonstrates workspace-pinned `--with-access-token` authentication.

Grant the API service identity only required Kubernetes Secret verbs through operator-authorized
RoleBindings in its exact tenant namespaces; grant no cluster-wide Secret access, `list`, or `watch`.
Worker and workload identities retain zero Secret API permissions. Kubernetes cannot constrain dynamic
Secret `create` by `resourceNames`, so a compromised authorized API identity has namespace-wide Secret
impact. A compromised worker can also indirectly expose any same-namespace Secret by creating or
modifying a Deployment that projects it; denying Secret API verbs does not prevent that access.
Deterministic account-owned names, ownership checks, distinct API/worker roles, and Namespace isolation
bound normal operations but do not remove this tenant-level controller trust boundary. Independent
workload admission that could enforce stronger worker isolation is outside this milestone. Add restricted
provider HTTPS egress for the **API Pod only**, scoped to the fixed trusted endpoint through an explicitly
configured CIDR or approved egress proxy; do not grant worker-wide or unrestricted TLS egress.

Register compensating actions on OCC's outer transaction as soon as provider creation or account-Secret
creation succeeds; preserve them through private binding/account persistence, audit append, and
PostgreSQL `COMMIT`. The Driver revokes only the exact newly issued upstream credential ID from its
private binding or issuance result, deletes only the exact newly created account Secret, and deletes only
the newly created upstream account. It also revokes a newly issued credential if Secret creation fails
before OCC receives the result. If commit outcome is ambiguous, inspect committed private binding/account
state before compensation; never revoke a durably committed credential or guess when durable state is
unavailable. Surface failed compensation or unknown commit outcome for operator reconciliation using
safe driver-private identities.

A provider denial, excessive TTL, unavailable admin credential, missing API tenant RoleBinding, upstream
failure, provider/workspace mismatch, missing or foreign account Secret, expired credential, or
unsupported Harness fails closed; never substitute another account, ambient API key, or workspace. Keep
prior snapshots immutable.

OAuth refresh belongs to a future credential/provider owner that holds refresh authority. It is outside
this implementation; OCC, IAM, Compute, and Harnesses do not refresh OAuth credentials.

