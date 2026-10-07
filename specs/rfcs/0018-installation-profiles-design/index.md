---
author: kevinlin-openai
implementation_status: Implemented
status: Accepted
---

# Installation profiles: openclaw and codex

**Date:** 2026-09-28

**Status:** Implementing; profile defaults and scope decisions accepted

**Owner:** Enterprise installation packaging

## Goal and scope

Offer two installation profiles over one Enterprise Helm chart and one shared
Installation configuration renderer. Each profile works on local Kubernetes and
EKS/general Kubernetes after explicit environment inputs are supplied. This is
an installation proposal, not a replacement platform architecture.

The inventory is pinned to `e06ff9625e72ff5ab3483a504a2f02a69a370cbb` in the isolated
`oce-helm-presets` checkout. Read the [Helm inventory](helm-inventory.md)
and [Installation inventory](installation-inventory.md)
for current defaults, owning settings, prerequisites, and evidence limits.
The [platform design](../../../docs/design.md) retains resource ownership and isolation.

Implementation and qualification are authorized in a new worktree and newly
created test EKS clusters. Existing EKS clusters and unrelated installations
must remain unchanged. Slack consumer activation is outside this work.
No reusable file contains site IPs or secrets.

An **installation profile** selects platform defaults and prerequisites. An
**Agent preset** is a saved template used when creating an Agent; it neither
installs a plugin driver nor supplies credentials. `presets.includeDefaults: true`
currently seeds both Standard OpenClaw and Standard Codex, preserving existing
presets with matching names. The profiles must not imply that seeding those
presets makes both plugin stacks compatible.

## Proposed configuration matrix

All entries below are proposed final configuration, not existing named profiles.
“Required input” means setup reports an incomplete feature until supplied.

| Capability                         | openclaw                                                                                    | codex                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Core platform                      | Kubernetes Compute; PostgreSQL; native IAM; Kubernetes Configuration/Secrets                | Same                                                                                                                 |
| OCC Console                        | Included in API image; authenticated private access                                         | Same                                                                                                                 |
| Repository support                 | Optional, disabled by default; two-stage setup when enabled                                 | Same                                                                                                                 |
| Default Agent presets              | `presets.includeDefaults: true`; both standard presets; recommend Standard OpenClaw         | Both standard presets; recommend Standard Codex                                                                      |
| Agent harness recommendation       | Embedded OpenClaw                                                                           | Dedicated Codex                                                                                                      |
| Installation plugin driver         | `drivers.plugin.id: occ-plugin`                                                             | `drivers.plugin.id: codex-plugin`                                                                                    |
| Plugin catalog                     | Pinned catalog; manual/API selection, Console discovery gap                                 | `configuration.catalogSource: hosted`; PAT-backed discovery                                                          |
| Plugin credentials                 | Bundled `diffs` needs none                                                                  | Hosted discovery PAT required; existing account access token or optional managed ChatGPT ServiceAccount for runtime  |
| Slack/channel proxy                | Shared restricted proxy infrastructure for API directory lookup; no embedded Agent Slack    | Shared restricted proxy infrastructure; runtime plus Console lookup wiring                                           |
| Slack consumer                     | Unsupported for embedded OpenClaw; Standard OpenClaw must leave channels disabled           | Inactive until operator supplies dedicated Agent Channel configuration and credentials                               |
| Private gateway routing            | `gatewayRouting.enabled: true`; Envoy/cert-manager prerequisites                            | Same                                                                                                                 |
| Agent native admin UI              | Enabled by default; `agentNativeAdmin.enabled: true`; DNS/TLS/cookie-domain inputs required | Same                                                                                                                 |
| Metrics                            | `metrics.enabled: true`, private listener; explicit scraper selectors                       | Same                                                                                                                 |
| Log collector                      | Off unless no existing cluster collector owns logs                                          | Same                                                                                                                 |
| Images                             | Approved controller digest and compatible OpenClaw plugin-capable runtime digest            | Approved controller digest and compatible Codex runtime digest with verified plugin CLI, policy adapter, and sandbox |
| Dedicated Codex host prerequisites | Required if choosing Standard Codex                                                         | Required before declaring profile ready                                                                              |

Both profiles include the shared installation capabilities and select one plugin
driver globally. Selecting another Agent preset does not switch that driver.
Installing the shared proxy infrastructure does not give Agents a channel.
Kubernetes Compute rejects enabled external channels for embedded OpenClaw, so
only dedicated Codex Agents can use the Slack consumer path in the initial
profiles. Profile names must not become a new persisted platform resource.

## Shared defaults and optional integrations

Use separate application/migration database roles, exact-resource IAM, projected
workload identity, enforced default-deny networking, persistent gateway/workspace
storage, and digest-pinned images. Keep provider credentials outside values and
Agent presets. Operators supply existing Secret references; setup never reads
unrelated deployment state.

Console access is authenticated. Both profiles enable native OpenClaw
administration by default, as selected by Kevin. This retains the full-admin
pilot contract: wildcard DNS/TLS, shared-cookie boundaries and exact-Agent OCC
admission. Both profiles require those inputs and private gateway routing.
Native edits can diverge from managed configuration.

Codex uses hosted discovery with an operator-supplied PAT by default. Supply the
PAT directly through the supported discovery flow or an authorized same-Namespace
Secret, plus current API egress addresses for the auth/catalog hosts. Runtime can
use an existing account access token through `codex_pat`, or optional
OCE-managed ServiceAccount provisioning. Verify discovery and runtime
independently; catalog visibility does not establish app connection or model access.

| Optional integration         | Required inputs and consequence                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Curated Codex discovery      | Explicit `catalogSource: openai-curated` override avoids discovery PAT requirements; runtime authentication is still required                                                                                |
| Repository support           | Explicit opt-in with GitHub App inputs and the two-stage setup below; omitted credentials do not block a repository-disabled installation                                                                    |
| ChatGPT account provisioning | Backend admin credential, provider network access, selected `chatgpt-service-account` driver and Namespace-owned account; Codex profile requires this path or a separately approved explicit credential path |
| Model enumeration            | `api.modelDiscoveryCidrs`; independent from required inference credentials and runtime egress                                                                                                                |
| OpenShell                    | Explicit sandbox/credential-gateway selection, operator infrastructure, provider inputs; incompatible with enabled repository support; requires a separately scoped reduced-capability configuration         |
| External telemetry           | OTLP endpoint and peer policy, collector configuration/exporter Secret; demo backends remain separate                                                                                                        |
| Remote execution cluster     | Separate API/worker kubeconfigs, execution chart/RBAC, routable TLS path and qualified two-cluster networking                                                                                                |
| Custom drivers/images        | Explicit installed module references and credentials; validate contracts and image capabilities before readiness                                                                                             |

## Smallest maintainable arrangement

Keep `deploy/helm/openclaw-enterprise` as the single control-plane chart. Retain
`openclaw-execution` for a distinct execution cluster and the observability demo
chart for disposable telemetry. Do not copy these charts per profile.

Add two small declarative profile definitions consumed by one installation
renderer. Shared defaults live once; each definition contains only its driver,
catalog, and recommended harness differences. The renderer emits chart values
and startup Installation YAML together, because Helm currently only mounts an
operator-provided Installation Secret. Plain Helm value overlays alone cannot
select plugins or seed presets.

Keep profile, environment, and secrets separate. Environment inputs specify
endpoints, storage classes, selectors, DNS, approved image digests and Secret
names. Local/EKS examples are input examples, not extra product profiles.
Resolution order is shared defaults, selected profile, then explicit environment
inputs. Overrides must pass the same compatibility checks; changing the plugin
family should select the corresponding profile rather than create an implicit
third profile.

Avoid a generalized deployment orchestrator. Initially the renderer prepares
reviewable files and reports missing inputs; existing operator steps perform
infrastructure preparation, Secret creation, bootstrap and apply. The desired
future invocation takes one profile name and an environment input file. Its CLI
and file format remain implementation choices after this proposal is accepted.

### Repository bootstrap and recovery

Repository support is optional and disabled by default in both profiles.
Registry policy is keyed by server-assigned OCC Namespace IDs, so enabling
repositories requires two stages:

1. Bootstrap the core with repository credentials disabled and obtain the
   Namespace IDs. Report the opted-in repository integration as incomplete.
2. Supply the GitHub App installation/key, versioned registry, service config,
   broker TLS/CA and allowed upstreams; render matching broker origin and
   Installation repo/backend/network settings; enable and verify discovery plus
   allowed/denied Git access.

A repository-disabled installation can be complete without GitHub App inputs
or these additional steps. When repositories are selected, completion requires
both stages and access verification. The two-stage operator flow is accepted;
automating it is outside the initial scope.

The current broker is colocated with the worker and retains sessions in memory.
Worker Pod replacement can invalidate them; a stable DNS name or persisted OCC
ledger does not restore them. Keep explicit maintenance/recovery instructions
and prove new revisions receive fresh sessions. Do not label the optional
repository integration restart-safe before qualification. Moving the broker into
its own Deployment reduces coupling but does not solve broker restart recovery;
it is a separate scope decision, not a hidden prerequisite of a YAML profile.

### Channel proxy completion

The chart currently consumes proxy endpoints but does not install a Slack proxy.
Propose one optional chart-managed restricted forward proxy, enabled by both
profiles, with separately wired `runtime.channels.proxyUrl` and
`api.channelDirectoryProxyUrl`. The API value currently requires a literal IPv4
address and port, so a reusable Service DNS value is **not yet supported**.
Choose either a bounded post-Service endpoint-resolution step using current
contracts or a reviewed DNS-plus-selector extension. Prefer endpoint resolution
first; do not hard-code an allocated Service IP. Provisioning the proxy never
enables a Slack consumer.

## Environment and failure contract

Both environments require Kubernetes 1.35.0 or newer for control and execution
clusters, enforcing NetworkPolicies, external PostgreSQL,
bootstrap output storage, tenant RoleBindings, storage classes, image access,
API/database/DNS paths, and Envoy Gateway/cert-manager for the proposed routing
default. Local means Kubernetes such as disposable k3d, not Docker Compute.
EKS adds operator-owned IAM/CSI/node prerequisites; these profiles do not create
an EKS cluster, node group, load balancer, RDS, or DNS zone.

Preflight should name the setting, observed condition, and corrective action:

| Failure                                         | Actionable result                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Cluster version below 1.35.0                    | Report `KUBERNETES_VERSION_BELOW_MINIMUM` and require a supported control/execution cluster          |
| Missing digest or mismatched runtime capability | Name the image field and missing CLI/plugin capability; stop before apply                            |
| Missing repo credentials or Namespace registry  | When repositories are opted in, report stage and missing input; otherwise omit repository checks     |
| Hosted catalog timeout                          | Identify API discovery egress or PAT failure separately from workload runtime auth                   |
| Codex installed but gateway not ready           | Check policy-proxy peer status, desired digest, and private TCP 18791 path; do not disable readiness |
| Empty Slack directory                           | Check API proxy wiring/CONNECT allowlist independently of runtime Slack proxy                        |
| Namespace provisioning stalls                   | Identify tenant RoleBinding or storage prerequisite, preserving scoped RBAC                          |
| Dedicated Codex cannot start sandbox            | Name required node seccomp installation and eligible-node selector                                   |

Embedded OpenClaw with `codex-plugin` has partial source support but is outside
the initial supported profile combinations. Hosted discovery from a managed
ServiceAccount is a current gap. Missing network peers must fail closed; neither
public plugin-status ingress nor unrestricted egress is an acceptable fix.

## Requirements → design mapping

| Requested outcome                                           | Design and acceptance                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Complete capability inventory                               | Two linked inventories covering chart and startup settings                          |
| Two portable profiles                                       | Shared renderer plus two small definitions; same features across environments       |
| Optional repositories, standard presets, channels and admin | Explicit matrix; native admin on, repository completion gates only when opted in    |
| Working OpenClaw and Codex drivers                          | Qualified harness pairings; source/historical/current proof separated               |
| Actionable setup                                            | Validate required inputs and runtime prerequisites before readiness claim           |
| Preserve existing deployments                               | Fresh-install scope; no profile application to existing installations in this phase |

## Detailed file plan and milestones

**Milestone 1: profile agreement.** This document and inventories record the
selected profile contract. Verification: source audit, Helm rendering,
link/length checks, independent review. No runtime tests for this documentation phase.

**Milestone 2: approved packaging implementation.** Add profile definitions under
`deploy/profiles/` and a renderer under `scripts/`; extend chart templates only
for the approved proxy/config wiring. Update the installation profile guide, the
owning plugin/repository guides, and existing Helm/bootstrap integration coverage.
Shipped outcome: deterministic artifacts, required-input diagnostics, preserved
preset edits. Verify each profile with complete and deliberately incomplete inputs.

**Milestone 3: isolated qualification.** Run the [acceptance matrix](installation-inventory.md#qualification-plan)
on disposable local Kubernetes and separately authorized EKS/general Kubernetes.
Shipped outcome: evidence for each supported combination, including denials and
restart limits. Real Slack proof requires separately authorized test credentials
and a test channel.

Roll out to fresh installations first. Upgrading an existing Installation requires
its own saved-state comparison and migration decision. Rollback restores prior
chart/config/image inputs while preserving database/PVCs; schema migrations and
repository sessions require compatibility/recovery checks and cannot be undone
by assuming `helm rollback` reverses their effects.

## Accepted decisions

Kevin selected exactly two profiles, native admin enabled by default in both,
optional repository support using the existing two-stage flow, and hosted Codex
discovery with a PAT by default. Native admin requires private gateway routing,
so routing remains enabled with Envoy/cert-manager and DNS/TLS/cookie inputs.
The PAT choice applies to discovery. The supplied existing account access token
also selects the supported `codex_pat` runtime path for qualification; managed
account provisioning remains optional with separate administrator prerequisites.

The two remaining scope decisions are settled:

1. OpenClaw ships initially with manual/API plugin selection. The profile records
   the missing Console picker as a limitation instead of blocking setup.
2. Optional repository support may launch with the documented broker restart
   limitation. Repository-enabled qualification must prove new revisions receive
   fresh sessions after disruption, but restart-safe session recovery is not a
   prerequisite for repository-disabled installations or the first optional path.

Implementation and testing are authorized only on new task-owned clusters.
Required user-supplied inputs remain installation parameters, not additional
profile design decisions. A successful installation does not establish real
model/plugin execution; record both outcomes independently.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-28 09:20: Source-backed inventory and proposed profile contract; no implementation or deployment. Session `01a0e8d0-c07a-71c2-9bf1-04394d5e6f76`.

- 2026-09-28 09:31: Removed the default installation profile at Kevin’s direction; openclaw and codex retain all shared capabilities. Session `01a0e8d0-c07a-71c2-9bf1-04394d5e6f76`.

- 2026-09-28 15:29: Applied Kevin’s selections: native admin on in both profiles, optional repositories with two-stage setup, and hosted PAT-backed Codex discovery. Routing follows native-admin prerequisites; two scope decisions remain. Session `01a0e8d0-c07a-71c2-9bf1-04394d5e6f76`.

- 2026-09-28 16:05: Settled the OpenClaw manual/API picker path and accepted the optional repository broker restart limitation for initial profile packaging. Session `01a0e8d0-c07a-71c2-9bf1-04394d5e6f76`.

- 2026-09-28 16:24: Added the first profile packaging artifacts: two profile definitions, renderer, guide, and focused renderer coverage. Session `01a0e8d0-c07a-71c2-9bf1-04394d5e6f76`.

- 2026-09-28 15:52: Qualified the existing-account token path separately from optional managed account provisioning; clarified broker versus worker-process restart behavior.

- 2026-09-28 17:35: Clarified that shared Slack proxy infrastructure does not enable embedded OpenClaw Slack consumers; dedicated Codex execution remains required. Session `01a0e8d0-c07a-71c2-9bf1-04394d5e6f76`.
