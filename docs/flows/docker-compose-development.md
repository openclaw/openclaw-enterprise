---
created: 2026-08-24
updated: 2026-10-09
last_updated_session: authoring-run/3980117d-b11c-47c0-9f7a-765c1481ee7b
---

# Compose development flow

## Overview

`./bin/occ dev up` starts local OpenClaw Enterprise development from a checkout.
The `scripts/dev-up` entry point selects the same profile. By default OCC and
PostgreSQL run in Compose with Docker Compute. Operators can explicitly select
Kubernetes Compute with either the Compose control plane or the
[local k3d-only profile](../guides/deploy/local-kubernetes-development.md). The
Kubernetes profile can select the OpenShell Sandbox Driver for its fail-closed
path; it prepares pinned OpenShell infrastructure and reconciles rendered
workspace-chart resources before reporting readiness.
Compose-backed profiles perform host preflight, select Docker Engine or Podman,
prepare runtime images, start Compose, and wait for PostgreSQL migration,
Installation bootstrap, API health, and worker readiness. The Kubernetes-only
profile performs the equivalent readiness checks inside its owned cluster.
Startup proves authenticated Installation access with a protected local
bootstrap service key; it does not create an Agent or prove model execution.

For Docker Compute, the worker can reconcile Namespace infrastructure, but
Agent deployment stops at harness authentication admission because Docker
Compute rejects bindings. Kubernetes Agent execution continues through the
selected Kubernetes Compute Driver and the
[authenticated Agent deployment procedure](../guides/deploy/production-agents.md).

## Entry Points

- Trigger: `./bin/occ dev up [--key-output PATH] [-- COMPOSE_GLOBAL_OPTIONS...]`
  from the repository root, followed by authenticated Namespace operations.
- Source: `scripts/dev-up:require_command`, `internal/occdev/up.go:Up`, and
  `internal/occdev/openshell.go:prepareOpenShell`.
- Assumptions: Docker Engine with Compose, or Podman with `podman-compose`;
  Bash, curl, Python 3, and `yq` v4 for the Docker profile; writable PostgreSQL
  and Configuration volumes; loopback API publication; executable `bin/occ`
  built with `pnpm cli:build`. Startup needs no model credential.

The Kubernetes profile additionally uses `compose.kubernetes.yaml`,
`internal/occdev`, k3d, and kubectl. `./bin/occ dev down` owns profile cleanup;
`scripts/dev-down` dispatches to it. The local Kubernetes development guide
owns the operator procedure and destructive cleanup boundary.

## Flow

```mermaid
graph TD
  A["./bin/occ dev up"] --> Profile{"Compute profile"}
  Profile -->|Docker| B["Preflight host tools, resolve Podman machine connection,<br/>and inspect Compose config"]
  Profile -->|Kubernetes| KPre["Pin local engine endpoint<br/>and reject existing resources"]
  KPre --> KControl{"Control-plane profile"}
  KControl -->|Kubernetes| KOwned["Create owned cluster,<br/>verify DNS/API and select kubeconfig"]
  KOwned --> KDriver{"Sandbox Driver"}
  KDriver -->|none| KCodex["Import runtime and verify<br/>the normal Codex sandbox"]
  KCodex -->|success| KRoutingFirst["Install routing controllers<br/>and remaining images"]
  KCodex -->|failure| KRollback
  KDriver -->|OpenShell| KOpenFirst["Prepare OpenShell assets,<br/>install routing, then import runtime"]
  KRoutingFirst --> KOnly["Install selected control-plane profile<br/>and retain all readiness gates"]
  KOpenFirst --> KOnly
  KOnly --> KWorkspace
  KControl -->|Compose| KConfig["Validate Compose and claim<br/>private state with snapshot"]
  KConfig --> KStart["Bootstrap OCC and create<br/>the owned k3d cluster"]
  KStart --> KReady["Import runtime and start<br/>API and Kubernetes worker"]
  KReady --> KSandbox{"Sandbox profile"}
  KSandbox -->|none| KProof
  KSandbox -->|OpenShell| KOpenShell["Install pinned Agent Sandbox, RuntimeClass,<br/>Gateway, and render workspace resources"]
  KOpenShell -->|Compose| KRouting["Install private Envoy route and project<br/>its service key and public CA"]
  KRouting --> KWorkspace["Driver applies workspace resources and creates<br/>the default Namespace's owned Workspace"]
  KOpenShell -->|Kubernetes| KWorkspace
  KWorkspace --> KFailClosed["Default Namespace ready;<br/>Agent projection remains fail closed"]
  KFailClosed --> KProof
  KProof["Prove authenticated<br/>Installation access"]
  KProof --> KDown["./bin/occ dev down reuses<br/>recorded endpoint and project"]
  KStart -->|failure| KRollback["Roll back owned resources<br/>retain state if cleanup fails"]
  KReady -->|failure| KRollback
  KProof -->|failure| KRollback
  KDown --> KRemove["Stop reconcilers and delete<br/>owned cluster and volumes"]
  KRemove -->|success| KDone["Remove private state"]
  KRemove -->|failure| KRetain["Keep state for recovery"]
  B --> C["Select quickstart runtime image or validate custom images"]
  C --> D["Selected Compose starts PostgreSQL, migrate, bootstrap, API, and worker"]
  D --> E["Copy bootstrap service-key response to private local file"]
  E --> F["./bin/occ installation get proves authenticated access"]
  F --> G["Operator creates Namespace through authenticated API"]
  G --> H["Worker claims durable Namespace operation"]
  H --> I["Docker Driver ensures owned tenant network"]
  I --> J["Namespace becomes ready"]
  F --> K["Operator requests Agent deployment on Docker Compute"]
  K --> L["Admission rejects missing or unsupported harness binding"]
  J --> M["Authorized deletion removes owned Namespace resources"]
  D -->|operator cleanup| CDown["occ dev down keeps<br/>selected engine connection"]
  M --> CDown
  CDown --> CVolumes{"--volumes?"}
  CVolumes -->|No| CKeep["Remove Compose containers and network;<br/>retain named volumes"]
  CVolumes -->|Yes| CDelete["Remove Compose containers,<br/>network and named volumes"]
```

## Execution Trace

### 1. Start and initialize the local stack

`scripts/dev-up`, `apps/controller/src/server.mjs:start`

[Docker or Podman Compose startup](docker-compose-development/startup.md) owns
engine selection, database initialization, local API admission and worker startup.

### 2. Prepare Namespace infrastructure and enforce Agent admission

`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver`

[Namespace execution and Agent admission](docker-compose-development/agent-execution.md)
traces API authorization, durable work, tenant network ownership, unsupported
Agent authentication and exact resource removal.

### 3. Clean up Docker or Podman Compose

`internal/occdev/down.go:Down`, `internal/occdev/down.go:podmanComposeArgs`

`occ dev down` uses the selected engine and forwarded Compose project and file
options, including after partial startup. Podman retains the caller's selected
connection. Its reported API socket supplies `OCC_CONTAINER_ENGINE_SOCKET` only
to resolve the worker mount; a socket inside a macOS VM is not substituted for
the host connection. An unavailable engine or invalid socket fails cleanup.

Compose removes its project containers and network. Named database,
Configuration, and bootstrap volumes remain unless `--volumes` is explicit.
Agent-owned containers and Namespace networks remain the responsibility of
their platform deletion workflows; follow [safe development shutdown](../guides/deploy/local-operations.md#stop-development-safely).

### 4. Start and clean up Kubernetes development

`internal/occdev/up.go:Up`, `internal/occdev/down.go:Down`.

[The Kubernetes startup and cleanup trace](docker-compose-development/startup.md#12-select-kubernetes-development-and-preserve-cleanup-ownership)
follows profile selection, the private Compose snapshot, k3d creation, runtime
import, authenticated readiness, and cleanup through the recorded engine.

For the Kubernetes-only profile, `internal/occdev/openshell_k3d.go:upK3d`
creates the owned cluster, checks node DNS, and writes and selects its kubeconfig.
With Sandbox Driver `none`, it then imports the runtime image and runs
`prepareDevelopmentCodexSandbox` before installing private routing controllers.
A sandbox refusal rolls back the owned cluster before controller or PostgreSQL
image imports, Installation setup, or credential delivery. OpenShell retains its
preparation, routing-controller installation, then runtime-import order. Both
paths retain the later network-isolation and authenticated readiness gates.

`internal/occdev/kubernetes.go:importDevelopmentImage` exports each selected
image to a temporary archive, selecting its Linux platform explicitly on Docker.
`internal/occdev/k3d_import.go:importArchiveDirect` streams that archive into
k3d; only its known closed-stream race receives bounded retries. The launcher
then resolves the imported digest from containerd, rejects missing or ambiguous
results, and removes the archive. Tagged local builds use this same path.

### 5. Prepare the optional OpenShell development profile

`internal/occdev/openshell_k3d.go:upK3d`,
`internal/occdev/openshell.go:prepareOpenShell`,
`apps/controller/src/drivers/sandbox/openshell.ts:ensureNamespace`

With `OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes`, OpenShell uses the
Kubernetes-only lifecycle before Compose rendering. It pins K3s and OpenShell
inputs, installs PostgreSQL, OCE, and one central Gateway in `oce-system`, and
publishes only an admitted API proxy on host loopback.

By default, the Kubernetes lifecycle starts PostgreSQL, migration, bootstrap,
the API, and the worker in Compose. It installs the central Gateway in
`openshell-system` and exposes its fixed NodePort only to the owned container
network. Before starting the API and worker, the launcher installs pinned
cert-manager and Envoy Gateway controllers, renders only the Helm-owned private
routing resources, and copies the generated public CA and a dedicated service
key into the private state directory. The Installation uses the k3d node name
and Envoy HTTPS NodePort. After Compose starts, the launcher reapplies Envoy
ingress with the controller, Kubernetes worker, and k3d node `/32` addresses.
In both modes, the worker
creates the bootstrap Namespace through the regular Compute workflow. The
Sandbox Driver applies rendered workspace resources and the operator label
before creating the corresponding Gateway Workspace. Startup waits until the
OCC Namespace becomes ready. See the
[OpenShell flow](openshell-sandbox-provisioning.md#0-create-the-development-control-plane).

## Debugging and Verification

- `./scripts/dev-up` should show PostgreSQL readiness, migration completion,
  API listening on `127.0.0.1:${OPENCLAW_DEV_PORT:-3000}`,
  fresh-database initialization, `worker.started` with `computeDriverId` set to
  `compute-docker-development`, a private copied service-key path, and a
  successful authenticated `/installation` proof.
- With `OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes`, startup should instead
  report Kubernetes Compute, a private kubeconfig, and the disposable k3d
  context; it does not mount the engine socket into the Kubernetes worker.
- With `OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell` and
  `OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes`, startup should also report
  Kubernetes-only deployment, one ready `oce-system/openshell-gateway` Service, the
  `openshell-sandbox` RuntimeClass, the Agent Sandbox CRD, and workspace
  resources in the bootstrap Namespace. The selected real dev-up case also
  reads the owned Workspace through the Gateway API. This proves infrastructure
  readiness, not a model turn. The expected Agent result is the explicit
  unsupported `secretKeyRef` projection failure with no Sandbox or Agent Pod.
- With the default Compose control plane, OpenShell startup should report
  `Control plane: Compose`, retain a private Compose snapshot, install the
  Gateway in `openshell-system`, program
  `oce-system/openclaw-enterprise-agent-gateways`, and create the bootstrap
  Namespace's operator-mode Workspace. `installation.yaml` must contain the
  Envoy NodePort endpoint, while only the controller and `worker-kubernetes`
  receive `gateway-api-key` and `gateway-ca.crt` mounts.
- Docker Compute on Podman startup verification should show Podman as the
  selected engine, mount only its reported API socket into the worker, and
  complete the same authenticated Installation proof without a `docker` alias.
  The [startup flow](docker-compose-development/startup.md) documents the macOS
  prerequisite.
- `<engine> network ls --filter label=org.openclaw.enterprise.compute-driver=docker`
  should show the owned network for a ready development Namespace.
- Docker Compute Agent deployment must reject a missing or unsupported harness binding before
  workload creation. A worker `OPENAI_API_KEY` cannot make it supported.
- Retained Docker/Podman model suites currently cannot pass through this admission
  boundary. See [Docker test status](../testing/docker.md); old model-turn evidence
  does not establish current support.
- Namespace deletion removes its owned resources while preserving unrelated ones.
- The [real Compose cleanup case](../testing/docker.md#verify-compose-cleanup)
  verifies the compiled CLI against a partially started project, including volume
  retention and explicit deletion on the selected engine connection.

## Related docs

- [Development and production deployment](../guides/deploy.md)
- [Local Kubernetes development](../guides/deploy/local-kubernetes-development.md)
- [Quickstart](../guides/quickstart.md)
- [Docker Compute Driver](../reference/drivers/docker-compute.md)
- [Kubernetes Agent deployment and TUI](../guides/deploy/production-agents.md)
- [Controller worker flow](controller-worker.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-09 19:04: Import tagged development images through the platform-selected archive path and retain digest verification. (authoring-run/3980117d-b11c-47c0-9f7a-765c1481ee7b - 6d0bb202d97f487cbd5e41d64e0f1f5ab196d083)

- 2026-10-09 03:27: Run the unchanged Codex sandbox preflight before routing for the Kubernetes-only none profile; preserve OpenShell ordering and later readiness checks. (authoring-run/ec403753-6547-4dcb-8624-26628a124b7d - 259702d92a9ebb094c5f9bea0465bd6b09681d08)

- 2026-10-01 16:58: Added automatic private Envoy routing for the Compose-backed OpenShell profile. (authoring-run/53c6746c-9551-4f70-9d1f-e0540ce29868 - 987c8c2b4ace1e152262ef6920b6d0f9ff26a086)

- 2026-09-28 00:34: Restored Compose as the default control plane and made Kubernetes-only startup explicit. (01a0e441-02f9-70b2-ad45-0a1a5049954a - 201f31d511464133f06e0526bb5545ed1cb27e25)

- 2026-09-25 12:23: Added the selectable Compose control-plane path for Kubernetes Compute with OpenShell while retaining the Kubernetes-only default. (authoring-run/a81f3e71-1c8e-4692-8e2e-d462ddacc10b - 64ab72aed5c4926e4a2080ade91d785e531801a2)

- 2026-09-23 20:46: Allow an explicit K3s node image for local startup when channel discovery is unavailable; retain the default 1.35 channel. (pr-337 - 8adfd86e96a10a9d06761bc78e385eafd6bf2760)

- 2026-09-23 01:52: Moved workspace-chart reconciliation from a bootstrap-only Helm release into the operator-mode Sandbox Driver Namespace lifecycle. (authoring-run/dc7a0b75-945c-4091-8600-eb919ad138dd - fbaf3e2dfeccbcf2815327d7d5a9aa6643a26cf2)

- 2026-09-23 01:11: Documented the deployment Gateway, operator Workspace creation, and bootstrap workspace chart in the OpenShell development profile. (authoring-run/955359e5-5631-48e4-acc1-a5e32b9ade00 - fbaf3e2dfeccbcf2815327d7d5a9aa6643a26cf2)

- 2026-09-22 18:36: Added the optional OpenShell Kubernetes development profile, namespace-local Helm readiness, and the supported fail-closed Agent boundary. (authoring-run/e7b89de2-9e58-4849-b078-791560cc5d58 - fbaf3e2dfeccbcf2815327d7d5a9aa6643a26cf2)

- 2026-09-17 17:42: Pin Kubernetes development to the supported 1.35 family and emit only runtime settings accepted by the current Kubernetes Compute Driver schema. (authoring-run/b044b43c-e713-4006-93a0-c129cdf5578e - 9310d5b025e84f885e4f7facae2e2906b50d58f8)

- 2026-09-17 16:21: Preserve Podman's host connection during Compose cleanup and verify explicit volume deletion with the real CLI and engine. (authoring-run/566921ff-3342-4dec-aa19-110acc8aa1e4 - 58ead9943ee6b2560eea2c327967b50a30f7644e)

- 2026-09-17 16:47: Merge current main's Podman dedicated recovery proof and checkout-local CLI requirement while preserving the Kubernetes lifecycle trace. (01a0ae15-3bad-7d92-92b7-f8be208cbb49 - b13b2f479f824891ab3c5bf71e6851d704dba458)

- 2026-09-17 14:32: Resolve the effective macOS Podman machine connection, trust its private gateway only for rootful Compose, and retain bridge-CIDR admission for rootless Compose. (authoring-run/07150374-b371-440a-92f7-9d53dedb9512 - 309c5c38702d026e09df703d7e79c2c9eb2d570c)

- 2026-09-17 06:42: Trace the accompanying Go CLI development lifecycle, Kubernetes startup and cleanup ownership, and retained Docker startup path. (01a0ae15-3bad-7d92-92b7-f8be208cbb49 - 14ad14c04deeeaa79f325b14d492ab13730adc7f)

- 2026-09-17 00:48: Correct current harness admission and metadata-only dispatch boundaries after implementation review. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - 107900e9551b90c3e9ac24d30f8ea866f17e5dbb)

- 2026-09-09: Added automatic Podman selection, API socket delivery, Podman
  status and bootstrap-copy handling, and the Docker-only Fluentd and Agent
  runtime verification boundaries while retaining the Docker Compose path.

- 2026-09-01 22:09: Document explicit runtime image rebuilding and link packaged-plugin and Codex compatibility checks. (01a05f89-ff1c-7643-a77f-7e1e3aed9e5f - 5fa47a6)

- 2026-09-01 19:09: Merge the development startup trace into the canonical Docker Compose flow and clarify the `dev-up` readiness proof versus later API deployment and TUI attachment. (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-08-31 20:33: Trace the shared installation initializer, startup ordering, and initializer-owned credential delivery. (01a05a3d-526f-7553-8cd8-070bd1847acb - b6f213cbcee11ba3dd69886c936c7e5abe233eb3)

- 2026-08-31 19:14: Document bootstrap service-key API access and operator credential cleanup for the TUI path. (codex/01a05a3d-526f-7553-8cd8-070bd1847acb - 06c4bccb95543d3d545d011e72074f805f339aa8)

- 2026-08-31 17:45: Align bootstrap identity and protected service-key storage with the current startup path. (codex/01a05a69-3fbe-7441-9e6d-20394758cf94 - 0797098646028ac00cb26cd4afcbc9b2cf8bcb24)
- 2026-08-31 15:40: Added the compact development TUI runtime trace and two-turn verification boundary. (01a059f9-e5cc-7b01-9479-0c5087f5e58f - 3a04cee)
- 2026-08-28 17:54: Clarified the Docker workload execution boundary and linked operator setup, quickstart, and worker traces. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
- 2026-08-25 10:13: Removed the deleted bootstrap sidecar/script from the Compose flow and documented controller-owned fresh-database self-bootstrap. (01a03630-cd9f-7352-9e64-1d30de98c7dd - c56867448b187304723d20043dd5a0e184736ef2)
- 2026-08-25 08:46: Clarified that Docker E2E verification may invoke gateways through Namespace networking or published loopback ports. (01a03630-cd9f-7352-9e64-1d30de98c7dd - 949e57ba008486c7ad60978df79dc53cce31bee9)
- 2026-08-24 22:43: Added API-only filesystem Configuration Driver volume boundaries and removed stale Docker subnet knobs. (01a03630-cd9f-7352-9e64-1d30de98c7dd - 63890cf94cfc15f848f62f8f957eb766d2101f55)
- 2026-08-24 21:40: Documented Docker Compose development startup and Docker Compute Driver runtime flow. (01a03630-cd9f-7352-9e64-1d30de98c7dd - 63890cf94cfc15f848f62f8f957eb766d2101f55)
