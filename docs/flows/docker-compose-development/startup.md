---
created: 2026-09-09
updated: 2026-10-09
last_updated_session: authoring-run/c12130ba-3173-4831-86e9-5a209d16d630
---

# Compose development startup

[Compose development flow](../docker-compose-development.md).

## Overview

`scripts/dev-up` starts Docker or Kubernetes Compute. Compose-backed profiles run
PostgreSQL, migration, bootstrap, API, and worker in Compose; the Kubernetes-only
profile runs them in the owned k3d cluster. Startup requires authenticated
Installation and bootstrap Namespace readiness, plus Workspace readiness for OpenShell.

## Entry Points

- Trigger: `./scripts/dev-up [--key-output PATH] [-- COMPOSE_GLOBAL_OPTIONS...]`.
- Source: `scripts/dev-up:require_command`
- Source: `internal/occdev/up.go:Up`
- Source: `internal/occdev/openshell_k3d.go:upK3d`
- Assumptions: the checkout-local OCC CLI is built; the selected container
  engine is running; Kubernetes profiles also have k3d, kubectl, and, on Podman, root or a
  [rootful machine](../../guides/deploy/local-kubernetes-development.md#start-the-profile); Kubernetes-only and OpenShell
  profiles require Helm, and OpenShell requires its pinned or selected assets.

## Flow

```mermaid
graph TD
  A["<b>Start development</b><br/>scripts/dev-up"] --> B{"<b>Compute Driver</b><br/>Docker or Kubernetes"}
  B -- "Docker" --> C["<b>Render Compose</b><br/>Validate publications"]
  B -- "Kubernetes" --> D{"<b>Control plane</b><br/>Compose or Kubernetes"}
  D -- "Kubernetes" --> E["<b>Owned k3d stack</b><br/>PostgreSQL and OCE"]
  D -- "Compose" --> F["<b>Hybrid stack</b><br/>Compose OCC and k3d Compute"]
  C --> G["<b>Prove Installation</b><br/>Authenticated service key"]
  F --> R["<b>Resolve Pod proxy source</b><br/>Bound bridge-route queries"]
  E --> R
  R -- "Validated cni0 source" --> G
  R -- "Deadline or query failure" --> X["<b>Fail startup</b><br/>Skip Installation writing"]
  F -- "OpenShell" --> H["<b>Own Workspace</b><br/>OpenShell operator mode"]
  E -- "OpenShell" --> H
  G -- "Password-only" --> I["<b>Record cleanup</b><br/>Exact engine and resources"]
  G -- "Canceled" --> J["<b>Fail startup</b><br/>Clean owned resources"]
  H --> I
  E -- "Optional Keycloak profile" --> K["Provision Keycloak, TLS and Pod DNS"]
  K --> G
  G -- "Keycloak ready" --> L["Second Helm pass: OIDC and recovery-only passwords"]
  L --> M["Attach Alice to the existing administrator"]
  M --> I
```

## Execution trace

### 1. scripts/dev-up: host preflight and runtime image selection

`scripts/dev-up:require_command`, `internal/occdev/up.go:Up`,
`internal/occdev/compose.go:AnalyzeCompose`,
`deploy/runtime/Dockerfile`

`bin/occ` (`pnpm cli:build`) is required; arguments after `--` go to Compose. For Kubernetes Compute, required by OpenShell, see
[step 12](#12-select-kubernetes-development-and-preserve-cleanup-ownership).
Without a Sandbox Driver, Compose Kubernetes startup requires Node before creating resources.

Docker Compute probes Engine and Compose JSON support. Failure selects `podman`;
a `docker` compatibility alias is neither required nor sufficient. For Podman, the helper requires
`yq` major v4 and pins the selected standalone `podman-compose` provider path
so status and stopped one-shot containers stay consistent.

Docker Compose supplies resolved JSON; `dev-up` converts Podman Compose YAML to
JSON in a private temporary directory. `./bin/occ dev analyze-compose` enforces
loopback controller and database publications and resolves Docker runtime image
selection. The helper appends `compose.podman.yaml` last so the worker receives
Podman's reported API socket at `/var/run/docker.sock`. The base Docker Compute
worker disables SELinux process labeling because relabeling a host engine socket
is unsafe; other services retain SELinux confinement. One development image
covers migration, bootstrap, API, and worker, so `dev-up` builds it once through
migration and starts with `--no-build`; Docker uses `up --build`. Expanded
configuration and credentials are never printed.

Without shared runtime or separate gateway/Agent images, the helper selects
`openclaw-enterprise-runtime:quickstart`, building it from `deploy/runtime/Dockerfile`
with repository-root context only if missing. Custom images must exist;
incomplete selection fails. Existing tags survive recipe changes;
[rebuild and verify the image](../../../deploy/runtime/README.md#rebuild-an-existing-image)
for package changes. The runtime recipe owns channel plugins and gateway/Codex
compatibility; `dev-up` neither installs missing plugins nor verifies model turns.

### 2. compose.yaml:services.postgres and services.migrate

`compose.yaml:services.postgres`, `compose.yaml:services.migrate`

Compose starts PostgreSQL with the local `occ_postgres_data` volume. Local-only
administrator credentials initialize the database; checked-in SQL creates the
less-privileged `occ_migrator` and `occ_app` roles.

Through Compose, `dev-up` runs migration after PostgreSQL, using
`OCC_MIGRATION_DATABASE_URL` and Drizzle. API and worker never use the migrator
or PostgreSQL administrator URL.

### 3. Initialize before starting the API or worker

`compose.yaml:services.bootstrap`, `scripts/bootstrap-installation.mjs`

After migration exits `0`, bootstrap creates administrators, Installation, native
IAM, audit evidence, service key, and a `provisioning` default Namespace. The
worker provisions its Docker boundary. Existing Installation state is preserved;
missing, expired, or revoked keys never trigger reissue.

Only the initializer mounts `occ_bootstrap_data`; the API and worker load
committed state after initializer success. The
[bootstrap flow](../local-password-authentication.md) owns credentials, concurrent
attempts, and failure recovery.

### 4. The API admits only local development traffic

`apps/controller/src/server.mjs:start`,
`apps/controller/src/composition/development-postgres.ts:composePostgresDevelopment`,
`apps/controller/src/drivers/configuration/filesystem/index.ts:FilesystemConfigurationDriver`

The API starts in `NODE_ENV=development`, binds inside the Compose network, and
publishes its host port only on `127.0.0.1`. `OCC_AUTH_SECRET` signs user
sessions and `OCC_AUTH_BASE_URL` fixes the cookie origin. The API and initializer
accept HTTP(S) origins on `localhost`, `127.0.0.1`, or `[::1]` in development.

Development accepts the explicitly configured Compose bridge CIDR as local
control-plane traffic, while non-loopback clients, forwarded headers,
caller-supplied identity headers, bearer credentials, and trusted-proxy claims
remain rejected.

After the controller health check, `dev-up` waits for the worker readiness
probe, then copies initializer-owned service-key JSON from the stopped bootstrap
container; Docker uses `compose cp`. `podman-compose` has no `cp`, so the helper
selects the one scoped bootstrap container from Compose status labels and runs
`podman cp` by ID. `--key-output` must name an absent file in a private
operator-owned directory; otherwise the helper creates a private temporary
directory. It never overwrites an existing file, prints `data.key`, or reruns
bootstrap to replace a missing key.

`dev-up` then reads the Installation with `./bin/occ installation get` and the
copied key. `apps/controller/src/auth/index.ts:ControllerAdmissionVerifier.verify`
maps the `x-api-key` to the Installation-scoped service administrator. Startup requires the returned resource ID to match the copied key response's `meta.installationId`. The
[service-key flow](../service-api-keys.md#3-verify-the-credential-and-enforce-its-fixed-identity-scope)
owns admission and `401` rejection without cookie fallback; current IAM policy
still authorizes each resource operation.

When `OCC_CONFIG_PATH` is absent, PostgreSQL-backed development selects the
filesystem Configuration Driver from `OCC_DEVELOPMENT_CONFIGURATION_ROOT`.
Compose sets that root to `/app/.development/configurations` and backs it with
the `occ_configuration_data` named volume, mounted only into the controller.
PostgreSQL remains the OCC metadata system of record.

### 5. The worker selects Docker compute and claims durable work

`apps/controller/src/worker.mjs:configuration`,
`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver.preflight`,
`apps/controller/src/drivers/compute/docker/index.ts:DockerComputeDriver.request`

After the controller is healthy, the worker starts with the same
application-role `OCC_DATABASE_URL`. Without `OCC_CONFIG_PATH`, development
selects `compute-docker-development` with implementation `docker-local`;
otherwise it uses the trusted Driver set in that file.

Before its database pool, preflight runs engine ping, version, and image checks. Response-stream errors reject interrupted requests under the existing 10-second deadline and claim-owned cancellation, with no automatic retry; complete responses keep status and JSON validation.

The worker loads the singleton Installation, validates persisted IAM policy,
and polls the PostgreSQL work queue. Readiness means it can claim durable work, not that an Agent, AgentRevision, or TUI exists. Each claimed operation
reauthorizes the original actor before calling Compute. The worker is the only
Compose service with Docker-compatible engine access.

<span id="default-kubernetes-only-startup"></span>

### Kubernetes-only startup

`internal/occdev/openshell_k3d.go:upK3d`,
`internal/occdev/gateway_k3d.go:installDevelopmentRoutingControllers`,
`internal/occdev/repository_k3d.go:enableDevelopmentRepository`.

Before tools or state creation, `upK3d` requires a control-plane Namespace DNS label
of at most 63 characters. Cleanup accepts longer historical names but retains all
ownership checks and deletes only the recorded cluster through its recorded endpoint.

Both k3d profiles use legacy iptables and honor an explicit IPv4 node resolver
without changing host DNS.
Linux Docker's automatic host resolver selection ignores trailing nameserver
fields, matching glibc parsing.
`internal/occdev/node_dns_k3d.go:checkDevelopmentNodeDNS` fails startup on
refused node DNS. Kubernetes-only startup imports matching OCE images into the
cluster.

Without OpenShell, it verifies the pinned cert-manager and Envoy Gateway
manifests, waits for the k3s-owned Gateway API CRDs, then installs Envoy,
printing k3s add-on status before rollback on failure.
`internal/occdev/gateway_k3d.go:waitDevelopmentCRDEstablished` polls each CRD
each second until `Established`, stopping on a `kubectl` error or startup
timeout. Before gateway proxy trust,
`internal/occdev/network_k3d.go:verifyDevelopmentNetworkPolicy` checks allowed
and denied Pod traffic with credential-free Pods and a temporary policy, then
rechecks Driver policies after bootstrap creates the initial gateway Namespace.
Probe Pods use short grace periods and UID-preconditioned deletes. Cleanup waits
for selector-matching Pods before removing their egress policy; probe or cleanup
failure fails startup. Checks are point-in-time and single-node.

Before writing the Installation, `scripts/prepare-development-codex-seccomp.mjs`
probes the imported runtime in a credential-free Pod on the owned node. If
`RuntimeDefault` blocks the sandbox, the shared reviewed generator derives a
content-addressed Localhost profile from the node's policy and verifies it for
dedicated Codex containers; failure rolls back the owned cluster. The
[local Kubernetes guide](../../guides/deploy/local-kubernetes-development.md#start-the-profile)
owns the verified boundaries and provenance.

Startup waits for the Gateway, certificate, and proxy Pods before reporting
success. Envoy source addresses must fall inside the selected node's Pod CIDR;
the tenant ingress policy must still admit only the Gateway's exact proxy peer.

Loopback HTTPS uses a per-installation CA whose leaf covers only its console
and Agent hosts. API and browser NodePorts publish only on host loopback; the CA
key stays private. `internal/occdev/openshell_k3d.go:upK3d` prints
[required browser trust instructions](../../guides/operate/troubleshooting.md#the-local-console-reports-a-certificate-error)
beside the URL and public CA path. Stack readiness does not establish browser trust.

### 12. Select Kubernetes development and preserve cleanup ownership

`internal/occdev/command.go:selectEngine`,
`internal/occdev/command.go:pinEndpoint`,
`internal/occdev/command.go:podmanEndpoint`,
`internal/occdev/up.go:Up`.

Without a Sandbox Driver, Kubernetes startup selects Docker or Podman and
resolves its host socket from Docker's active context or `podman machine inspect`.
Private state records the socket, Compose project, and `occ-dev-*` cluster.
Cleanup validates and reuses those records, regardless of later context changes.

Startup refuses existing cluster or project resources, validates resolved Compose
publications with `internal/occdev/compose.go:AnalyzeCompose`, and rejects
external or unscoped networks and volumes with
`internal/occdev/up.go:validateResourceOwnership`. It claims the state directory
by exclusive `0700` creation and privately writes the rendered Compose snapshot
before creating resources. Before saving, `setKubernetesBridgeGateway` preserves an explicit development-network gateway or uses the rendered subnet's first usable address, supplying k3d's required bridge gateway for subnet overrides. Startup and cleanup both use that snapshot, so later `.env` edits
cannot change it.

With `OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes`, Kubernetes Compute branches
into `internal/occdev/openshell_k3d.go:upK3d` before Compose rendering, uses the
engine only for k3d and image operations, and adds OpenShell only when selected.
Without OpenShell, the Installation selects the bundled Presets and curated
Codex Plugin Driver, and startup copies the generated administrator password and
service key into the private state directory.

For selected repository inputs, `internal/occdev/repository_k3d.go` validates them,
then waits for authenticated bootstrap and Namespace readiness. It binds the
server-assigned Namespace ID, generates a CA and exact-host broker certificate,
creates Kubernetes inputs, and upgrades Helm with the Repo Driver and worker
sidecar. Authenticated discovery must match approved references and profiles;
this proves no model turn, native sandbox, or Git operation. See the
[required repository inputs](../../guides/deploy/local-repository-credentials.md#prepare-the-approved-inputs).

The default `OCC_DEVELOPMENT_CONTROL_PLANE=compose` uses the Compose snapshot.
Unsupported values fail before resource creation. The
[OpenShell provisioning flow](../openshell-sandbox-provisioning.md#0-create-the-development-control-plane)
owns both OpenShell control-plane sequences.

### 13. Bootstrap OCC, create k3d, and prepare runtime configuration

`internal/occdev/up.go:Up`, `internal/occdev/up.go:waitCompleted`,
`internal/occdev/kubernetes.go:writeKubeconfigs`,
`internal/occdev/kubernetes.go:importRuntime`,
`internal/occdev/kubernetes.go:writeInstallation`,
`internal/occdev/openshell.go:prepareOpenShell`.

Compose starts PostgreSQL, migration, and bootstrap. Once both one-shot
services succeed, startup creates the dedicated k3d cluster on the
Compose network.
With the default Sandbox profile, `OCC_DEVELOPMENT_K3S_IMAGE` selects the node
image; its default `+v1.35` resolves the latest K3s 1.35 patch. An explicit
image skips lookup. OpenShell uses its pinned image in both control-plane modes.
The cluster API binds host loopback; creation leaves the default kubeconfig and
current context unchanged.

The host kubeconfig remains owner-readable. The container kubeconfig uses the
cluster's internal load-balancer hostname with TLS verification. It and the
container configuration are readable by non-root containers behind the private
host directory and mounted read-only into the API and Kubernetes worker. Neither receives the engine socket.

The lifecycle imports runtime and OpenShell images under engine-recorded names,
including Podman `localhost/` tags and Docker Hub familiar names. `internal/occdev/kubernetes.go:engineImageReference` treats an omitted tag as
`:latest` and rejects missing or ambiguous matches. `importDevelopmentImage` owns
the subsequent import and in-cluster digest resolution. Before `writeInstallation`, `internal/occdev/up.go:Up` and
`internal/occdev/openshell_k3d.go:upK3d` call
`internal/occdev/status_proxy_k3d.go:developmentStatusProxySource`. Node inventory keeps caller context outside polling.

`internal/occdev/up.go:poll` bounds route queries to two minutes via `internal/occdev/command.go:command`
(`exec.CommandContext`), so deadline or cancellation stops blocked queries; default
routes keep polling. `developmentStatusProxyCidr` requires one IPv4 `cni0` source
in the node Pod CIDR, not its network address, and returns `/32`. On error, both
callers stop before Installation writing and follow existing cleanup.

`internal/occdev/kubernetes.go:writeInstallation` then selects Kubernetes Compute,
Configuration, and Secret Drivers with native IAM; without OpenShell,
it adds both bundled Presets and the Codex Plugin Driver after the shared Codex
sandbox check. Its runtime section sets the transport Secret prefix, gateway
storage class, and memory limits
of 3 GiB per gateway and 6 GiB per Harness.

When Compose mode also selects OpenShell, startup installs the pinned Agent
Sandbox controller and OpenShell Gateway in k3d before starting the API and
worker, and configures the Sandbox Driver for operator workspace mode. The
[OpenShell provisioning flow](../openshell-sandbox-provisioning.md#0-create-the-development-control-plane)
owns OpenShell Gateway placement and per-Namespace workspace resources.

### 14. Prove readiness and clean up the owned Kubernetes profile

`internal/occdev/up.go:waitReady`, `internal/occdev/up.go:copyAndVerifyKey`,
`internal/occdev/openshell_k3d.go:copyAndVerifyKubernetesKey`,
`internal/occdev/down.go:Down`, `internal/occdev/down.go:cleanup`,
`internal/occdev/state.go:readState`.

After API and worker readiness, both bootstrap readers read private temporary
key copies and bind the `occclient` Installation request to startup cancellation
before exporting the key exclusively. Its ID
must match bootstrap output. Cancellation fails verification and starts owned
cleanup. OpenShell also waits for its bootstrap Namespace and operator-mode Workspace.
Namespace readiness and repository discovery apply their polling deadline
through `occclient.Client.WithContext`, preserving the original client.

Both Kubernetes profiles pass `OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS` to `k3d cluster create --timeout`; node readiness timeout fails startup.

`internal/occdev/state.go:exclusiveWrite` removes a newly created output when
permission setting, writing, or closing fails, including a partial external key
before startup records a successful copy. Existing targets stay untouched; a
removal failure is returned with the original file-operation error.

On failure, startup attempts cleanup. Explicit Kubernetes shutdown validates the
marker, state, and Compose snapshot, then uses the recorded engine endpoint.
Cleanup stops the API and worker, then deletes the named k3d cluster and Compose
project volumes. Cleanup continues after individual errors, retaining state on any failure; complete cleanup removes the state directory and helper-owned key. A
returned external `--key-output` file stays operator-owned; startup removes a
newly written external key if a later OpenShell readiness step fails.

### 15. Start and remove the optional Keycloak profile

`internal/occdev/keycloak_k3d.go:installDevelopmentKeycloak`,
`internal/occdev/keycloak_k3d.go:signInDevelopmentKeycloak`,
`internal/occdev/down.go:cleanup`.

With `OCC_DEVELOPMENT_SIGN_IN=keycloak`, the Kubernetes-only sandbox `none`
profile provisions Keycloak before authenticated readiness, then enables OIDC
and attaches Alice to the administrator. The
[Keycloak lifecycle](keycloak.md) traces port validation, DNS, certificate copying,
both Helm passes, recovery and destructive realm teardown.

## Debugging and Verification

- `node --test tests/integration/dev-up.test.mjs` exercises profile selection,
  generated configuration, authenticated readiness, rollback, and cleanup with
  inert external engine and cluster commands.
- `OCC_TEST_DEV_UP_OPENSHELL_REAL=1 node --test tests/integration/dev-up-openshell-k3d-real.test.mjs`
  selects the Kubernetes-only real-cluster proof.
- `OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL=1 node --test tests/integration/dev-up-openshell-k3d-real.test.mjs`
  selects the Compose-backed real-cluster proof.
- `OCC_TEST_DEV_UP_K3D_REAL=1 node --test tests/integration/dev-up-k3d-real.test.mjs`
  selects the [real launcher cases](../../testing/keycloak.md#local-launcher-coverage),
  including Keycloak login, persistence and failure cleanup.
- A successful startup does not prove Agent creation, model credentials, or a
  model turn. Follow the owning runtime integration procedure for those claims.

## Related docs

- [Return to the parent flow](../docker-compose-development.md).
- [OpenShell Sandbox provisioning](../openshell-sandbox-provisioning.md).
- [Local Kubernetes development](../../guides/deploy/local-kubernetes-development.md).

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-09 22:35: Bind bootstrap authorization to startup cancellation (authoring-run/c12130ba-3173-4831-86e9-5a209d16d630 - 7f358117e68076912a6062411d363e920a0e6adb)

- 2026-10-08 15:23: Reconciled current Docker preflight behavior with failed exclusive-output cleanup and clarified tool and image ownership. (authoring-run/0da79016-d6a4-4217-a420-1e8b0b314e14 - 3cffa93e76aedec4b2f35d14f9824b4531640449)

- 2026-10-08 09:30: Trimmed repeated startup detail after integration. (authoring-run/de31a6a4-b02f-464c-8652-662a7b152fe2 - 9506de602a55f57bf19fa02ba0c7b844aa5a6649)

- 2026-10-07 23:31: Documented optional Keycloak startup, identity attachment and cleanup. (authoring-run/aaa97aa0-d766-4366-af99-089d183c088a - c14b315969527a4e1f3fc3bd525e54d2ed5ec030)

- 2026-10-06 17:46: Remove newly created exclusive outputs after file-write failures. (authoring-run/e789ef10-ca82-4ee2-b31d-8d11100d9744 - 6508695f267e1441bf5a797b9710965f9b10990a)

- 2026-10-05 16:01: Rejected interrupted Docker response streams in the request owner. (authoring-run/91705365-6496-4de8-943f-15c1ba105410 - 9b5a60467022d815d1259ff30d3ed64657657247)

- 2026-10-05 14:02: Matched the API and initializer localhost auth origin acceptance. (authoring-run/cb5a7445-804a-48ad-8c35-118ae9f417b1 - 91e316e7a559f5a09884262755f8fe2a9b655d72)

- 2026-10-05 08:52: Documented bridge-route cancellation and node-inventory context. (authoring-run/cfd0ce95-b6e3-4088-a97b-d6d4c9ff400c - fa8c90b5b6eb3464fcf3af42a7297b5de7d65454)

- 2026-10-04 01:12: Pointed the API startup step at the existing composition function. (authoring-run/286855f7-c7cb-43b6-ba19-419a20192f76 - 7a8a64046ac8ef3e7b5a4ed46b1d4cef9f1573f3)

- 2026-10-02 11:01: Polled CRD status instead of `kubectl wait`. (authoring-run/20771b6e-d59b-4737-8a63-cb33c420218e - 67302dd99e03d28053dbb72ba2569418f6aca1d0)

- 2026-10-02: Treated an absent initial CRD condition as pending.

- 2026-09-30 00:26: Tightened startup prose without changing its behavior. (authoring-run/6c4c7a4c-4674-456a-b1c4-69cec0c52c70 - 282ab1031ff2dd86af00c0c3ff304c9ad442fec1)

- 2026-09-30 00:10: Matched qualified Docker Hub references to recorded familiar names. (authoring-run/b1f9b6de-7c4e-4931-af56-d7be91056814 - 9ec7ad6944f6cad953e4b1e8284bc3e3faf28378)

- 2026-09-30 00:00: Matched implicit image tags and rejected ambiguous names. (authoring-run/bbaa0733-5942-49d5-8bff-1b5354c10117 - 421e85b24aa3a29c5748dde951224082b2c39d71)

- 2026-09-29 20:40: Bound k3d startup timeouts and preflight Node for Compose sandbox preparation. (89a4ccd7-3974-43c6-b08a-be02269a8d01 - cc96e34f33868555d4a89cb44bc022859d76c815)

- 2026-09-28 00:34: Restored Compose defaults and explicit Kubernetes-only startup. (01a0e441-02f9-70b2-ad45-0a1a5049954a - 201f31d511464133f06e0526bb5545ed1cb27e25)

- 2026-09-27 21:52: Waited for k3s Gateway API CRD creation and establishment before Envoy setup and preserved add-on diagnostics on failure. (01a0e441-02f9-70b2-ad45-0a1a5049954a - 181b0472f9a5a9d422035edf5121d3a15c200cb5)
- 2026-09-27 20:39: Added node-local legacy firewall selection, optional DNS configuration, and startup network-policy enforcement probes. (01a0e441-02f9-70b2-ad45-0a1a5049954a - 181b0472f9a5a9d422035edf5121d3a15c200cb5)
- 2026-09-25 12:23: Added the selectable Compose-backed OpenShell topology and brought the existing startup trace into the current flow-document structure. (authoring-run/a81f3e71-1c8e-4692-8e2e-d462ddacc10b - 64ab72aed5c4926e4a2080ade91d785e531801a2)
