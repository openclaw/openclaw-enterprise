---
created: 2026-08-25
updated: "2026-11-17"
last_updated_session: "authoring-run/91a0ae5f-d349-46da-9b68-38b12dad3187"
---

# Production Startup Flow

## Overview

Helm initializes OCE from protected storage and approved inputs. After private
API/worker readiness, authenticate `/installation` with the service key.

[Deployment guide](../guides/deploy.md).

## Entry Points

- Trigger: Run `scripts/prepare-bootstrap-volume`, then
  `occ installation install` with explicit target, local chart, values and receipt.
- Source: `scripts/prepare-bootstrap-volume:53`,
  `deploy/helm/openclaw-enterprise/templates/jobs.yaml:8`, and
  `apps/controller/src/composition/production.ts:28`.
- Assumptions: Explicit kubeconfig/context, enforcing NetworkPolicies, external
  PostgreSQL, approved immutable images, protected operator files, fresh
  bootstrap PVC, exact API/client selectors, `/32` egress hosts,
  reviewed control-plane node labels, and an approved private OCC URL.

## Flow

First install requires [empty OCE history](../reference/settings/operations.md#migration-history).

```mermaid
graph TD
    subgraph Operator["Operator-owned preparation"]
        A["Prepare values, Installation YAML and bootstrap PVC"]
        B["Create namespace and Secrets; check prerequisites"]
        C["Create fresh bootstrap PVC"]
        D["prepare-bootstrap-volume verifies empty output and root permissions"]
        D --> RC["Snapshot inputs and sync intent"]
        RC --> RN{"Receipt notice write failed?"}
        RN -->|Yes| RF["Preserve intent; stop before dispatch"]
        RN -->|No| RD["Sync dispatch marker"]
    end
    subgraph Helm["Helm-owned startup"]
        RD --> E["Run Helm install once with attempt marker"]
        E --> F["Initialization Job validates mounted Installation"]
        F -->|Startup checks pass| V{"PostgreSQL before 17?"}
        V -->|Yes| P["Refuse initialization before migration DDL"]
        V -->|No| O{"Canonical migration history?"}
        O -->|No| P
        O -->|Yes| G["Apply migrations, bootstrap administrators and write protected key output"]
        G --> H["Start private API Deployment"]
        G --> I["Start independent worker Deployment"]
        I --> R{"Repository credentials enabled?"}
        R -->|Yes| S["Sidecar copies protected inputs and starts private control"]
        S --> Q["Sidecar probe gates worker Pod readiness"]
        H --> L["Run Kubernetes Compute preflight"]
        I --> L
        L --> M{"Kubernetes older than 1.35?"}
        M -->|Yes| N["Emit advisory warning and continue"]
    end
    subgraph Handoff["Read-only operator handoff"]
        F -->|Inspect retained Job| T["occ installation doctor or plan reads named Job"]
        T --> U["Check target, Job identity and terminal status"]
        U --> W["Report checkpoint; operator reconciles remaining work"]
    end
    subgraph Proof["Operator-owned authenticated proof"]
        M -->|No| J["Retrieve service-key response from protected storage"]
        N --> J
        J --> K["occ installation get from approved client"]
    end
```

## Execution Trace

Migration, bootstrap, API and worker use
[`createPostgresPool`](../../packages/occ/src/state/postgres-pool.ts) with
[password or Azure workload-identity authentication](../reference/settings/operations.md#postgresql-connection-authentication).
In password mode, the factory parses the URL before applying caller limits and
startup options, retaining TLS-file reads and IP-host certificate checks.
On failover, maintenance restart, `idle_session_timeout`, or proxy reset, the
pool drops the idle client and logs only its error code to stderr as
`database.idle-client-error`. The next query opens a new connection.

### 1. Prepare native production inputs

`scripts/diagnose-kubernetes-prerequisites.ts:diagnose` reads CRDs, controllers,
addresses and object quota headroom. EKS binds account, ARN, endpoint and CA.
[Resolve failed/unknown checks](../guides/deploy/prerequisite-diagnosis.md) before Helm.

`deploy/helm/openclaw-enterprise/values.yaml:1`

Keep values, Installation YAML and bootstrap PVC outside the checkout. Helm
selects images, endpoint, Secrets, claim, selectors and egress.
`openclaw.validate` requires a DNS-1123 release Namespace label (maximum 63 characters).
Installation YAML selects Drivers, Backends, runtime images, projected identity,
networking and storage.

File-backed Secrets supply Installation startup, database URLs/optional CA, Better Auth
signing, and optional ChatGPT administrator credentials. Helm neither synchronizes
inputs, rewrites Driver configuration, nor infers runtime images.

### 2. Prepare the fresh bootstrap volume

`scripts/prepare-bootstrap-volume:124` takes an existing
`bootstrap.password.claimName` PVC, explicit kubeconfig/context/namespace/claim,
an approved Node-capable image, and optional `--node-selector KEY=VALUE` labels.
It preserves namespace and selector strings, applying selectors before
WaitForFirstConsumer binding. The root must be empty except for filesystem-owned
`lost+found`. The helper sets UID/GID `1000` and mode `0700`.

If forbidden, storage administrators prepare the claim through approved procedures.
The helper cannot create PVCs, repair used claims, retrieve credentials, or
change controller configuration.

### 3. Run Helm initialization

`internal/occcli/installation_receipt.go:installationInstallCommand` snapshots
kubeconfig/chart/values, checks release states, and syncs intent and its directory.
A failed stdout notice preserves and names intent, stopping before dispatch or Helm.
Otherwise the command syncs the unknown marker and starts Helm.
On install, `observeInstallationJob` records the first recognized
attempt-matched Job UID. A final report write error fails the command, preserving
Helm's outcome without replay.

Template failures add static [offline-render guidance](../guides/deploy/production-handoff.md#record-the-initialization-job-for-handoff),
including suffix-refusal settings. The command keeps up to 4 MiB of stderr
in memory. It discards excess without affecting Helm and keeps raw diagnostics
out of output and storage. Receipt and recovery decisions stay unchanged.

`deploy/helm/openclaw-enterprise/templates/bootstrap-networkpolicies.yaml:1`
installs isolation before the Job; it and later policies grant configured
DNS peers UDP/TCP `53` and `5353`
([Helm DNS contract](../reference/settings/production.md#required-production-controller-environment)).

`deploy/helm/openclaw-enterprise/templates/jobs.yaml:8` refuses existing or unreadable
Jobs during connected installs. Offline rendering cannot check this; lookup
neither locks names nor verifies database/volume freshness.

`openclaw.validate` in `deploy/helm/openclaw-enterprise/templates/_helpers.tpl`
checks routing, ports and peer labels. Operators supply GatewayClass, CRDs,
controllers and Secrets. [Disabling routing](../guides/deploy/workspace-routing.md#explicit-opt-out)
omits its resources/mounts and requires disabling native admin and sandbox routing.
Database/API ports accept 1–65535 without leading zeros; worker metrics/repository
ports must differ. The Compute Driver rejects malformed IPv4 hostnames and
numeric/hexadecimal sandbox suffixes. See [refused values](../guides/deploy/production-upgrade-recovery.md#correct-values-the-candidate-refuses).

On install and upgrade, Helm runs
`deploy/helm/openclaw-enterprise/files/check-installation.mjs` (generated from
`deploy/helm/src/check-installation.ts`) before migration, bootstrap, and API rollout.
`formatStartupConfigurationFailure` uses shared `configurationLogDetails` to
report up to 32 fields without submitted values. With `OCC_EGRESS_AUTHORITY_PORT`
or `OCC_OPENSHELL_GIT_PORT` set, `requireChartListener` reports refused ports,
hosts, or paths as `CHART_LISTENER_MISMATCH`.

For chart-managed routing, `openclaw.listenerEnv` passes `OCC_CHART_GATEWAY_ROUTING`
to the hook, API, and worker. `requireChartGatewayRouting` checks the Gateway
name, Gateway and Envoy namespaces, and hostname. Mismatch reports omit values.

The hook preserves the release name and caps its suffix at 63 characters. Both
database containers can mount the CA. Helm checks Kubernetes syntax for distinct
application and migration Secret keys before use. `installation.key` and
`executionCluster.kubeconfigKey` must be Secret keys of at most 253 characters.
Helm rejects `.` and keys starting with `..`.

For [handoff](../guides/deploy/production-handoff.md#resume-an-installation-in-progress),
`internal/occcli/installation_doctor.go:installationHandoffCommand` verifies receipt
namespace/release/cluster connection before reading the named Job.
`initializationEvidence` checks marker, captured UID, chart steps, controller and
terminal status. Missing UID, replacement, refusal or inconclusive status leaves
the checkpoint unknown. Doctor separately reports Helm's outcome; plan adds
read-only recovery. Both check the buffered report's `WriteTo` before returning
Job status. Write errors reach `cmd/occ/main.go:main` for stderr diagnostics and exit `1`.

`scripts/migrate-production.mjs:1`, `scripts/migration-history.mjs:migrateWithHistory`

After source verification, all modes reject PostgreSQL before 17 with
fixed `MIGRATION_SERVER_UNSUPPORTED` recovery guidance, before locking or catalog access
([compatibility](../reference/settings/operations.md#postgresql-server-compatibility)).
Under the advisory lock, the same connection verifies roles and receipts,
then catalogs and grants against native or reviewed restore digests. Unsupported
history fails before DDL/bootstrap. After option guards, completed apply
skips Drizzle only when `SHOW transaction_read_only` returns `off`.
Otherwise Drizzle retains pending migration and read-only refusal.
`finally` releases the lock and client
([history](../reference/settings/operations.md#migration-history)).

`scripts/lib/bootstrap-configuration.ts:bootstrapConfiguration` requires an HTTPS
Console origin before database access, including during `--verify-existing`.

`scripts/bootstrap-installation.mjs` creates or verifies Installation,
human/service administrators, IAM seed, audit evidence, and initial service key.
For fresh Installations, the bootstrap Principal creates the OCE `default`
Namespace through `OpenClawController.createNamespace`. Queued reconciliation
commits with Installation/IAM state and audit. Existing Installations add no
Namespace. The worker provisions Driver-owned
infrastructure, and operators provide tenant RoleBindings. Only the bootstrap
container writes protected PVC password/service-key files.
Use [`--verify-existing`](../reference/settings/production.md#production-installation-bootstrap-environment)
to check a populated candidate with the incumbent ID and a read-only database
snapshot. The Helm Job uses ordinary bootstrap. Existing output, unsafe
permissions, or inconsistent accounts/IAM identity fail the Job. Helm failure can leave database-hook changes committed.

### 4. Start private API and worker Deployments

`apps/controller/src/api-startup.ts:configuration`, `apps/controller/src/worker.ts:312`

`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.preflight`

With [OIDC CA settings](../reference/settings/oidc.md), generated
[`assemble-api-ca.mjs`](../layout.md#deployment-tooling-and-checks) combines
validated IdP and Gateway roots for `NODE_EXTRA_CA_CERTS`.
The `check-api-database-ca.mjs` preload requires the selected PostgreSQL CA and
DNS hostname verification.

`apps/controller/src/auth/configuration.ts:validateAuthSecret` rejects short
secrets before Driver construction or PostgreSQL access. `composeProduction` and
the auth factory repeat the check. The API exposes `/healthz` and `/readyz`.
`apps/controller/src/composition/postgres-readiness.ts:createPostgresReadinessCheck`
shares one application-pool `SELECT 1` per instance across overlapping `GET` and
implicit `HEAD` probes, even after disconnects. The next probe queries again
after PostgreSQL returns. API startup allows 120 one-second failures and readiness
times out after one second. [Worker startup](../../scripts/production-healthcheck.ts)
allows 24 five-second failures.

`apps/controller/src/metrics/listener.ts:startMetricsListener` holds each scrape slot
until collection settles and the response finishes or the socket closes.
[Host and Expect refusals share the response limit](../reference/metrics.md#configuration-and-access).

`apps/controller/src/index.ts:createFastifyApp`

On `SIGTERM`, the API stops accepting connections and drains with
`Connection: close`, bypassing the 72-second keep-alive wait. The single `Recreate`
replica has no peer or `preStop` and cuts off requests after 30 seconds.
Logs show `shutdown.started` (`signal`), then `shutdown.completed`
(`durationMs`) or `shutdown.failed` (exit 1). A lone `shutdown.started`
indicates interruption.

The PostgreSQL API compositions close the independent exchange binding, protected
Driver, prepared GitHub owner, and database in order despite close failures.
Shutdown reports the first failure and wraps falsey thrown values as errors with
the value as cause. Startup retains its original error.
`apps/controller/src/composition/production.ts:composeProduction` and
`apps/controller/src/composition/development-postgres.ts:composePostgresDevelopment`
own this sequence.

`apps/controller/src/worker/shutdown.ts:closeWorkerComposition` closes the
repository Git sender binding, prepared Git owner, receipt listener, metrics,
and prepared GitHub owner in order despite close failures, then stops the loop
and database. An open listener would hold the Pod until its grace ends.
Failures log `worker.error` with `SHUTDOWN_FAILED` (exit 1). Before the loop owns
an installed Driver package, failed startup closes it whether refused or loaded
and preserves the original error.

`controlPlane.nodeSelector`, when set, places API, worker, migration, bootstrap,
and private proxy on reviewed control-plane nodes.
`deploy/helm/openclaw-enterprise/templates/gateway-routing.yaml` sets
`EnvoyProxy.spec.provider.kubernetes.envoyDeployment.pod`. Compute places tenant
Gateways and Agents.

With `database.caSecretName`, `_helpers.tpl` normalizes relative paths, dot segments,
and trailing slashes to reject CA paths that mask active client mounts. It emits
accepted paths as supplied.

The [shared egress policy](../../deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml)
allows DNS, database egress to `database.cidrs`, and Kubernetes API egress to
`cluster.cidrs` only for release-matched `api`, `worker`, and `initialization` Pods.
Collectors use separate DNS, API, and exporter policy. Unknown or missing component
labels retain default-deny. Before install, initialization has only hook DNS and
database grants. Refresh the required IPv4 `/32` hosts when managed endpoints
change. Leading zeros in chart ports (for example, `0443`) fail validation.

`deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml` renders separate
API-only TCP 443 policies for `api.modelDiscoveryCidrs` and
`api.pluginDiscoveryCidrs`. Both require IPv4 `/32` hosts and default to no egress.
Maintain [model discovery](../reference/console/create-and-deploy.md#create-an-agent) and
[MCP tool discovery](../guides/topics/plugins-configure.md#configure-a-hosted-mcp-plugin)
addresses independently. Console model selection and Harness egress are independent of these policies.

`api.channelDirectoryProxyUrl` passes the approved HTTP(S) proxy to the API and
grants only that Pod egress to the literal IPv4 `/32` and TCP port. The proxy must
allow CONNECT to `slack.com:443`. With the empty default, the chart grants no
proxy egress. Slack directory lookup is unavailable. Enter exact IDs manually.

The Kubernetes Compute Driver checks API server version and authenticated
Namespace access. An invalid version response, unreachable API, or failed
Namespace access fails preflight. Below 1.35, the API logs
`compute.preflight-warning` with both versions and continues.

The worker independently validates production settings, opens the same
application-role database, loads Drivers, validates IAM, and runs Compute
preflight with the same advisory warning. It emits `worker.started` and polls
durable Namespace/AgentRevision work. Readiness requires fresh queue-health observations. Both processes run without
the bootstrap PVC.

`apps/controller/src/composition/installation-config.ts:loadInstallationConfiguration`

With `repository` selected, both processes load the same registry and build
`GitHubRepositoryPolicy`. The GitHub Backend's `drivers.repo` must equal
`repository.id`. Startup refuses the retired Installation `drivers.repo`.
Only native delivery loads `GitHubNativeRepositorySender`'s Unix client and CA
reader. The API starts without control operations or App keys. With prepared
repository Git, the worker reads the App key at startup and exits before readiness
with `PREPARED_GITHUB_APP_KEY_INVALID` if signing fails. The worker owns sessions.
API readiness remains database-backed.

`apps/controller/src/composition/repository-credentials/projected-inputs.ts:prepareProjectedInputs`

Beside the single worker, the optional service pins a projection generation,
copies config/key/TLS/registry inputs to owned private regular files, validates
the selected Backend and exact Service origin, and starts both listeners through
the protected loader. App/TLS private material stays in the service container.
Only the worker gets a projected Kubernetes API token. They share only the
private control volume. The Pod uses `Recreate` with 75 seconds of termination
grace. Readiness needs the service's Unix-listener and worker's queue-health
probes. The worker retries unavailable session operations through its Driver
contract. Neither component has independent high availability. See the
[Agent repository credential flow](agent-repository-credentials.md) for runtime reconciliation.

### 5. Retrieve the key and prove authenticated access

Fresh bootstrap [checks both output paths](../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap) before creating credentials.

`internal/occclient/client.go:Client.GetInstallation`

After Helm readiness, use the approved reader to copy
`initial-admin-service-key.json` from protected bootstrap storage to an
owner-readable file. The completed Job cannot serve it via exec. The API and
worker cannot retrieve it.

Run `occ installation get` with the service key. The Installation's `ID` must
match the key response's `meta.installationId`. The startup Secret annotation
`openclaw.dev/installation-id` binds upgrades to the Installation.

The operator session's `upgrade_installation` checks Helm's deployed revision
and API Pod binding. The scoped `docs/snippets/openshell-quickstart/request.mts`
requires a string path that stays under `/namespaces` after URL normalization,
or a bodyless `GET /installation` to verify the Installation before the patch.
The shell initializes the missing annotation, patches with UID and
`resourceVersion` preconditions, and sets `controlPlane.installationChecksum`.

## Debugging and Verification

- `scripts/prepare-bootstrap-volume` should exit `0` only for a fresh claim with
  no bootstrap output files and UID/GID `1000`, mode `0700` root state.
- `kubectl -n openclaw-system wait --for=condition=complete job/oce-initialization`
  must succeed before API and worker rollout checks.
- `pnpm db:migrate:production --check` reports accepted history without applying
  SQL. For `MIGRATION_HISTORY_UNSUPPORTED`, inspect the database. Initialization
  never repairs the ledger.
- The API emits `listening`; the worker emits `worker.started`, then `worker.health`.
  `listening` reports `startupMs` (since process start) and per-phase `phasesMs`.
- For `KUBERNETES_VERSION_BELOW_MINIMUM`, upgrade Kubernetes to 1.35 or later.
- `startup-error` or `worker.startup-error` with code
  `KUBERNETES_API_UNAVAILABLE`: Compute cannot reach Kubernetes at the logged
  `host` and `port`. Check `cluster.cidrs` and `cluster.port`; restarted
  clusters can move it.
- Code `PRESET_FILE_INVALID`: an invalid `presets.files` entry or file.
- `DRIVER_CONFIGURATION_INVALID`: inspect `details` (JSON Pointer, code, message).
  `/runtime/gatewayStorageClassName` requires a Kubernetes DNS-subdomain name.
  `apps/controller/src/api-startup.ts:startupFailureFields` passes these diagnostics
  to `server.mjs`.
- `kubectl -n openclaw-system logs job/oce-initialization -c bootstrap` is the
  first check for unsafe output storage, existing outputs, database-role
  failures, auth errors (`AUTH_SECRET_INVALID`, `AUTH_BASE_URL_INVALID`), and
  administrator/IAM mismatch.
- Changing an external startup Secret alone does not restart the API or worker;
  run an explicit rollout and repeat readiness plus authenticated proof.
- `tests/integration/production-kubernetes-packaging.test.mjs` renders the
  chart; it does not prove deployment or model execution.
- `tests/integration/installation-handoff-k3d-real.test.ts` exercises the CLI with
  rendered Jobs, named-Job RBAC, and replacement UIDs. Suspended Jobs skip
  migration/bootstrap. See [Kubernetes tests](../testing/kubernetes.md).

## Related docs

- [Deployment guide: production](../guides/deploy.md#production)
- [Settings reference](../reference/settings.md)
- [Kubernetes Compute Driver](../reference/drivers/kubernetes-compute.md)
- [Backend-managed credential delivery](service-account-driver-credential-delivery.md)
- [Repository credential setup](../guides/repository-credentials.md)
- [Controller worker execution flow](controller-worker.md)
- [Production TUI flow](production-tui.md)
- [Local password authentication flow](local-password-authentication.md)
- [Authoritative platform design](../design.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-17 07:27: Condense startup trace prose. (authoring-run/91a0ae5f-d349-46da-9b68-38b12dad3187 - 26a24253e44403469837e5d41674d721495509f5)

- 2026-11-16 09:47: Document the request helper’s scoped path validation. (authoring-run/04994f45-a986-442f-8747-1595e124325f - b4a03d909a2815bbf6c44eb6e195d4503a59fe70)

- 2026-11-14 17:11: Identify the generated API CA programs and link their TypeScript source layout. (authoring-run/6b781d32-d772-4aed-beb9-1598b28632b4 - 4ecdd59c5a64f217f0b7fafdf7a034e74b890ffc)

- 2026-11-14 12:25: Document the TypeScript worker probe. (authoring-run/1be06605-515e-4261-8b21-d0d796809916 - f0bfd8b1834a7a07fc008fa822fed9035f12ffbe)

- 2026-11-13 19:24: Validate auth. (authoring-run/e8f36db7-807b-453f-8274-f89ca52fcb7c - 795a920ef266c1246d7774ceb0188a0ee206fe17)

- 2026-11-13: Document the opt-in check of an existing Installation and its bootstrap administrator. (authoring-run/b1c2409a-da5e-4236-9fd6-3e89f1773b94 - 3c8ee8b97066d1e82a4ba9f95ad6d6f6afea5df8)

- 2026-11-12 21:23: Preserve metrics admission and migration history guidance in the merged startup flow. (authoring-run/9f8b5513-b8e6-4dfc-a9d6-6166d530a714 - 32d85576e6ffa0e42af6357e39d5856b8a669921)

- 2026-11-12 09:45: Skip completed writable DDL; preserve read-only refusal. (authoring-run/eedb034b-cdad-4526-af11-0ce3490e267a - 11e22a5dc95b54a4fd7eb05e68a06f732033e7f8)

- 2026-11-12 08:08: Preserve metrics admission while incorporating current startup guidance. (authoring-run/55f350ab-6738-4e2d-9a2b-fb3a3f02ad26 - 818e0a96ef7c7dca60dffb8b7209a0ae36745fcb)

- 2026-11-12 06:35: Document static Helm template refusal guidance without changing recovery. (authoring-run/da0f3f3f-c550-48b6-8ef4-60e3f2d1b973 - 64358aae61847dea8a3834fbe06bed079b5727cc)

- 2026-11-11 17:55: Release metrics sockets. (authoring-run/ba89e4f8-7809-490b-b98f-c8032300a4c1 - 755ebc38280f84b3ec420cc0b2a475ed1fb2be0a)

- 2026-11-11 17:38: Count implicit metrics responses. (authoring-run/36f5ccfa-01c1-4cdb-b694-2692e3715fd6 - 755ebc38280f84b3ec420cc0b2a475ed1fb2be0a)

- 2026-11-11 17:15: Bound metrics pipelines. (authoring-run/bec1d5fe-2f91-4072-a8ee-b716656390ef - 755ebc38280f84b3ec420cc0b2a475ed1fb2be0a)

- 2026-11-11 17:05: Coalesce database readiness. (authoring-run/89773c17-5c87-4c2d-aa19-3b5a0af84b68 - 755ebc38280f84b3ec420cc0b2a475ed1fb2be0a)

- 2026-11-11 15:06: Preserve explicit PostgreSQL caller options after URL parsing. (authoring-run/8367ab20-ba98-4ec6-9700-296442c6eb96 - ee419a1969d414d4aa934c59b39b868e8777b127)

- 2026-11-07 21:10: Stop install dispatch on intent output failure and return final report write errors. (authoring-run/f573af51-9766-49f8-88ff-2c6294283466 - 9b23338c49448b9fc56d637a53bd0d71ec3be76b)

- 2026-11-08 07:15: Clarify receipt directory. (authoring-run/ef34e45f-633b-49fb-8884-cdf519ed7d40 - 7e2eb23a7f55b5f375e52883fcb6a7bb0f10049e)

- 2026-11-08 05:16: Document the preserved intent and stop before dispatch when the receipt notice write fails. (authoring-run/5809b7e1-70ee-4446-8c3a-020e78a0e7af - e0d329d9ad9560e954ce94889079ef55ba43080f)

- 2026-11-04 23:30: Check complete handoff reports, including receipt outcomes. (authoring-run/48787d5f-913a-4fa5-910a-2f9ec35e504a - ce06d47cfb0b4fb29495ad4bc85bb71aa5941975)

- 2026-11-04 23:14: Document report write failures. (authoring-run/58196aeb-45b5-4ea5-850d-e368b48f15f9 - 582236adfbbb392c2247995dde054eef929ca6c1)

[Production startup documentation history](production-startup/history.md) preserves the older dated entries.
