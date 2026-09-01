# Configuration

OpenClaw Control Center (OCC) stores reusable Agent configuration as
Namespace-scoped Configuration resources. Each resource explicitly identifies
its consumer with the required, immutable `kind: "agent"`. Its `values` is the
actual nested OpenClaw configuration document, including native OpenClaw
SecretRefs for `env`, `file`, and `exec`. Its optional `secretBindings` map is
separate OCC metadata that binds exact Namespace-owned Secrets to selected Agent
gateway environment variables. The selected Configuration Driver persists `values` in
its implementation-owned storage; the bundled Kubernetes Driver uses one
`openclaw.json` ConfigMap entry. Reviewed bundled and installed Configuration
Drivers are available in both development and production. The selected
SecretDriver stores Secret values separately. Installation settings and
selected Driver options remain separate: OCC reads them directly from trusted
startup YAML and never stores them in tenant ConfigMaps.

## Installation startup configuration

Set `OCC_CONFIG_PATH` to the absolute path of a trusted YAML file. Production
requires this setting; development can omit it to retain its existing local
defaults. When provided, both API and worker processes must read the same file.
The [setup command](setup.md#generated-configuration)
generates the complete bundled-Driver Installation configuration, including immutable
images, workload isolation, and projected ServiceAccount credentials. The
[Driver package installation guide](drivers/selection.md#select-the-installed-driver)
owns the installed IAM, Compute, and Configuration selection contract.

OCC resolves its persisted singleton Installation internally; Configuration and
Secret Driver operations do not include Installation management. Installed
Drivers remain trusted, unsandboxed controller code. Invalid production YAML,
unsupported settings, and unavailable Drivers stop startup before requests run.

Each selected Driver validates its own closed configuration schema; unknown
fields fail startup. OCC routes authorization through the selected IAM Driver,
whose reviewed implementation is trusted to enforce its policy.

## Create, read, update, and delete

`POST /namespaces/:namespaceId/configurations` creates one reusable native
Agent Configuration. A representative request body is:

```json
{
  "kind": "agent",
  "values": {
    "agents": { "defaults": { "sandbox": { "mode": "all" } } }
  }
}
```

Successful creation returns HTTP `201`. The response's `data` contains its
server-generated `id`, owning `namespaceId`, `kind: "agent"`, initial
`generation: 1`, unchanged `values`, optional `secretBindings`, and
`createdAt`; `meta.requestId` identifies the request. Add `secretBindings` only
after the referenced Namespace-owned Secrets exist.

OCC generates the `cfg_` identifier and derives ownership from the exact route
Namespace; callers cannot select either field. GET, PATCH, and DELETE operate
on `/namespaces/:namespaceId/configurations/:configurationId`. A PATCH body
contains only the replacement `values`, for example:

```json
{
  "values": {
    "agents": { "defaults": { "sandbox": { "mode": "all" } } }
  }
}
```

GET and PATCH return HTTP `200`; PATCH always includes a replacement `values`
document and increments its server-managed `generation` exactly once, so
omitted `models` and `secrets` sections disappear. Omitting `secretBindings` on
PATCH preserves the existing bindings; send `{}` to clear them. PATCH cannot
change or accept `kind`, `generation`, or ownership fields. Successful DELETE
returns HTTP `204` with no body.

Creation requires `kind: "agent"`; missing or unsupported kinds are rejected.
Additional consumer kinds are reserved for future approved resources and are
not accepted. `values` must be a JSON object. It can contain the nested objects,
arrays, strings, finite numbers, booleans, and nulls used by native OpenClaw
configuration. OCC preserves the native document without interpreting its
fields or resolving SecretRefs. Agent deployment separately validates supported
runtime selection, topology, and Secret binding ownership before admission.
Creation requires `create` permission for Configurations in the
exact parent Namespace. Reads, updates, and deletes require the corresponding
permission for the exact Configuration. Authentication failures return `401`,
malformed inputs `400`, denied operations `403`, missing resources `404`,
dependency conflicts `409`, and unavailable authorization or storage `503`.

## Secret bindings

Use `Configuration.secretBindings` only to map a Namespace-owned OCC Secret to a
selected gateway environment variable. The referenced Secret must already belong
to the same Namespace as the Configuration and deploying Agent. The native
OpenClaw document in `values` then consumes that environment variable with its
normal `env` SecretRef:

```json
{
  "secretBindings": {
    "OPENAI_API_KEY": {
      "source": {
        "kind": "secret",
        "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
        "id": "sec_123e4567-e89b-42d3-a456-426614174000"
      }
    }
  },
  "values": {
    "secrets": {
      "providers": {
        "model": { "source": "env", "allowlist": ["OPENAI_API_KEY"] }
      }
    },
    "models": {
      "providers": {
        "openai": {
          "apiKey": {
            "source": "env",
            "provider": "model",
            "id": "OPENAI_API_KEY"
          }
        }
      }
    }
  }
}
```

Each binding value contains `source.kind: "secret"`, the source
`namespaceId`, the source Secret `id`, and optional `delivery.type: "env"`.
Omitting `delivery` normalizes to `{ "type": "env" }`; no other delivery mode is
implemented. Binding names must be valid environment variable names and cannot
use reserved process-control prefixes such as `OPENCLAW_`, `CODEX_`, `OCC_`,
`KUBERNETES_`, `PATH`, `HOME`, or proxy variables. `OPENAI_API_KEY` is the only
allowed `OPENAI_*` destination.

OCC rejects cross-Namespace references and missing or foreign backend objects
even if IAM would otherwise allow the operation. Creating or updating a
Configuration whose resulting document contains bindings requires the normal
Configuration mutation permission and `operate` on every selected Secret,
including retained bindings when PATCH omits `secretBindings`. Creating or
updating an Agent assignment to a bound Configuration requires the normal Agent
mutation permission and `operate` on each exact Secret. Namespace membership,
Configuration access, Agent access, or possession of a ref does not grant
consumption. Deployment stores normalized references and the selected
SecretDriver identity in the immutable AgentRevision; it does not store backend
locators or value bytes. Secret storage CRUD, update/restart semantics,
Kubernetes Secret RBAC, no-leakage rules, and troubleshooting are owned by the
[Kubernetes Secret Driver](drivers/kubernetes-secret.md).

## Agent references and immutable revisions

An Agent references one Configuration in its own Namespace:

```json
{
  "name": "support-agent",
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000"
}
```

Updating the Agent can replace its `configurationId`; OCC rejects references
outside the Agent's Namespace or to a Configuration whose `kind` is not
`"agent"`. Agent creation, update, and deployment separately require `read`
permission for the exact referenced Configuration. Deployment deeply
snapshots its admitted native document, including unresolved inline SecretRefs,
into the immutable `AgentRevision.configuration` field and records
`configurationId`, `configurationKind`, and `configurationGeneration` as
separate revision fields. A selected [SandboxDriver](drivers/sandbox.md) may
transform a copy through `configureAgent` before admission; the reusable
Configuration and its generation remain unchanged. The snapshot contains that
effective document, and its metadata identifies the source generation.
Subsequent Configuration updates do not change a
running gateway or existing revision; only a later explicit deployment observes
the next generation. Deleting a Configuration still referenced by an Agent
returns `409`.

Native OpenClaw provider settings in `values.channels` follow the same
Configuration ownership and immutable Agent deployment lifecycle.

Database constraints require the supported Configuration kind, a positive
generation, matching Agent ownership, and a valid immutable admitted revision
snapshot. The native configuration document keeps its existing root-object
shape without a wrapper, reserved persistence key, or reconstruction from
environment-variable names. `secretBindings` remain separate from `values` so
OCC can authorize, validate, and freeze delivery references without rewriting
the native OpenClaw document.

AgentRevisions retain their selected Compute Driver identity and immutable
Configuration snapshot. Compute runtime settings are loaded from Installation
startup YAML; stability across later settings changes remains an open design
item tracked in [TODO.md](../../TODO.md).

## Kubernetes placement and RBAC

`KubernetesConfigurationDriver` creates exactly one ConfigMap per Configuration
in the Kubernetes namespace selected for its exact tenant. Both bundled drivers
discover the same driver-owned or operator-owned namespace from its tenant
identity; the ConfigMap itself remains OCC-owned. An existing namespace is
selected through `existingNamespace` when creating its platform Namespace;
the worker binds its tenant identity before the platform Namespace becomes
`ready`. Wait for readiness before creating the first Configuration; an
external Namespace that is still provisioning rejects its creation with `409`.
See
[existing-namespace setup](drivers/kubernetes-compute.md#namespaces-and-isolation).
Its data contains exactly one entry:

```json
{
  "data": {
    "openclaw.json": "<JSON-serialized values document>"
  }
}
```

The driver validates and parses that document when reading it; malformed JSON,
extra data entries, excessive size, or incorrect ownership fail closed. It
cannot select another tenant namespace, share tenant objects,
read Kubernetes Secrets, create Pods, or store Installation settings. ConfigMap
updates are not watched or automatically reloaded into admitted AgentRevisions.

PostgreSQL stores only server-owned Configuration metadata: its identifier,
owning Namespace, immutable kind, current generation, and creation time. The
tenant-owned ConfigMap carries matching kind and generation annotations and
stores only the live native configuration document in `openclaw.json`; values
are not duplicated in Configuration metadata. Deployment separately persists
its immutable revision snapshot.

When Kubernetes Compute prepares an admitted AgentRevision, it creates a
**separate, immutable, Agent-owned snapshot ConfigMap** containing exactly that
revision's native `configuration` document. The Agent gateway mounts this
snapshot read-only at `/etc/openclaw/openclaw.json`; its environment contains
only the file path in `OPENCLAW_CONFIG_PATH`. It never mounts the mutable
Configuration Driver ConfigMap or copies raw configuration into Pod
environment. A new admitted generation receives a different immutable snapshot
and rolls the same Agent gateway. Old snapshots remain until Namespace deletion;
safe earlier garbage collection is not implemented.

Startup validates the selected Configuration Driver's closed schema and
authentication options but does not probe tenant ConfigMaps or their RBAC:
such a preflight would require a known object or broader access. OCC validates
native Configuration semantics before calling the Driver; Drivers enforce their
backing-storage ownership and identity checks. Kubernetes namespace existence
and exact ConfigMap authorization are checked lazily on the first requested CRUD
operation. An authorized Configuration request can return `503` while a
driver-managed provisioning Namespace's Kubernetes namespace or API RoleBinding
does not yet exist; retry after provisioning and its exact grants are ready. An
explicitly selected existing Namespace instead rejects creation with `409`
until it is ready; after readiness, a missing API RoleBinding returns `503`.

Use the existing cluster-scoped namespace-observer `get`/`list` grant to
discover the exact tenant namespace. Provision tenant-data access through
namespaced ConfigMap CRUD only. Kubernetes cannot restrict `create` by
`resourceNames`; keep it in a separate namespaced rule. Scope the remaining
verbs to exact object names when those names are known:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: occ-configuration
  namespace: tenant-support
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["create"]
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["cfg-123e4567-e89b-42d3-a456-426614174000-0123456789ab"]
    verbs: ["get", "update", "delete"]
```

The object name is illustrative; use the exact name generated by the selected
implementation. Bind this Role only to its intended bootstrap identity in the
same tenant namespace. OCC still verifies exact Namespace placement, object
naming, and ownership before every mutation. Never add ConfigMap `list`/`watch`,
cluster-wide tenant-resource access, Secret access, or Pod-creation privileges;
the existing Namespace-only observer grant does not permit any of them.

The separately selected Kubernetes Compute Driver also requires tenant-local
ConfigMap `get`, `create`, and `patch` to prepare its immutable Agent-owned
revision snapshots. Those Compute permissions and snapshots are independent of
the Configuration Driver's `cfg-*` object allowlist and CRUD identity. Keep
Compute `create` in its own namespaced rule because Kubernetes cannot scope
creation by `resourceNames`; restrict `get` and `patch` to known exact
Agent-owned snapshot names when practical. These Configuration and snapshot
operations do not require Kubernetes Secret access. Secret CRUD and delivery
validation use the separately selected SecretDriver and the API's tenant-local
Secret RBAC. The separately authorized provider-managed service-account
credential path uses exact account-owned Secrets through Compute; see
[service accounts](service-accounts.md).

## Secret boundaries

ConfigMaps are not secret storage. Provide OpenClaw credentials as canonical
inline SecretRefs plus `secretBindings`, or by using the documented
service-account credential paths. Never place plaintext credential values in a
Configuration `values` document:

```json
{
  "models": {
    "providers": {
      "openai": {
        "apiKey": {
          "source": "env",
          "name": "OPENAI_API_KEY"
        }
      }
    }
  }
}
```

OpenClaw owns SecretRef syntax, provider configuration, and validation. OCC,
ConfigurationDriver, and Kubernetes Compute preserve native `env`, `file`, and
`exec` SecretRefs as unresolved JSON. The selected SecretDriver only stores OCC
Secret values and resolves approved env delivery metadata for the owning
gateway. A Namespace-scoped Secret Broker, CredentialGateway/OpenShell
substitution, value history, and automatic rotation remain unimplemented.

### Native channel configuration

Configure channels directly in the Agent's complete native OpenClaw
Configuration. The Kubernetes Compute Driver currently supports enabled
`slack` and `msteams` providers; unknown enabled providers fail closed.
`channels.defaults` and `channels.modelByChannel` are shared settings, not
providers. Each supported channel declares the gateway-only credential values
it needs:

| Provider  | Gateway Secret keys                     |
| --------- | --------------------------------------- |
| `slack`   | `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` |
| `msteams` | `MSTEAMS_APP_PASSWORD`                  |

Add a native default Slack account with environment SecretRefs:

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "mode": "socket",
      "appToken": { "source": "env", "provider": "default", "id": "SLACK_APP_TOKEN" },
      "botToken": { "source": "env", "provider": "default", "id": "SLACK_BOT_TOKEN" },
      "dmPolicy": "allowlist",
      "allowFrom": ["U0123456789"],
      "channels": { "C0123456789": { "requireMention": true } }
    }
  }
}
```

Microsoft Teams uses the native `msteams` provider identifier. Its application
and tenant identifiers are ordinary nonsecret configuration strings; only the
application password is an environment SecretRef:

```json
{
  "channels": {
    "msteams": {
      "enabled": true,
      "appId": "00000000-0000-0000-0000-000000000000",
      "tenantId": "11111111-1111-1111-1111-111111111111",
      "appPassword": {
        "source": "env",
        "provider": "default",
        "id": "MSTEAMS_APP_PASSWORD"
      }
    }
  }
}
```

Set the Agent's `executionMode` to `dedicated`; embedded mode is rejected because
its combined gateway/Agent cannot isolate channel credentials. Preserve existing
Codex/model settings and enable each required native channel plugin. Explicitly
redeploy the Agent to snapshot the updated document; its gateway receives the
union of enabled providers' credentials from an Agent-specific Kubernetes
Secret. See
[Kubernetes runtime credentials](drivers/kubernetes-compute.md#configuration).

Only Slack has live integration coverage. Its automated two-bot integration
temporarily adds `allowBots: "mentions"`, `users: ["<sender-bot-user-id>"]`, and
`replyToMode: "off"` only to the exact test channel; `requireMention` remains
enabled. Never allow bots account-wide. Teams message ingress requires a
separately deployed and reviewed public Bot Framework `/api/messages` webhook;
that webhook and end-to-end Teams verification are outside this milestone.

## Failure semantics and limitations

- **Startup rejects `OCC_CONFIG_PATH`:** Use an absolute path to a readable,
  valid YAML file shared by the API and worker. Remove unknown Driver settings;
  verify every selected implementation is available.
- **Configuration create or update returns `400`:** Create with
  `kind: "agent"` and provide a JSON object in `values`. Do not send `kind`,
  `generation`, or ownership fields in an update.
- **Configuration operation returns `403`:** Verify exact-Namespace `create`
  or exact-Configuration `read`, `update`, or `delete` permission; check the
  selected Kubernetes identity's namespaced ConfigMap Role separately.
- **Configuration operation returns `404`:** Confirm the Configuration ID
  belongs to the Namespace in the request path.
- **Configuration deletion returns `409`:** An Agent still references that
  Configuration. Its reference must be reassigned before deletion; the current
  API has no Agent deletion endpoint.
- **Configuration operation returns `503`:** Confirm the selected Driver and
  IAM service are available, Kubernetes authentication and TLS are valid,
  tenant placement is ready, exact namespaced ConfigMap access exists, and the
  tenant-owned ConfigMap contains one valid `openclaw.json` document.

Live Kubernetes ConfigMap CRUD and least-privilege RBAC proof requires an
explicitly configured disposable cluster and tenant credentials. When those
dependencies are unavailable, the live-cluster case is explicitly skipped;
schema, controller, and SDK-fixture coverage is not live-cluster evidence.

## Related

- [Quickstart](../guides/quickstart.md)
- [Development and production deployment](../guides/deploy.md)
- [Controller and PostgreSQL configuration](settings.md)
- [Controller worker lifecycle](controller.md)
- [Agent Configuration, revisions, and deployment](agents.md)
- [Kubernetes Compute Driver](drivers/kubernetes-compute.md)
- [Identity and access management](authorization.md)
- [Configuration lifecycle implementation](../../packages/occ/src/index.ts)
- [Configuration integration coverage](../../tests/integration/configuration-controller.test.mjs)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-28 13:56]: Consolidated Secret binding guidance and deferred Secret CRUD details to the driver reference. (01a04995-4a11-7c61-ab52-0b43f49524dc - 64e19bb)

- [2026-08-28 17:55]: Recast Configuration as current feature reference and clarify admitted SandboxDriver transforms and scoped Secret permissions. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
