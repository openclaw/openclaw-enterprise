---
rfc: index.md
---

# Installation capability inventory and qualification

Companion to the [profile proposal](index.md)
and [Helm inventory](helm-inventory.md). Baseline:
`e06ff9625e72ff5ab3483a504a2f02a69a370cbb`, inspected 2026-09-28.
“Implemented” below means source exists. This inventory separates historical
reports and inspected tests from executed verification; this task ran no runtime
tests.

> Historical baseline: this inventory records the pre-implementation discovery
> phase at `e06ff962`. It does not describe the current installation profile
> renderer, managed Slack proxy wiring, or post-implementation qualification.
> For current operator guidance, see [Render installation profiles](../../../docs/guides/deploy/installation-profiles.md)
> and [Installation Profile Rendering Flow](../../../docs/flows/installation-profile-rendering.md).

## Startup configuration

The closed [startup contract](../../../apps/controller/src/composition/installation-config.ts)
accepts `occ`, `logging`, `presets`, `backend`, and `drivers`. Operators supply
settings through the Helm-mounted startup Secret. Production does not install
from an empty configuration; required selections and their configuration must be
explicit.

| Capability              | Owner and current default                                                       | Inputs, dependencies, limits                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                | Required `occ.cluster`                                                          | Nonempty cluster name; PostgreSQL owns server-assigned singleton Installation identity.                                                                  |
| Operational logging     | `logging.level: info`                                                           | Separate from CRI collector/exporters.                                                                                                                   |
| Preset seeding          | `presets.includeDefaults: false`, `files: []`                                   | Production example enables defaults. Custom JSON paths resolve relative to startup YAML and must be mounted in consumers.                                |
| Native Configuration    | Required `drivers.configuration`; no package selects `occ/kubernetes-configmap` | Kubernetes access; Namespace-owned ConfigMaps. Production example ID `config-kubernetes`.                                                                |
| IAM                     | Required `drivers.iam`; no package selects `occ/native-iam`                     | Empty bundled configuration; persisted roles/policies and bootstrap administrator. Example ID `native-iam`.                                              |
| Compute                 | Required `drivers.compute`; bundled Kubernetes unless `compute-ssh` selected    | Kubernetes only for proposed profiles. SSH exists but rejects plugin selections and does not support this repository path.                               |
| Secret storage          | Required `drivers.secret`; bundled `occ/kubernetes-secret`                      | Kubernetes access; Namespace authorization/projection. Example ID `secret-kubernetes`.                                                                   |
| Plugin driver           | Optional `drivers.plugin`, absent                                               | One Installation-wide `occ-plugin` or `codex-plugin`; no per-Agent driver switch.                                                                        |
| Repository credentials  | Optional `drivers.repo`, absent                                                 | GitHub Backend and broker configuration; details below.                                                                                                  |
| Managed ServiceAccounts | Optional `drivers.service_account`, absent                                      | Operator-chosen driver ID, empty configuration, matching ChatGPT Backend and credential storage.                                                         |
| Sandbox                 | Optional `drivers.sandbox`, absent                                              | Bundled OpenShell or installed package; bundled Kubernetes and matching OpenShell Backend required. Repository plus Sandbox is rejected.                 |
| Credential gateway      | Optional `drivers.credential_gateway`, absent                                   | Bundled OpenShell, matching Backend ownership, Kubernetes and endpoint/TLS/auth inputs.                                                                  |
| Backends                | `backend: []`                                                                   | Supported ChatGPT, GitHub, OpenShell entries have ID/type/configuration/driver membership; matching selections enforced. GitHub and ChatGPT can coexist. |
| Installed extensions    | Optional `package` for Configuration, IAM, Compute, Sandbox                     | Direct production dependency built into controller image; no hot install/reload. No arbitrary package selector for plugin, repo, Secret, or Backend.     |

Sources: [Driver selection](../../../docs/reference/drivers/selection.md),
[Backend contract](../../../packages/contracts/src/index.ts),
[production composition](../../../apps/controller/src/composition/production.ts).
There is no Installation channel-driver selector: production creates the Slack
directory driver from the separate API proxy setting.

## Kubernetes configuration, storage, and diagnostics

`drivers.compute.configuration` owns the following complete option groups.
Most are **required explicit configuration**, not implicit defaults; the
[production example](../../../deploy/examples/production/installation.yaml) is not
a second source of default values.

| Option group                                                                      | Defaults or required input                                      | Local and EKS/Kubernetes requirement                                                                                                                               |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `authentication`                                                                  | Required inCluster or explicit kubeconfig path/context          | No ambient kubeconfig; scoped identities and tenant RoleBindings.                                                                                                  |
| `images.gateway`, `images.agent`, `images.requireImmutableDigest`                 | Required; production enforces immutable digests                 | Coordinate with Helm controller/broker images; release or custom images must implement runtime contracts.                                                          |
| `resources.gateway`, `.agent`, `.namespace.quota`, `.namespace.containerDefaults` | Required explicit quantities                                    | Fit real node capacity and Namespace quotas.                                                                                                                       |
| `network.dns`, `.gatewayPort`, `.gatewayTrustedProxyCidrs`                        | Required peer, port, trusted sources                            | Actual DNS and authenticated proxy source observations; keep exact NetworkPolicy peers.                                                                            |
| `network.gatewayClients`                                                          | Optional                                                        | Direct permitted gateway clients when routing is not selected.                                                                                                     |
| `network.pluginStatusProxySourceCidrs`                                            | Empty when omitted                                              | Private Pod-proxy TCP 18791; missing sources omit allow rule. Observe actual API-server proxy sources in each environment.                                         |
| `network.repositoryCredentials`                                                   | Absent                                                          | Exact broker namespace/Pod selectors, port 8443.                                                                                                                   |
| `servicePrincipalCredentials`                                                     | Explicit mode; production requires projectedServiceAccountToken | Supply audience/lifetime; production example uses openclaw-enterprise/900s.                                                                                        |
| `runtime`                                                                         | Required in production                                          | `transportSecretPrefix`, `gatewayStorageClassName` required; node/gatewayNode selectors optional.                                                                  |
| `runtime.codexSeccompProfile`                                                     | Absent                                                          | Dedicated Codex on affected nodes needs the reviewed node-installed profile; ensure every eligible replacement node has it. Never use an unconfined shortcut.      |
| `runtime.channels.proxyUrl`                                                       | Absent                                                          | Restricted runtime Slack proxy; separate from Console's `api.channelDirectoryProxyUrl`. Tokens come from Agent/Channel Secret bindings.                            |
| `gatewayRouting`                                                                  | Absent                                                          | Must match chart Gateway name/namespace/Envoy; dedicated workspace setup depends on routing/enrollment.                                                            |
| `executionCluster`                                                                | Absent                                                          | Separate authentication, harnessRouting, DNS and harness/gateway/plugin-status source CIDRs; optional CA bundle. Companion chart and remote routing prerequisites. |

[Compute source](../../../apps/controller/src/drivers/compute/kubernetes/index.ts)
owns constants: 10Gi private gateway state, 40Gi dedicated Harness workspace,
1Gi disposable runtime state. These are not configurable Helm capacity values.
Gateway storage requires SQLite-compatible filesystem locking; the dedicated
workspace PVC omits a StorageClass and depends on the cluster default RWO class.
Provision both storage paths, including on EKS where a default class cannot be assumed. See
[storage contract](../../../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md).

Compute production preflight requires Kubernetes **1.35.0 or newer** for both
control and execution clusters; older versions fail with
`KUBERNETES_VERSION_BELOW_MINIMUM`. Both local and EKS clusters must enforce
NetworkPolicies. Current production runtime permits temporary public TCP/443
Agent egress; default deny
does not mean destination-restricted internet access. Profiles must disclose
this existing limit and must not widen networking to mask setup failures.

Audit records and operational logs come from normal controller composition.
Native diagnostics/OTLP settings live in Agent Configuration and runtime/plugin
support, not a new Installation top-level diagnostics flag. Exporter destination,
credentials and permitted peers are additional inputs. Private status includes
runtime diagnostics even with no plugins; Pod readiness and metrics listeners
do not establish functioning exporters or providers.

## Agent presets

`includeDefaults: true` seeds Standard Codex and Standard OpenClaw into new
Namespaces and existing ready/provisioning Namespaces. It skips matching names;
restarting or reseeding does not overwrite user edits. Disabling seeding does
not delete saved presets. Startup requires an authorized Installation admin.

[Standard OpenClaw](../../../deploy/presets/standard-openclaw.json) uses embedded
execution; [Standard Codex](../../../deploy/presets/standard-codex.json) uses dedicated
execution. Both require user model/name/API-key inputs, have no selected Backend
or platform plugins, and disable browser/elevated/web-fetch tools. Codex also
sets cached web search and restricted native network proxy behavior. The stock
Codex preset alone therefore does **not** exercise managed-account plugin loading.
For that acceptance case, explicitly configure the Agent's ServiceAccount binding
and plugin selection without rewriting existing saved presets. Custom templates
remain optional `presets.files` entries.

Source: [seeding](../../../packages/occ/src/index.ts),
[existing preservation coverage](../../../tests/integration/presets-controller.test.mjs).

## Repository access

Required inputs span Helm resources, Installation GitHub Backend and repo
selection, immutable registry, GitHub App key/install/repository IDs, exact
Namespace permission policy, broker TLS/config, separate public CA, upstream
network access and runtime bridge support. Agent repository bindings remain
explicit. Repository permissions `git-read`, `git-write`, `git-full` are separate
from installation profiles and Agent presets.

The [Installation fragment](../../../deploy/examples/repository-credentials/installation.fragment.yaml)
sets `backend[].type: github`, `configuration.registryPath`, `drivers.repo.id`
and `configuration.controlSocket`, `sessionDurationSeconds: 86400`, `publicCaPath`;
these example values are not unconditional parser defaults. Broker selector/port
must match chart resources. Supported runtime paths are embedded OpenClaw/API key
and dedicated Codex/API key or ChatGPT ServiceAccount, without Sandbox.

The [installation guide](../../../docs/guides/repository-credentials/installation.md)
requires fresh bootstrap with repositories disabled until server-assigned Namespace
IDs exist. Both proposed profiles leave repositories disabled unless selected.
The opted-in repository integration must prove discovery and allowed/denied Git
access, not just broker Pod health. Repository binding configures access; it does
not promise automatic checkout at startup.

Live sessions/bearers reside in Maps in the
[credential service](../../../apps/controller/src/drivers/repo/credentials/service.ts).
The [worker](../../../apps/controller/src/worker/repository-credentials.ts) marks a
missing previously open session invalidated and can reject recovery with
`REPOSITORY_SESSION_RECOVERY_UNSAFE`. A durable OCC ledger does not restore broker
authority. Preserve origin/CA, drain safely, and qualify supported recovery/new
revision behavior. A sidecar restart is not a proven reconnect strategy.

## OpenClaw plugin driver: implemented runtime, current image unverified

`drivers.plugin.id: occ-plugin` accepts empty configuration. Its pinned catalog
contains `occ-plugin:diffs`, using `@openclaw/diffs@2026.8.2`; selecting the driver
does not enable that plugin on any Agent. Embedded OpenClaw startup installs with
`--pin --force --no-enable`, refreshes the registry, reapplies policy and verifies
installation. It needs compatible CLI capabilities, writable managed state and
package-network access.

[Driver source](../../../apps/controller/src/drivers/plugin/index.ts) implements
`listCatalog` only. HTTP discovery requires `discoverCatalog`, and the Console
picker requires a Codex harness. **OpenClaw manual/API selection has a runtime
path, but normal Console discovery is a gap.** Profile acceptance must either
explicitly accept the manual path or include this UI/API work after approval.

[Plugin proof notes](../../../docs/testing/plugins.md) report historical native
Kubernetes Diffs installation and execution during ordinary turns. They do not
prove this checkout's image or production Helm composition. Their warning about
missing `--no-enable` may predate the current Dockerfile pin; verify the selected
image's CLI rather than declaring either success or guaranteed failure.

Generic per-call approval (`all_actions`, `write_actions`), reviewers and driver
policy are unsupported for OpenClaw. Preserve native tool restrictions and fail
unsupported selections before saving. No current nested-policy enforcement proof
was obtained here.

## Codex plugins: discovery and runtime are different

`drivers.plugin.id: codex-plugin` defaults `configuration.catalogSource` to
`hosted`; Kevin selected hosted discovery with a PAT as the profile default.
`openai-curated` remains an explicit alternative.
Curated discovery is credential-free for dedicated Codex. Hosted discovery needs
an `at-` PAT or authorized same-Namespace Secret and API HTTPS access to
`auth.openai.com` and `chatgpt.com`. Managed ServiceAccounts are **not** supported
discovery credential sources. The existing `api.modelDiscoveryCidrs` allowance
can carry those `/32` destinations despite its model-specific name. API egress alone
does not configure or authenticate discovery.

Optional paired `codexExecutable`/`codexHome` configures a separate controller-side
native catalog reader; timeout defaults 10000ms, valid 1–60000ms. It is unnecessary
for baseline HTTP/curated discovery. See [driver configuration](../../../apps/controller/src/drivers/plugin/index.ts)
and [hosted implementation](../../../apps/controller/src/drivers/plugin/hosted-catalog.ts).

Managed runtime loading requires:

1. `backend[].type: chatgpt` with `configuration.workspaceId`, absolute
   `apiKeyPath`, optional `credentialTtlSeconds`, matching
   `drivers.service_account` membership and selected ServiceAccount driver;
   admin authority includes `chatgpt.enterprise.service_account.write`. Credential
   TTL defaults/maxes at 30 days; admin credential is mounted only in API.
2. Same-Namespace ServiceAccount with issued access token, matching Backend,
   authorized binding and managed credential projection. Runtime receives
   `CODEX_ACCESS_TOKEN` and `CODEX_CHATGPT_WORKSPACE_ID`, then performs workspace-bound login.
3. Workspace-enabled apps and established service-account app connections; catalog
   visibility alone grants no runtime access.
4. Compatible Codex/plugin-policy runtime, selected concrete hosted-app plugin,
   model access, package/provider network access and dedicated sandbox prerequisites.

[Admission](../../../packages/occ/src/index.ts) and
[runtime startup](../../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)
implement this path. Startup installs selected bundles, checks `appsNeedingAuth`,
resolves concrete tools and verifies effective settings. Some install/auth failures
produce warnings and disable affected selections; metadata/policy failures remain
fatal. Acceptance must inspect each requested plugin, not merely a Ready Agent.
Gateway startup waits for current Codex peer status. Worker validates private
18791 status against revision, Pod UID/container/startup identity.

Supported scope: dedicated Codex with concrete hosted apps, optionally skills.
Hooks, native MCP servers, scheduled tasks, skill-only/template-only bundles are
unsupported. Embedded plus Codex-plugin has partial compute support but lacks
consistent discovery/UI/proof, so it is excluded from initial guarantees. Emitted
policy and permissive native sessions do not establish enforced human approval;
[documented proof limits](../../../docs/testing/plugins.md) remain material.

## Qualification plan

After profile contents and runtime work are authorized, qualify each profile on
fresh disposable local Kubernetes and separately authorized EKS/general Kubernetes:

| Gate               | Evidence required                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package/preflight  | Kubernetes version gate, template+lint, required/mismatched input errors, real image capability checks; no placeholder addresses in final output                         |
| Bootstrap/security | Migrate/bootstrap, login, scoped denial, projected identity, tenant RBAC, NetworkPolicy allow/deny, persistent storage                                                   |
| Presets            | New/existing Namespace seed, repeated startup, preservation of saved edits; distinguish API-key default from account-backed plugin Agent                                 |
| Repository         | When opted in: real discovery, fetch/push within allowed repository, denied repository, restart/drain disruption, and evidence that new revisions receive fresh sessions |
| OpenClaw           | Real selected Diffs normal-turn execution, disabled-plugin denial, preserved sibling state; manual-path/UI limitation explicit                                           |
| Codex              | Account issuance/login, connected app normal-turn result, correct revision status, selected-plugin success, failed-plugin warning, stale-status rejection and restart    |
| Channel/UI         | Console directory lookup plus separate runtime proxy check; authorized test Slack consumer only; native UI isolated-origin admission in both profiles                    |
| Operations         | Worker/Agent restart, storage retention, image upgrade/rollback boundaries, metrics scrape and collector delivery if enabled                                             |

Relevant existing suites were inspected, not executed:
[driver startup](../../../tests/integration/plugin-driver-startup.test.mjs),
[discovery API](../../../tests/integration/plugin-discovery-api.test.mjs),
[real status transport](../../../tests/integration/kubernetes-plugin-status-real.test.mjs),
[native plugins](../../../tests/integration/plugin-driver-real.test.mjs),
[PostgreSQL presets](../../../tests/integration/postgres-presets.test.mjs).
Controlled upstreams prove API/IAM behavior; controlled status producers prove
transport; native scenarios prove selected runtime behavior. None alone proves
the proposed profiles are Helm-installed and operational on EKS.

## Document verification

Helm rendering evidence is in the [Helm inventory](helm-inventory.md). Authored
files pass Prettier, local-link/anchor checks and whitespace checks. Conservative
whitespace word counts stay below 2,200 per document. Each inventory covers one
configuration owner; the design stays together to keep the matrix and settled scope
reviewable. The exact repository length check failed on missing docs-site
`@sindresorhus/slugify`. Its pnpm invocation unexpectedly populated root
dependencies and installed the local Git hook before failing; no further
dependency setup was attempted. Tracked changes are documentation only.

Independent source review found no major issues; its missing Kubernetes-version
prerequisite finding was incorporated before handoff.
