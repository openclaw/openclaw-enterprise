# Controller reconciliation

The controller worker advances Namespaces from `provisioning` to `ready`,
finishes deleting empty Namespaces, stops or deletes Agents, and prepares and
activates admitted Agent revisions. It runs separately from the OpenClaw Control Plane
(OCC) HTTP API, polls durable PostgreSQL work, and calls its selected Compute
Driver. The default development Docker Compute Driver creates one Docker
network per Namespace. It rejects the Harness authentication required by the
public deployment API and cannot deploy Agents. Select Kubernetes to deploy
Agents locally; it supports embedded OpenClaw, dedicated Codex, and dedicated
native OpenClaw when a full-facet provisioning SandboxDriver is selected. Reviewed
bundled or installed Drivers can reconcile their supported operations in both
development and production. See the [deployment guide](../guides/deploy.md).

This reference owns durable reconciliation, queue states, and recovery guarantees.
The [worker flow](../flows/controller-worker.md) explains their execution through
the source; the [quickstart](../guides/quickstart.md) and deployment guide own
process startup procedures.

## Requirements

- Node.js 24 or newer and the repository's existing workspace dependencies.
- For default Compose development, Docker Engine and `docker compose`. To deploy
  Agents locally, follow [Local Setup](../guides/quickstart.md).
- A migrated local PostgreSQL database and an API using the same application
  connection; the full Compose stack starts both. See the
  [configuration reference](settings/operations.md#local-compose-and-postgresql-configuration).
- For default PostgreSQL-backed development, the API must also use the
  filesystem Configuration Driver root. Compose mounts `occ_configuration_data`
  only into the controller at `/app/.development/configurations`.
- A bootstrapped Installation. Compose's `bootstrap` service and the Helm
  initialization Job run `scripts/bootstrap-installation.mjs` after migration
  and before the API or worker. Direct-process setups run that initializer first.
- `NODE_ENV=development` or `NODE_ENV=production` and the application-role
  `OCC_DATABASE_URL`.
- In production, the shared absolute `OCC_CONFIG_PATH` to trusted Installation
  startup YAML selecting approved IAM, Compute, and Configuration Drivers and the
  bundled Kubernetes Secret Driver.

The worker does not support process-local state. Never start it with migration or
PostgreSQL administrator credentials.

## Configuration

The worker requires its own `NODE_ENV` and `OCC_DATABASE_URL`. Production also
requires the same absolute `OCC_CONFIG_PATH` startup YAML as the API.
Development omits `OCC_CONFIG_PATH` to select the bundled Docker Compute
Driver; the default filesystem Configuration Driver is API-only and uses the
controller's `OCC_DEVELOPMENT_CONFIGURATION_ROOT`. Set `OCC_CONFIG_PATH` only to
choose another trusted Driver set explicitly. The worker resolves the singleton
Installation internally. Driver IDs,
implementations, and closed-schema settings come from the YAML; worker
environment variables can tune the poll interval, claim lease, maximum
attempts, and optional readiness-marker path. Defaults and validation are
defined in the [worker configuration reference](settings/operations.md#controller-worker-environment).

The API's listener and Better Auth settings are not worker inputs. Both
processes must use the same migrated PostgreSQL database.

## Startup and readiness contract

Both processes resolve the persisted singleton Installation internally. Their
YAML selects approved IAM, Compute, and Configuration Drivers and the bundled
Kubernetes Secret Driver. Reviewed bundled and installed implementations are
available according to the [Driver selection reference](drivers/selection.md#supported-selections).
Driver-owned closed schemas are validated before construction;
missing files, unknown fields, unavailable implementations, or plaintext
credentials fail closed. See the [Configuration guide](configuration.md).

The API additionally requires `OCC_AUTH_SECRET` and `OCC_AUTH_BASE_URL`.
User sessions authenticate controller API callers; ordinary
exact-resource IAM permissions and Restrictions still authorize every
operation. Operators must expose the API only through an internal `ClusterIP`
Service and enforce default-deny ingress with explicitly approved namespace and
Pod selectors.

Before serving requests or claiming work, both processes verify the existing
Installation and persisted IAM state. When the bundled Kubernetes Compute
Driver is selected, they also verify explicit Kubernetes credentials, TLS
trust, and exact Kubernetes Namespace access. The bundled Kubernetes
Configuration Driver validates its authentication settings at startup but
checks tenant ConfigMap access only when its first CRUD request runs; a
driver-managed provisioning Namespace can return `503` until its tenant
namespace and API RoleBinding exist. Explicitly selected external Namespaces
instead reject Configuration creation with `409` until ready. AgentRevisions
retain their selected Compute identity and immutable
Configuration snapshot and explicit Harness execution mode. Production worker
claim, stale-claim recovery, and backlog queries include Namespace and both
approved AgentRevision pairs: `dedicated` Codex and `embedded` OpenClaw. Each
Agent-owned gateway serves only its own active revision; unsupported
Harness/mode combinations and external ingress remain unavailable.

## Reconciliation lifecycle

Namespace creation and deletion queue infrastructure work. Agent stop and
deletion queue exact-Agent lifecycle work. Agent deployment queues an immutable
revision; the worker prepares it, activates its route, and retires its
predecessor. Kubernetes uses a single-replica gateway with `Recreate`, so
replacement can interrupt serving. For embedded OpenClaw, the predecessor can
stop before the replacement passes authentication and readiness. Read
[Namespace and Agent reconciliation](controller/reconciliation.md) for lifecycle,
queue states, authorization, and recovery.

## Observability

Optional [OCC metrics](metrics.md) expose request, reconciliation, Agent inventory,
and process measurements through separate private API/worker listeners. Metrics
remain active independently of log level.

Use the [observability guide](../guides/observability.md) to set log levels,
configure export, and verify delivery. The API and worker share the OCC Pino
logger. The API disables Fastify's default request logging and emits one
sanitized `http.completed` record per response with the generated
request ID, method, route template, status, and duration. Unexpected internal
failures add `http.unexpected_error` with a bounded error code.

The worker emits fixed operational event classes through the same logger:

- `worker.started`: confirms the selected Compute Driver and optional
  SandboxDriver.
- `worker.health`: reports readiness and pending work count at debug level.
- `worker.completed`: includes `namespaceId`, work identity, attempt, outcome,
  and a stable result code; AgentRevision operations also include `agentId` and
  `revisionId`. A failed or deferred revision pass adds `cause`: the error class,
  or for a transient dependency its closed failure code, with `dependency` naming
  the dependency. An HTTP failure adds `status`, and the Kubernetes Status `reason`
  when its cause keeps one, such as `403` and `Forbidden` for a refused Secret
  write. A provisioning plan that the Compute Driver refuses for a reason the caller
  cannot fix adds that `reason`. These fields stay in the local log; the Collector
  exports only the result code. Each deployment pass adds worker wall-clock milliseconds:
  `durationMs` for the pass, `deployPasses` and summed Compute `prepareMs` so
  far, `readinessWaitMs` from the first unready observation to the first ready
  one (or to now while pending), `activationMs` from the ready observation to
  completion, and `elapsedMs` since admission. Totals cover the passes this
  worker process ran; a restart starts them again. Maintenance, cleanup, and
  stop work carry no deployment timing.
- `worker.error`: reports `CLAIM_LOST` or `WORKER_UNAVAILABLE` without exposing
  credentials.
- `worker.repository-cleanup-warning`: a repository cleanup that another
  pass cannot settle, at warn level, once per work item and `cause`. `cause` is
  `REPOSITORY_ATTEMPT_INVALIDATED` or the cleanup error code (for example
  `COMPUTE_DRIVER_MISMATCH`).
- `worker.stopped`: confirms graceful shutdown.

Bootstrap and migration scripts use the same level and write machine-protocol
success records to stdout. Their structured failure diagnostics go to stderr.
Startup failures write `startup-error`, `worker.startup-error`,
`installation.bootstrap-failed`, or `migration.failed` and exit before serving
or processing work. Log sanitization keeps only reviewed scalar fields and drops
credentials, provider payloads, request objects, and unbounded error values. The
worker does not expose an HTTP health endpoint.

## Failures and diagnostics

- **Namespace stays `provisioning`:** Start the separate worker, verify both
  processes use the same database, and inspect `worker.health` and
  `worker.completed` output.
- **Docker Namespace does not become ready:** Confirm Docker Engine access from
  the worker and inspect the per-Namespace Docker network labels. Docker Agent
  container tooling is for contributor verification; it cannot deploy through
  the public API. Use [Docker Compute Driver troubleshooting](drivers/docker-compute.md#troubleshooting).
- **Configuration creation returns `503`:** Confirm the API, not the worker,
  has `OCC_DEVELOPMENT_CONFIGURATION_ROOT` set and can write the
  `/app/.development/configurations` mount backed by `occ_configuration_data`.
- **AgentRevision does not activate:** Confirm its Namespace is `ready`, the
  original actor retains exact-Agent `deploy` permission and `read` on any
  account in its immutable revision, and its pinned Harness descriptor and
  Compute implementation match the worker.
- **Kubernetes Namespace or Agent workload does not become ready:** Confirm
  the API and worker selected the same configured driver and the worker uses
  the bootstrapped singleton Installation; check explicit cluster authentication,
  externally provisioned tenant-local RBAC, enforced NetworkPolicies, image
  availability, and gateway EndpointSlices. See the
  [Kubernetes Compute Driver guide](drivers/kubernetes-compute.md).
- **Installation is not bootstrapped:** Confirm the Compose `bootstrap` service
  or Helm initialization Job succeeded against the API/worker database. For
  direct-process setup, run `scripts/bootstrap-installation.mjs` with the selected
  environment's protected output settings before starting either process.
  Resolve [failed initialization](../guides/deploy/service-keys.md#recover-an-incomplete-bootstrap)
  manually before another attempt; bootstrap does not clean up or retry.
- **Startup YAML is missing or rejected:** Set production `OCC_CONFIG_PATH` to
  the same absolute, readable file for API and worker. Remove unknown Driver
  fields and plaintext credentials; verify all selected Driver
  implementations and exact Kubernetes access.
- **`KUBERNETES_API_UNAVAILABLE` at startup:** The Compute preflight got no
  answer from the Kubernetes API server in the event's `host` and `port`.
  Confirm the API and worker egress policy still allows that address (Helm
  `cluster.cidrs`) and that the server is running.
- **Configuration operations fail:** Verify exact Namespace or Configuration
  authorization, tenant-local ConfigMap CRUD, and a native JSON configuration
  document;
  see [Configuration troubleshooting](configuration.md#failure-semantics-and-limitations).
- **`A valid PostgreSQL connection URL must be explicitly configured.`:** Set
  `OCC_DATABASE_URL` to the migrated application's `postgresql:` connection.
- **Worker mode is rejected:** Set `NODE_ENV=development` or
  `NODE_ENV=production` explicitly. Production additionally requires valid
  trusted startup YAML selecting approved Drivers, including the bundled
  Kubernetes Secret Driver.
- **`AUTHORIZATION_DENIED` or `ACTOR_REVOKED`:** Inspect the initiating actor's
  current role, binding, exact-Namespace Restrictions, and `read` permission on
  any service account captured in the immutable revision; see [IAM](authorization.md).
- **`CLAIM_LOST`:** Another valid claim recovered the operation. The stale
  attempt cannot publish lifecycle state; inspect subsequent worker events.

## Related

- [API operations, authentication, and permission reference](api.md)
- [Namespace lifecycle and deletion](namespaces.md)
- [Agent Configuration, revisions, and deployment](agents.md)
- [Native service accounts and account authorization](service-accounts.md)
- [Controller and PostgreSQL configuration](settings.md)
- [Docker Compute Driver and Compose development](drivers/docker-compute.md)
- [Namespace Configuration and Kubernetes ConfigMaps](configuration.md)
- [Kubernetes Compute Driver and local-cluster verification](drivers/kubernetes-compute.md)
- [Identity and access management](authorization.md)
- [Platform architecture](../design.md)
