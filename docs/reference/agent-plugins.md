# Agent plugins

Plugins add selected tools or integrations to an Agent. Each Agent saves its
own selections separately from its reusable [Configuration](configuration.md).
Changes apply on the next successful deployment; they do not change another
Agent or an active revision. New Agents start without user-selected plugins.

Use [Configure Agent plugins](../guides/topics/plugins-configure.md) to select,
deploy, and check a plugin. Deploying plugins requires the Installation to
select a bundled [Plugin Driver](drivers/plugin.md); none is selected by
default. OpenClaw Control Plane (OCC) validates the policy shape and the selected
Driver's supported controls before saving nonempty selections; startup performs
the [remaining checks](#failures-and-boundaries).

## Current support

Embedded OpenClaw supports the bundled Diffs plugin and its `diffs` tool, with
plugin/tool enablement and `provider_default` or `none` approval. Both use the
existing native execution path without a review step. Diffs rejects
`all_actions`, `write_actions`, and explicit reviewers at either scope before save.

Dedicated Codex supports selected concrete apps from the
`openai-curated-remote` catalog, served only to ChatGPT logins; API-key Agents
get `PLUGIN_AUTH_REQUIRED` at once. Its translator accepts all four approval
modes, independent per-tool enablement/approval overrides, a default reviewer,
and the Codex destructive default in `driverPolicy`, but rejects per-tool
reviewers. Scoped tool IDs must match the app's native runtime inventory before
startup can complete; the internal Codex catalog reader currently returns
`tools: null`.

Effective enforcement of these contract and translation capabilities requires
compatible OpenClaw and Codex runtime versions and session settings that preserve
requested review; a review-requiring app default alone does not establish it.
The new policy paths still need
[real Agent verification](../testing/plugins.md#current-proof-notes). There is
no bundled Claude PluginDriver.

**Experimental** OAuth discovery needs [login](../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login).

## Lifecycle

Adding a plugin requests installation on the next deployment; it does not
install a package in the controller or running Agent. Setting `enabled: false`
keeps the selection but blocks it where the runtime supports that policy.
Removing the entry clears the selection. Neither operation immediately revokes
an active tool or interrupts a turn.

Deployment freezes requested selections and owning Driver identity in the
AgentRevision, not the resolved Codex release, app mapping, or rendered native
configuration. Startup resolves and translates current curated metadata inside
the Agent workload, so a retry or restart can resolve a later curated release
for the same catalog ID. Kubernetes keeps the native OpenClaw installation
registry in the Agent-owned state database; serialized gateway replacement
prevents old and new revisions from installing concurrently. The Agent
workspace keeps its existing lifecycle. Ordinary retirement removes old
workload state but not the Agent-owned database.

Failed catalog resolution, policy translation, integrity verification, or core
authentication keeps the candidate unready. A confirmed selected-plugin install
rejection or plugin authentication requirement instead disables that selection;
other successfully prepared plugins can serve.

Check [deployment status](agents.md#deployment-status) for startup results.
`activeRevisionId` does not prove installation succeeded: the worker records it before runtime activation completes. Saved selections remain
readable if the catalog entry or Driver disappears.

For Compute-owned Kubernetes embedded OpenClaw and dedicated Codex workloads,
a selected native install rejection produces a `PLUGIN_INSTALL_FAILED` warning,
and a successful Codex install whose apps still need authentication produces
`PLUGIN_AUTH_REQUIRED`. Deployment can succeed with these warnings once the
failed selections are explicitly disabled in the effective native and gateway
configuration. Warnings contain only the admitted selection key and a closed
code, never native error text or credentials.

The requested plugin map stays unchanged; startup derives an effective map that
disables failed selections and keeps successful selections' policies.
Dedicated Codex also blocks failed gateway bridge entries so the gateway cannot
retry their installation during a turn. Restarts recompute this before serving;
failure to apply or verify it is fatal. Other failures, such as transport loss
or timeouts, remain ordinary startup failures, as do all failures on
provider-owned Harnesses and non-Kubernetes Compute paths; see
[native preparation](../flows/agent-plugins.md#4-prepare-native-runtime-state-and-hand-off-readiness).

SSH Compute supports embedded OpenClaw only without plugin policy. Before host
effects, it rejects any revision with a nonempty requested plugin map or an Agent
default plugin approver policy (even an empty list), even when a PluginDriver is
selected.

## HTTP operations

Plugin selections and default plugin approvers use the existing Agent
create/update API. There is no separate plugin resource or install, delete,
policy mutation, or plugin-tool invocation endpoint.

| Method and path                                  | Body                                                            | Successful response                     |
| ------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------- |
| `POST /namespaces/:namespaceId/agents`           | Agent create body with optional `plugins` and `pluginApprovers` | `201`, Agent response with saved policy |
| `PATCH /namespaces/:namespaceId/agents/:agentId` | Agent update body with optional `plugins` and `pluginApprovers` | `200`, Agent response with saved policy |

Updates also require `configurationId`, and creation requires `name`; see the
[Agent request contract](agents.md#editable-configuration).

Agent creation requires Agent `create` on the Namespace; update requires
exact-Agent `update`. Both also require the existing exact Configuration and
ServiceAccount reads. Agent GET requires exact-Agent `read`. Existing Namespace
and resource checks apply.

### Request fields

Plugin IDs are Driver-qualified curated IDs of 1–253 characters matching
`^[A-Za-z0-9._~:@-]+$`. Tool IDs are opaque Driver identifiers of 1–1024
characters without spaces or control characters; keep them unchanged, since a
tool's display name is not its policy ID. Callers cannot
submit a native source, release version, or owning Driver identity. Request
objects reject unknown fields. `plugins:null` is invalid.

On Agent create, an absent `plugins` field and `{}` mean no desired user plugins.
On update, omitting `plugins` preserves the existing map, `{}` clears it, and a
nonempty object replaces the whole map, including nested policies. Omitting
`pluginApprovers` on update preserves the default, `null` restores legacy
routing, and `[]` denies Slack approval.

| Plugin map value field     | Type                                      | Behavior                                                            |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| `enabled`                  | Boolean                                   | Required plugin gate; `false` wins over every tool override.        |
| `toolDefaults.enabled`     | Optional Boolean                          | Default tool enablement, unless overridden for an individual tool.  |
| `toolDefaults.approval`    | Optional approval mode                    | Default review behavior.                                            |
| `toolDefaults.reviewer`    | Optional `human` or `auto`                | Default reviewer; omission inherits the effective Harness reviewer. |
| `approvers`                | Optional array of channel user identities | Plugin approval users; replaces `pluginApprovers` for this plugin.  |
| `tools.<toolId>.enabled`   | Optional Boolean                          | Override the tool enablement default.                               |
| `tools.<toolId>.approval`  | Optional approval mode                    | Override the approval default independently.                        |
| `tools.<toolId>.reviewer`  | Optional reviewer                         | Override the reviewer default only where the Driver supports it.    |
| `tools.<toolId>.approvers` | Optional array of channel user identities | Replaces the plugin approvers for this tool.                        |
| `driverPolicy`             | Optional object                           | Fields owned and validated by the selected Driver.                  |

Each supplied `toolDefaults` or tool override contains at least one supported
field; omitted fields inherit. The Driver validates unsupported fields and
combinations even when the plugin or tool is disabled. To remove an override,
replace the entry without that field.
The former `native`, `prompt`, and `approve` approval values, top-level
`approvalMode`, and category approval fields are not accepted. Reviewer `auto`
is a distinct value.

This example enables Diffs with tools disabled by default except its known
`diffs` tool. Deploy after saving:

```json
{
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000",
  "plugins": {
    "occ-plugin:diffs": {
      "enabled": true,
      "toolDefaults": { "enabled": false, "approval": "provider_default" },
      "tools": { "diffs": { "enabled": true } }
    }
  }
}
```

Approval cannot re-enable a disabled tool.

### Discover policy controls

Authorized `GET /installation` responses expose the selected Driver's controls
at `data.capabilities.pluginPolicies`. The field is absent when no PluginDriver
is selected. It contains:

- `driver`: the selected `id` and `implementation`.
- `toolDefaults` and `tools`: each has an `enabled` support Boolean, an `approval`
  array of supported modes, and a `reviewer` array of supported explicit reviewers.
- `driverPolicySchema`: the JSON Schema for Driver-specific fields.

An empty reviewer array means explicit selection is unsupported at that scope.
Codex advertises `["human","auto"]` for defaults and `[]` for tools. Diffs
advertises `[]` at both scopes.

The `approvers` capability reports whether Agent defaults, plugin overrides, and
tool overrides can be saved. These are Slack identities for plugin approval
requests, separate from `reviewer` (`human` or `auto`).

These capabilities describe translation support only, not runtime availability,
managed requirements, or plugin availability to the Agent's credentials.

### Response fields

Agent GET, create, and update return saved selections under `data.plugins`,
plus `data.pluginApprovers` when an Agent default was supplied. Successful Agent mutations and authorization denials retain
attributable audit evidence.

The [Agent reference](agents.md#deployment-status) owns generic deployment
polling. Plugin failure responses use fixed platform messages and include only
the admitted plugin ID in `error.data`, never native text, command output,
credentials, claim tokens, or workload paths.

### Agent and revision plugin fields

[Agent responses](agents.md) optionally include `plugins`, keyed by plugin ID
with the desired selections above; an absent or empty map means none.

[AgentRevision responses](api.md) optionally include a `plugins` snapshot of
admitted deployment state, not another mutation body.

| Revision `plugins` field | Type                      | Meaning                                                |
| ------------------------ | ------------------------- | ------------------------------------------------------ |
| `driver`                 | Driver identity object    | Required `id` and `implementation` strings.            |
| `plugins`                | Object keyed by plugin ID | Frozen requested selections, matching `Agent.plugins`. |

`AgentRevision.pluginApprovers` freezes the Agent default for that deployment.

At startup, Codex translation writes native app defaults and explicit tool
settings, then configures selected-only OpenClaw bridge entries
(`allow_all_plugins:false`); empty desired state keeps apps/plugins disabled.
See [native mappings](drivers/plugin-bundled.md#native-mappings-and-limits).

### Verification boundary

Source, schema, and fixture tests establish API and translation behavior. Native
runtime compatibility requires opt-in Kubernetes proof: a real Agent turn, then
a later deployment that disables or removes the selection and leaves another
Agent unchanged. [Agent plugin testing](../testing/plugins.md) covers
contributor fixtures, service-account boundaries, and current proof notes.

This page owns the nested plugin wire contract. The
[generated API reference](api.md) summarizes routes and top-level schemas;
[request schemas](../../packages/contracts/src/api/common.ts) and
[response schemas](../../packages/contracts/src/api/resources.ts) are the
executable definitions.

## Approval policy

### Slack approver users

`pluginApprovers` is the Agent-wide default for Slack plugin approvals. Each
entry keeps `channel: "slack"`; `id` accepts `team:T123:user:U456` or raw
`U456`/`W456`, interpreted within the selected Slack account. A plugin's
`approvers` array replaces the Agent default, and a tool's `approvers` array
replaces the plugin list. Omission inherits; an explicit empty array denies
Slack approval. Tool keys use the plugin catalog's exact composite tool ID.

Codex supports only `pluginApprovers`: its approval requests omit plugin and
tool identity, so OpenClaw would deny every request once any plugin list exists.
Agent create, update, and deploy reject Codex plugin or tool `approvers` with
`400 INVALID_REQUEST`; remove them to update or redeploy an Agent saved earlier.
Its deployed revision keeps running without working plugin approvals.

<!-- TODO(policySubject): allow Codex plugin and tool approvers once upstream
Codex plugin approval requests carry policySubject. -->

Omission uses native account destinations (`allowFrom` and `defaultTo`);
Console defaults stay omitted. This policy selects authorized reviewers for
existing plugin prompts and leaves exec approvals unchanged.

Docker and Kubernetes omit Slack policy when Slack is absent or disabled.
Otherwise the gateway validates it before launch, and incompatibility prevents
launch; see the
[compatibility check](../flows/agent-plugin-approvals.md#3-check-the-selected-gateway-before-launch).

The Console resolves display names with the selected same-Namespace bot Secret,
which stays on the server, and stores IDs. Lookup requires Agent edit and Secret
`operate` permission; operators can paste user IDs instead. The
[Slack Channel Driver](drivers/slack-channel.md) describes workspace display,
scopes, and pagination.

| `approval`         | Requested behavior                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `provider_default` | Let the Harness decide when review is needed. This does not select the automatic reviewer.       |
| `all_actions`      | Request review for every enabled action through the effective reviewer.                          |
| `write_actions`    | Request review for write and destructive actions, including actions not identified as read-only. |
| `none`             | Do not add a plugin approval step; other restrictions still apply.                               |

Enablement, approval, and supported reviewer choices resolve independently. An
explicit tool field overrides its matching `toolDefaults` field. Omitted at both
levels, enablement uses native defaults and approval uses `provider_default`; an
explicit tool `approval:"provider_default"` replaces an inherited mode.
Reviewer omission inherits the effective Harness reviewer; OCE supplies no
universal reviewer default. Disabling the plugin is terminal. Native/operator
denies, managed requirements, and workload controls still apply, and no OCE
override bypasses them. There is no precedence switch or category-to-tool
expansion. Codex writes an app approval default, so newly added
actions inherit it without a tool inventory; explicit tool overrides still need
an observed owned tool ID.

### Reviewer

Approval controls **when** review is required. Reviewer controls **who** reviews:
`human` or `auto`. Automatic review can deny a call. Selecting a reviewer does
not force review when the approval mode would skip it, and cannot weaken
mandatory review.

Codex maps `toolDefaults.reviewer` to the native app-wide reviewer. Native Codex
has no per-tool reviewer setting, so explicit `tools.<toolId>.reviewer` values
are rejected rather than applied to the whole app. Unsupported choices fail even if the tool is disabled
or the value matches an inherited reviewer. Reviewer does not belong in
`driverPolicy`.

For explicit Codex reviewers, startup checks effective reviewer settings, session
approval, and managed model requirements, but not routing after later session or
model changes. [Native limits](drivers/plugin-bundled.md#native-mappings-and-limits)
lists the value mapping and exact checks.

### Codex-specific policy

Codex accepts one flat `driverPolicy` field: `destructiveEnabled`, the native app
default for tools classified as destructive. Explicit tool enablement can
override it. The Driver rejects combining it with an explicit
`toolDefaults.enabled`, because native default tool enablement bypasses category
filtering. Codex treats unknown destructive annotations as destructive.

This selection fragment, not a complete Agent update, asks a human to review
Codex actions not marked read-only. It requires a compatible effective session:

```json
{
  "enabled": true,
  "toolDefaults": { "approval": "write_actions", "reviewer": "human" }
}
```

Codex tool IDs encode app ownership and the exact native tool name, so two apps
can expose the same name without sharing a policy. Unknown metadata is
`tools:null`; `tools:[]` means that read observed an empty inventory, not that
the remote tool set cannot change. See the
[Codex mapping](drivers/plugin-bundled.md#native-mappings-and-limits) for its
native review trigger; explicit tool overrides do not need catalog annotations.

## Failures and boundaries

- `400`: invalid body or policy unsupported by the selected Driver. A plugin ID
  outside the selected Driver's catalog (OpenClaw) or its prefix and marketplace
  (Codex), such as `occ-plugin:diffs` while `codex-plugin` is selected, names
  that Driver and the rejected plugin ID in the message, with a
  `/plugins/<id>` detail when the selection came from this request's body. A
  selection read back from storage (at deploy, at an update that omits
  `plugins`, or at a provisioning replay or retry) still names the plugin but
  has no detail. A provisioning status read does not recheck the plugin policy, so it
  still reports the work after a Plugin Driver switch.
- `403`: denied exact-Agent permission.
- `404`: missing or foreign Agent or Configuration.
- `409`: ordinary Agent conflict, such as duplicate name.
- `503`: temporarily unavailable platform dependency.

The [generated API reference](api.md) owns the error envelope.

Invalid policy writes fail atomically before save. Nonempty selections without
a selected PluginDriver fail with `501 NOT_IMPLEMENTED`. OCC revalidates policy
at deployment admission. Catalog membership, native tool ownership,
authentication, runtime compatibility, and raw native approver lists that
conflict with inherited Agent policy are startup checks; their failures leave
the candidate failed or unready without changing the earlier Agent write.

Namespace plugin configuration, arbitrary catalogs, importing an owner's Codex
configuration, plugin-specific settings/credential APIs, Code Mode, and new
plugin permission restrictions are outside this feature. Existing sandbox,
network, filesystem, managed policy, and authorization controls remain in force.
An approval setting does not grant filesystem access or isolate plugin code.

## Related documentation

- [Configure Agent plugins](../guides/topics/plugins-configure.md): save selections, deploy, and check the result.
- [Plugin Driver](drivers/plugin.md): selection, catalogs, mapping, and runtime limits.
- [Agent plugin flow](../flows/agent-plugins.md): request, admission, and preparation.
- [Agent plugin testing](../testing/plugins.md): contributor fixtures and proof notes.
- [Agent lifecycle](agents.md) and [deployment](../guides/deploy.md).
