# Configuration

OpenClaw Control Plane (OCC) keeps Agent settings and platform settings in
separate places. Agent settings live in a reusable Configuration in the Agent's
Namespace. Saving a change does not affect a running Agent; deploy each Agent
that should use it. Platform operators set Installation and Driver options in
trusted startup YAML, not in Agent Configurations.

- To reuse launch settings when creating Agents, use [Presets](presets.md).
- To change a model or other Agent settings and put them into use, follow
  [Agent revisions](../guides/topics/agent-revisions.md).
- To choose Agent credentials or enable a channel, see
  [Configuration secrets and channels](configuration/secrets.md).
- To set platform options, see [Installation startup configuration](#installation-startup-configuration)
  and [controller and PostgreSQL settings](settings.md).

Every Agent Configuration has the required, immutable `kind: "agent"`. Its
`values` holds the native OpenClaw document, including `env`, `file`, and `exec`
SecretRefs. The optional `secretBindings` field binds exact Namespace-owned
Secrets to selected gateway environment variables; the Secret Driver stores the
values separately. The Configuration Driver stores the native document. The
bundled Kubernetes Driver uses one `openclaw.json` ConfigMap entry. Reviewed
bundled and installed Configuration Drivers are available in development and
production.

## Installation startup configuration

Set `OCC_CONFIG_PATH` to the absolute path of a trusted YAML file. Production
requires this setting; development can omit it to retain its existing local
defaults. When provided, both API and worker processes must read the same file.
The [production Kubernetes deployment guide](../guides/deploy/production-installation.md#configure-the-installation)
owns the complete bundled-Driver Installation example, including immutable
images, workload isolation, and projected ServiceAccount credentials. The
[Driver package installation guide](drivers/selection.md#select-the-installed-driver)
owns the installed IAM, Compute, and Configuration selection contract. The
[Backend reference](backends.md) defines the optional `backend` array and its
required related Driver membership. Backend configuration never enters native
Agent Configuration documents. The optional `presets.includeDefaults` boolean
adds bundled Agent Presets to Namespaces; it defaults to `false`. A
`presets.files` entry named like a bundled default replaces that default with a
startup warning. See
[Preset initialization](presets.md#installation-defaults) for permissions,
restart behavior, and preservation of existing copies.

OCC resolves its persisted singleton Installation internally; Configuration and
Secret Driver operations do not include Installation management. Installed
Drivers remain trusted, unsandboxed controller code. Invalid production YAML,
unsupported settings, and unavailable Drivers stop startup before requests run.

Each selected Driver validates its own closed configuration schema; unknown
fields fail startup. OCC routes authorization through the selected IAM Driver,
whose reviewed implementation is trusted to enforce its policy.

The optional `observability` block sets one external console destination:

```yaml
observability:
  url: https://grafana.example.com/d/occ-observability
```

`url` must be an absolute HTTP or HTTPS URL without embedded credentials or a
fragment. Unknown fields fail startup. The API exposes the URL only after an
Installation `administer` check; the console hides the link when unset or
unauthorized. The destination handles its own authentication. This setting does
not select an OpenTelemetry exporter or embed a dashboard. Compose development
can use this block alone with its default Drivers; mount the same file into API
and worker containers.

The optional `runtime` block declares a custom runtime image with dedicated
native OpenClaw support:

```yaml
runtime:
  nativeWorkerSupport: custom-image
```

`custom-image` is the only declaration value; no API or Agent Configuration
field can set it. The pinned runtime already supplies native-worker support,
so its Dedicated OpenClaw flow needs no declaration. Use this optional block
only for a separately selected custom image with automatic required worker
placement and node-local inference. It does not add runtime features or waive
the required provisioning SandboxDriver and its containment facets. See
[Native worker support](harness-execution.md#native-worker-support).

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
requires the replacement `values` and may also set `secretBindings`, for example:

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
fields or resolving SecretRefs, except that Configuration create and update and
Agent provisioning check each model provider's `baseUrl` and `api`, and those of
its `models` entries: `baseUrl` must be an absolute `http` or `https` URL, and
`api` must be a model API the pinned OpenClaw runtime supports, such as
`openai-responses`, `openai-completions`, `anthropic-messages`, or `ollama`.
A blank provider `baseUrl` and values with `${VAR}` references are left to the
runtime. The `400` names the field as a JSON pointer within `values`. Agent
deployment separately validates supported
runtime selection, topology, and Secret binding ownership before admission.
Creation requires `create` permission for Configurations in the
exact parent Namespace. Reads, updates, and deletes require the corresponding
permission for the exact Configuration. Authentication failures return `401`,
malformed inputs `400`, denied operations `403`, missing resources `404`,
dependency conflicts `409`, and unavailable authorization or storage `503`.

## Credentials and channels

Never put plaintext credentials in Configuration values. Use unresolved native SecretRefs and authorized same-Namespace Secret bindings for gateway credentials; select model credentials through Agent `harnessAuth`. See [Configuration secrets and channels](configuration/secrets.md) for binding permissions, complete examples, runtime delivery, and supported Slack/Teams settings.

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
startup YAML and are not copied into that snapshot. See the
[Agent revision contract](agents/deployment.md#revisions-and-deployment) for the fields
admission freezes; immutable Configuration does not freeze all Driver settings.

## Kubernetes storage

The Kubernetes Configuration Driver stores live native documents in tenant ConfigMaps. Compute creates separate immutable revision snapshots. See [Kubernetes Configuration storage](configuration/kubernetes.md) for placement, readiness, ownership, and exact RBAC requirements.

## Failure semantics and limitations

- **Startup rejects `OCC_CONFIG_PATH`:** Use an absolute path to a readable,
  valid YAML file shared by the API and worker. Remove unknown Driver settings;
  verify every selected implementation is available.
- **Configuration create or update returns `400`:** Create with
  `kind: "agent"` and provide a JSON object in `values`. Do not send `kind`,
  `generation`, or ownership fields in an update. When the message names a
  `baseUrl` or `api` field, correct that model provider setting.
- **Configuration operation returns `403`:** Verify exact-Namespace `create`
  or exact-Configuration `read`, `update`, or `delete` permission; check the
  selected Kubernetes identity's namespaced ConfigMap Role separately.
- **Configuration operation returns `404`:** Confirm the Configuration ID
  belongs to the Namespace in the request path.
- **Configuration deletion returns `409`:** An Agent still references that
  Configuration. Reassign every referencing Agent, or
  [delete the Agents](agents.md#deletion) and wait for teardown before retrying.
  A Configuration created by guided Agent provisioning stays referenced until
  that provisioning succeeds and its Agent selects another Configuration.
- **Configuration operation returns `503`:** Confirm the selected Driver and
  IAM service are available, Kubernetes authentication and TLS are valid,
  tenant placement is ready, exact namespaced ConfigMap access exists, and the
  tenant-owned ConfigMap contains one valid `openclaw.json` document.

## Related

- [Quickstart](../guides/quickstart.md)
- [Development and production deployment](../guides/deploy.md)
- [Controller and PostgreSQL configuration](settings.md)
- [Controller worker lifecycle](controller.md)
- [Update and deploy Agent revisions](../guides/topics/agent-revisions.md)
- [Agent Configuration, revisions, and deployment](agents.md)
- [Kubernetes Compute Driver](drivers/kubernetes-compute.md)
- [Identity and access management](authorization.md)
- [Configuration lifecycle implementation](../../packages/occ/src/index.ts)
- [Local testing](../testing/local.md)
- [Kubernetes testing](../testing/kubernetes.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 08:47: Link Installation Provider definitions separately from native Agent Configuration. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)

- [2026-08-28 13:56]: Consolidated Secret binding guidance and deferred Secret CRUD details to the driver reference. (01a04995-4a11-7c61-ab52-0b43f49524dc - 64e19bb)

- [2026-08-28 17:55]: Recast Configuration as current feature reference and clarify admitted SandboxDriver transforms and scoped Secret permissions. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
