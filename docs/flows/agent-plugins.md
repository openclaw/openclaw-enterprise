---
created: 2026-09-08
updated: 2026-11-14
last_updated_session: authoring-run/01a1a93c-472f-70c0-b038-f7f673ffdc1e
---

# Agent Plugin Deployment Flow

## Overview

OCC limits and authorizes uploads before parsing. Configured [request auditing](audit-ledger.md) records each outcome. The [Plugin Driver](../../apps/controller/src/drivers/plugin/import-package.ts) reports omitted components. Revisions pin the release digest, Driver and policy. [OpenShell](../../apps/controller/src/drivers/sandbox/openshell-managed-mcp-policy.ts) enforces the bound MCP account and selected tools.

## Entry Points

`apps/controller/src/index.ts:createFastifyApp`

- Create or update `Agent.plugins`, then deploy. This requires Agent permission and a compatible PluginDriver.
- Source: [HTTP handlers](../../apps/controller/src/index.ts),
  [OpenClawController](../../packages/occ/src/index.ts), and
  [bundled PluginDrivers](../../apps/controller/src/drivers/plugin/index.ts).

## Flow

```mermaid
graph TD
  D0["Request discovery"] -->|Create| D1["Authorize Agent create"]
  D0 -->|Saved| E0["Authorize Agent read/update"]
  E0 -->|no credential| D6
  E0 -->|bound| E1["Caller and Agent operate"] --> D6
  E0 -->|managed MCP| M0["Check credential and discover server tools"] --> D5
  E0 -->|credentialSource| D2
  D1 -->|stored source| D2["Caller source operate"] --> D6["Select Harness catalog"]
  D1 -->|token or none| D6
  D6 -->|unsupported| D7["Unsupported"]
  D6 -->|token or none| D4["Call PluginDriver"]
  D6 -->|Secret| D3["Read and recheck"] --> D4
  D6 -->|CredentialSource| D9["Check source and exact Gateway owner; read unless canceled"]
  D9 -->|success| D10["Recheck authority, source and catalog"]
  D10 -->|allowed and connected| D4
  D9 -->|canceled or failed| D12["Stop"]
  D10 -->|denied or disconnected| D12
  D4 -->|disconnect| D8["Cancel hosted reads"]
  D4 --> D5["Return safe metadata"]
  A["Authorize and validate policy"] -->|valid| S["Save Agent selections"]
  A -->|unsupported| Y["Reject write"]
  S --> B["Revalidate and snapshot version"]
  B -->|imported skills| V["Mount verified files in the Gateway"]
  V --> I
  B -->|managed MCP| K["Project worker MCP and Gateway tool selections"]
  K --> L["Sandbox applies account and tool request policy"]
  L --> I
  B --> C["Validate native metadata; grant selected plugins"]
  C --> D["Attempt selected installs"]
  D -->|install rejection or auth required| E["Disable failed selections; collect warnings"]
  D -->|success| T["Resolve owned tools; translate final app policy"]
  E --> T
  T --> F["Verify native identity and effective policy"]
  F -->|invalid or unsafe| X["Keep runtime unready"]
  F -->|verified| G["Publish current startup status"]
  G --> H["Apply matching gateway configuration"]
  H -->|dedicated| P["Apply Gateway tool policy"]
  P -->|incompatible| X
  P -->|valid| I
  H -->|embedded| I["Compute returns readiness and warnings"]
  I --> J["Worker completes deployment under live claim"]
  G -->|runtime restart| C
```

## Execution Trace

### Credential-scoped discovery

[Create discovery](../reference/drivers/plugin.md#selection-and-catalogs) requires a
Harness, Agent `create`, and caller `operate` on stored sources. Wrong Namespace:
`400`; missing Secret: `404`; unavailable explicit CredentialSource: `409`.

Saved discovery requires a dedicated Agent and caller `read`/`update`. Bound sources
require caller and Agent `operate`; explicit sources require caller `operate`.
Missing or unready bound sources return `404`. Hosted catalogs require credentials;
curated catalogs do not.

The OpenShell Backend reads metadata and exports through operator mTLS. External
Gateways retain optional `withSourceToken`. OCC checks source/Gateway ownership,
then rechecks authority, attachment and catalog before dispatch. Cancellation
discards late credentials; refresh stays with its owner.

`packages/occ/src/index.ts:OpenClawController.discoverManagedMcpTools`

Managed MCP uses Secret Driver, rechecking before `tools/list`.
`driverPolicy.toolNames` pins upstream names across runtimes.

Closing cancels; account changes clear results; Harness changes clear selections/approvers. [Hosted reads](../reference/drivers/plugin-bundled.md#selection-and-catalogs)
bound size/time, reject redirects and credential echoes, and return safe metadata
with `Cache-Control: no-store`.
For hosted Codex entries, `apps/controller/src/drivers/plugin/hosted-catalog.ts:catalogEntry` accepts
an omitted `requires_local_executor`. Explicit `true` requires skills.
Details reject unmatched MCP/scheduled tasks. Optional stdio
`NativeCodexPluginCatalogReader` rejects invalid `plugin/list` results and stops its child.

### 1. Validate desired state under exact-Agent authority

`apps/controller/src/index.ts:createFastifyApp`

HTTP validates input. [OCC](../../packages/occ/src/index.ts) checks the exact
Namespace and Agent (`read` for reads). Create/PATCH saves `plugins` and Driver
identity. Updates atomically save state and audit evidence. Omitted selections
persist, `{}` clears them, and nonempty maps replace them. Clear selections with
unknown or different owners before changing catalogs.

`validateAgentPlugins` checks policy and Configuration against the Harness
catalog on Agent/provisioning writes. Deployment rechecks Configuration.
OpenClaw refuses selections blocked by `tools.deny`, the sole `agents.entries`
tool list, the primary provider's `byProvider` lists, or their combination.
It also refuses selections beside an entry denying `*` or hidden under a
profile by the sole entry's `alsoAllow`.
[`openClawPluginSettingConflict`](../../apps/controller/src/drivers/plugin/openclaw-plugin-settings.ts)
checks [Gateway-rejected settings](../reference/drivers/plugin-bundled.md#native-mappings-and-limits)
first for OpenClaw Harnesses.
Unsupported controls or incompatible selections return `400 INVALID_REQUEST`.

[`validatePolicies`](../../apps/controller/src/drivers/plugin/runtime-translator.ts)
detects conflicting enablement defaults. `BundledPluginDriverBase.validate`
allowlists it for OCC's fixed `PluginPolicyValidationError` advice.
Unrecognized refusals stay generic. The Console preserves rejected drafts.

[Save](../../apps/controller/src/console/agents/plugins.mts#L419) keeps out-of-range
**Plugin selections JSON** text and skips Agent `GET`/`PATCH`.
[Picker edits](../../apps/controller/src/console/agents/plugin-fields.mts#L416)
stop. [Available catalogs](../guides/console/configuration-plugins-and-files.md#plugins-tab)
remain browsable.

Read capabilities from `GET /installation` or `GET .../plugins/capabilities`
(Agent `read`/`update`).

### 2. Admit an immutable plugin deployment

`packages/occ/src/index.ts:OpenClawController.deployAgent`

OCC snapshots Configuration, Driver and selections. Before cutover the worker checks Driver/Harness compatibility. Gateway and worker verify assets against Compute’s package descriptors.

- **CLI packages.** Gateway loads skills. Harness runs the pinned executable. The guard checks operation and credential restrictions before injection.
- **Hosted MCP packages.** The worker advertises the account’s selected tools. Gateway grants same-node execution per turn. Calls requiring Gateway hooks or another node return results or denials through Gateway to Code Mode. The credential driver attaches the source. Sandbox supplies its placeholder and scopes worker and script requests. OpenShell enforces tool names and rejects overlapping routes.
- **Native runtime plugins.** Startup installs packages and verifies tool policy.

Withdrawal removes credential injection. Recovery preserves other attachments.

### 3. Deliver requested state through Compute preparation

`apps/controller/src/drivers/compute/plugin-runtime.ts:pluginRuntimeSpecForRevision`

Compute validates admitted state, Driver, and Harness. Kubernetes projects the
nonsecret request; Docker uses environment delivery with a 64 KiB size limit. For Codex, Compute
writes the policy the Gateway runs into native `approval_policy` before startup
validation: the configured `appServer.approvalPolicy`, with `on-failure` as
`on-request`. Omission preserves native defaults; incompatible explicit policies
remain subject to reviewer checks. At Agent save, provisioning and deployment, the Codex
PluginDriver refuses an automatic reviewer unless the policy is `on-request` or
`on-failure`, because an omitted policy lets the Gateway pick one the startup
check cannot see. Configuration save and Compute Drivers refuse policies the
Gateway refuses at load, such as `untrusted`.

Save and deploy enforce the combined 8 MiB skill limit. [Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/imported-plugin-skills.ts) mounts pinned Namespace files read-only. The [Gateway](../../deploy/runtime/openclaw-pinned-skill-sources.patch) rejects same-name workspace substitutions. Workers retain executable modes and read local `SKILL.md`.

Each version has an immutable Kubernetes ConfigMap. Earlier versions retain their `config.toml` (without
`[plugins._default]` (#508), without `approval_policy` (#1995), or with
`on-failure` as written) until the Agent is deployed again; `KubernetesComputeDriver.reconcilePluginRuntimeConfigMap` refuses any
other difference. OpenShell dedicated Codex has no such allowance and needs a
new deployment after that upgrade.

SSH Compute rejects nonempty plugin maps and Agent default plugin approver
policies before host effects.

Initial embedded Kubernetes gateway preparation applies exact-Agent HTTPS
egress before installation. For existing gateways, `prepareRevision` avoids
duplicate Agent database access. `activateRevision` uses `Recreate`, stopping
the old gateway before installation. Version files stay private and the native
registry stays in the Agent-owned database. Docker keeps native state in the
container's private temporary home.

### 4. Prepare native runtime state and hand off readiness

`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:installOpenClawPlugins`

Embedded OpenClaw validates selections against its bundled catalog and policy.
Grants enter nonempty `tools.allow`, otherwise `tools.alsoAllow`; denies and profiles
remain. Tool `enabled` overrides `toolDefaults.enabled`; disabled tools emit denies.
Master disable and operator denies prevail. The supported modes
`provider_default` and `none` add no plugin review. Version-private installs use `--pin --force --no-enable`,
preserving enablement and tool policy. Preparation refreshes the registry and verifies
configuration, plugin/package identity, versions, integrity and source containment
within the install path. Verification failures keep the Gateway unready. Confirmed
install rejection disables the optional selection and removes its tool allowance
before startup.

Dedicated launchers capture the [Gateway tool policy](../reference/configuration.md#gateway-tool-policy)
from the saved Agent revision before plugin grants. Startup and peer respawn
enforce it; failures keep the Gateway unready. Changes require deployment replacement
after affected old work ends. Human permissions stay unchanged. An embedded Gateway
applies a policy that the Configuration sets without this composition, so Compute checks
it at Configuration save and deployment admission with the same rules
(`gateway-tool-policy.ts:validateGatewayToolPolicy`), not on maintenance passes.

Dedicated Codex uses isolated `CODEX_HOME`, disabling app/plugin defaults.
Selections enable apps, plugins and remote plugins; disabled entries cannot execute.
The [native policy mappings](../reference/drivers/plugin-bundled.md#native-mappings-and-limits)
describe the generated bridge.

<!-- Internal preparation threads one explicit RPC caller through these reads,
writes, reviewer checks, and no-account disablement; ordinary transport is unchanged. -->

Startup enables experimental APIs and resolves selected IDs through `plugin/search`.
`codex-plugin-stdio.ts:withCodexPluginStdio` retains fixed
`nativeErrorType`/`nativeSubErrorType` values, discarding other stderr/RPC content
and lines over 64 KiB while draining. RPC errors alone do not prove backend
installation.

`runtime-entrypoints.ts:readCodexPluginDetails` reads up to four
selections concurrently before and after installs. Batches preserve order and drain
before retries and final verification; writes stay sequential.
`codexRuntimeArtifact` uses `detail.apps`, excluding `appTemplates`.
`codexInstallPlan` validates policy and [component support](../reference/drivers/plugin-bundled.md),
then grants selected plugin IDs through `config/batchWrite` before `plugin/install`
can report authentication requirements. App/tool grants follow; plugin defaults stay
off. Bundled skills need the compatible runtime below for selected-only activation.
Install rejections or missing app authentication warn. Explicit tool policies
require `mcpServerStatus/list`'s `codex_apps` inventory; `codexAppToolSettings`
binds catalog action IDs through `_meta._codex_apps.resource_uri`. Native IDs
work. Unknown, unowned, ambiguous, or duplicate IDs fail startup.

After installation, startup rechecks catalog identity, version, apps and components
before final app/tool grants; `plugin/read` cannot inspect bundles.
`writeCodexPluginConfiguration` replaces owned plugin/app tables, enables successful
selections, disables failed/disabled plugins and unselected apps, and writes
inherited tool/account approvals from merged workspace settings. Lower-layer
descendants remain. Unspecified enablement stays unset; requirements still apply.
Failed-only apps stay disabled; disabled selections skip installation/status.

Workspace-aware readback rejects policy conflicts before readiness. Disabled apps may
retain inherited fields. Categories resolve app → global → native `true`; equivalent
values/nulls pass. Tool enablement cannot bypass categories.
`verifyCodexPluginConfiguration` rejects explicit enablement of unselected plugins;
approval-only or MCP-policy-only entries inherit the verified plugin default-off
setting. Source/account-disabled plugins remain disabled.

`runtime-entrypoints.ts:startAuthenticatedCodex` passes the admitted Harness model,
without its provider prefix, to the app-server after the authentication probe
succeeds. Native configuration readback therefore exposes the model used for
startup policy validation.

`runtime-entrypoints.ts:verifyCodexReviewerConfiguration` checks app/link reviewers
and `configRequirements/read`. Forbidden reviewers, incompatible automatic-review
settings or conflicting model requirements block startup. Checks exclude later
workspace/session/model changes and strict review. Codex 0.156 readback omits
execution-time managed app/tool requirements; [effective-policy proof](../testing/plugins.md#current-proof-notes)
remains necessary.

`runtime-entrypoints.ts:disableCodexSelectionsWithoutChatGptLogin` disables enabled
selections and app/plugin features for API-key logins when best-effort preparation
allows authentication warnings. API-key logins cannot install remote plugins.
Startup verifies both default-off tables before handing off readiness.

For Compute-owned Kubernetes workloads, only an admitted `{pluginId, code}`
warning results from a selected OpenClaw install's normal nonzero exit, a
matching Codex `plugin/install` error, or a successful Codex install needing app
authentication. Transport loss, timeouts, signals, malformed responses,
discovery failures, and policy failures retain ordinary startup failure
behavior. Provider-owned Harnesses keep their existing startup path.

Kubernetes Compute streams private startup status with a 65,536-byte limit.
Overflow cancels the response without retry, even for a 404/503; within the limit
those codes mean not serving. Readiness verifies workload, version, startup
instance, selection keys and warnings. Docker Codex healthchecks fail on
interrupted status bodies, preserving the transport code or original reason.

With the tool proxy enabled, dedicated Codex reads bundled skills at
`/home/node/.codex/skills/.system` without a repository broker or neighboring
credentials. Startup links `/home/node/.openclaw/plugin-skills` to
`/home/node/openclaw-runtime-assets/plugin-skills`, keeping gateway state private.

Gateway blocks failed bridges before serving and retry during turns. Startup
changes refresh effective configuration; untrusted status cannot establish
readiness or change version selections.

Compute installs status NetworkPolicies before the first dedicated gateway and
creates it only when the Agent and plugin status are ready and its Service selects
the version. Existing gateways and full runtime policies retain their activation
boundary.

The Agent and gateway derive an app-server credential from the transport Secret,
Agent revision ID, and Agent startup ID. The gateway receives it after matching status
and rendering exclusions. After a Harness restart, the old credential cannot open
a new authenticated app-server WebSocket to the replacement Harness. It does not
revoke access to a still-running old Harness or an established connection. For a
changed peer, the supervisor publishes non-ready, restarts only OpenClaw and
rechecks peer startup, Pod, successes and failures after it serves. Changed or
unavailable peers trigger container restart.
The supervisor repeats a stop signal that OpenClaw ignored during its own in-place
restart, seen as readiness returning after its server closed.
For writable native-admin configuration, recovery reads the bridge baseline from
the read-only managed snapshot. A Pod-local record binds the last and pending
generated bridges to the version and snapshot hash before configuration writes.
Process and same-Pod container restarts rebuild only a matching generated bridge.
Other native edits survive; conflicting bridge edits retain the existing refusal.
An unreadable or mismatched record holds startup unready, reporting runtime
failure `peer-bridge-record` (`UNAVAILABLE`), and logs the remedy: replace the
Pod, which restores the snapshot and clears this private record.
During an outage, the supervisor reports unready. Kubernetes propagates that
state asynchronously, so the signal alone is not a per-request traffic fence.
If OpenClaw exits while the supervisor waits for its peer, the wrapper exits
for container recovery.

<a id="5-complete-revision-reconciliation" class="anchor-alias"></a>

### 5. Complete version reconciliation

`apps/controller/src/worker.ts:finalizeRevision`

Preparation failure preserves the prior `activeRevisionId`. After commit, activation or finalization failure retains the candidate pointer and records `REVISION_FINALIZATION_INCOMPLETE` for retry.
Embedded Kubernetes replacement runs after commit; the old gateway may already
be stopped. The previous version stays stored. Cutover has no availability or rollback guarantee. See the [controller worker flow](controller-worker.md).

Success reports `REVISION_ACTIVATED` or `REVISION_ALREADY_ACTIVE`.
A candidate pointer alone is not readiness evidence. Agent turns use native
policy; the workspace and gateway database remain Agent-owned.

The worker saves plugin warnings with successful work under its live claim; the
[worker flow](controller-worker.md#7-defer-retry-or-stop-and-hand-off-the-next-iteration)
covers persistence and deployment status. Claim loss blocks stale completion;
later workers recheck readiness. No receipt acknowledgment, failed-plugin
shutdown, or permanent failure latch exists. Warnings describe deployment completion, not ongoing health.

## Debugging and Verification

OpenClaw caps the model probe deadline at 600 seconds. It caps throttled time by throttled periods, then
takes the larger of that time and PSI wait. Missing, nonfinite or reset samples cannot establish starvation. A timeout requires
over 25% CPU wait in its final 15 s and no idle 5 s interval to qualify as starved
(`timeoutWindowMs`, `timeoutWindowCpuWaitMs`, `timeoutWindowIdleMs`).

- Compare `Agent.plugins`, the revision snapshot and deployment status. Invalid policy leaves desired state unchanged. Startup verifies catalog membership, ownership, authentication and native configuration.
- For `PLUGIN_INSTALL_FAILED` or `PLUGIN_AUTH_REQUIRED`, check that both runtime and Gateway disable the deployment’s `pluginId`. Keep credentials out of logs.
- SSH Compute refuses plugin maps and default approvers before host effects. Use compatible Kubernetes or clear both.
- Verify a model-chosen plugin call. Remove it, redeploy and check both the target and an unaffected Agent.

## Related docs

- [Agent plugin reference](../reference/agent-plugins.md).
- [Agent plugin approvals and channel directory flow](agent-plugin-approvals.md).
- [PluginDriver selection and limits](../reference/drivers/plugin-bundled.md).
- [Controller worker](controller-worker.md).
- [Harness execution topology](harness-execution-topology.md).
- [Deployment guide](../guides/deploy.md).
- [Agent plugin testing](../testing/plugins.md).

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-14 00:19: Audit uploads. (authoring-run/01a1a93c-472f-70c0-b038-f7f673ffdc1e - 917b778aa302240e8bc8ca93e8b4a48c7e0d23e9)

- 2026-11-13 23:00: Trace Namespace release admission and projection. (authoring-run/01a1a93c-472f-70c0-b038-f7f673ffdc1e - f253066ab39d0225a230f0547c4c7d4169f386a3)

- 2026-11-12 11:28: Accept omitted hosted executor metadata. (authoring-run/b8442d2f-2982-4cf1-8421-13f99290aa97 - b80d084ba843cb8e9ff99e9550bb35dcf6b820f6)

- 2026-11-05 21:02: Trace plugin JSON refusal. (authoring-run/ead82952-8ee4-4f4a-82fe-148da7fa2edc - 3768cfd0d640f450f485cb334b6753ac1e5ea1c3)

- 2026-11-05 13:37: Trace plugin-policy refusal recovery. (authoring-run/9cb771c4-f1a8-44ec-a4ef-7c914a5ddb6e - a8259883139ac831b32c0a7b0fe872f6db4ee290)

- 2026-11-05 04:01: Trace Namespace publication, pinned skill delivery and imported MCP enforcement. (authoring-run/01a1a93c-472f-70c0-b038-f7f673ffdc1e - d4c9146f564444412e93181b3b6b6c9c1e3b4820)

- 2026-11-05 01:02: Select the Harness catalog and recheck its identity before cutover. (01a169f0-a851-7b81-8e83-ff597893aa21 - 0e9575278)

- 2026-11-03 01:40: Trace startup of multiple managed packages on one dedicated Agent. (authoring-run/e29308a5-ef76-4952-b439-23483c4dbd99 - 54b2a30498f690e2a16a3198e84a6363f69d91ae)

- 2026-11-03 01:10: Describe hosted MCP packages and Driver-owned request policy. (authoring-run/1bd8c7a3-997a-45b2-93a4-e24d114c9ca8 - 4178b555ac5dc711c818055bd7fe34c3e4d4943b)

- 2026-11-03 00:16: Describe plugin types. (authoring-run/c005ad62-46dd-4f91-8224-3934bc3dbfe7 - e1a6ce75ac414131e759b985d280833b3b26b90e)

- 2026-11-02 23:59: Discover live MCP tools. (authoring-run/f6c72b81-af00-4c3d-9758-96b1d6ca64b1 - 6f95625048a1d20ebb5cc6e26368192b3300849c)

- 2026-11-02 23:45: Describe discovery and deployment from a managed MCP release. (authoring-run/39268f6b-739c-4af1-82dd-3ecfe85d6ffa - 5d58446a2a6e200510da738698ef832612aab50d)

- 2026-11-02 22:29: Trace the Slack account and tool selection through dedicated Agent deployment. (authoring-run/84451153-a081-4e74-aa29-e1a4acecddad - 5c0623f136d881356cec3c104b8657c761c14782)

- 2026-10-31 05:52: Classify native install failures. (authoring-run/86b48c89-0c80-493f-b48a-6999988d4766 - 6d941c15081e95ef36b4ba1ffbbbc0b117972c0a)
- 2026-10-31 03:36: Restore experimental plugin search with the upstream Codex version. (authoring-run/dc99918c-2f5c-4141-bffd-b216830017d0 - 25364fcfdc905e95b5a813a6cd7b2de47b66ca71)

- 2026-10-28 14:40: Trace worker installation and discovery of Slack MCP tools. (authoring-run/55da35a7-f123-436e-9c32-65036b85894d - 0ba3c0fd5a26a82dba6551f04b74a697c5324fdd)

[Agent plugin deployment documentation history](agent-plugins/history.md) preserves the older dated entries.
