# Agent plugins

Plugins add selected tools or integrations to an Agent. Each Agent saves its
own selections separately from its reusable [Configuration](configuration.md).
Changes apply on the next successful deployment; they do not change another
Agent or an active revision. New Agents start without user-selected plugins.

Use [Configure Agent plugins](../guides/topics/plugins-configure.md) to select,
deploy, and check a plugin. To deploy plugins, the Installation must explicitly
select a bundled [Plugin Driver](drivers/plugin.md); none is selected by
default. OpenClaw Control Plane (OCC) validates the policy shape and the selected
Driver's supported controls before saving nonempty selections. Startup still
checks catalog membership, tool ownership, authentication, and effective native
configuration.

## Current support

Embedded OpenClaw supports the bundled Diffs plugin, including its `diffs` tool,
plugin/tool enablement, and `provider_default` or `none` approval. Both choices
use the existing native execution path; neither adds a review step.
`all_actions` and `write_actions` are rejected before save. Diffs also rejects
explicit reviewer selection at either scope.

Dedicated Codex supports selected concrete apps from the
`openai-curated-remote` catalog. Its translator accepts `provider_default`,
`all_actions`, `write_actions`, and `none`, independent per-tool
enablement/approval overrides, a default reviewer, and the Codex destructive
default in `driverPolicy`. It rejects per-tool reviewers.
Nothing is selected by default. Scoped tool IDs must match the app's native
runtime inventory before startup can complete. The internal Codex catalog reader
currently returns `tools: null`. This policy interface does not provide an HTTP
catalog discovery endpoint.

These are contract and translation capabilities. Effective enforcement requires
compatible OpenClaw and Codex runtime versions and session settings that preserve
requested review. A review-requiring app default alone does not establish
effective review.
The new policy paths still need
[real Agent verification](../testing/plugins.md#current-proof-notes). There is
no bundled Claude PluginDriver.

## Lifecycle

Adding a plugin to the Agent requests installation on deployment; it does not
install a package in the controller or running Agent. Setting `enabled: false`
keeps the selection but blocks it where the runtime supports that policy.
Removing the entry clears the selection. Neither operation immediately revokes
an active tool or interrupts a turn.

Deployment freezes requested selections and owning Driver identity in the
AgentRevision. It does not freeze resolved Codex release identity, app mapping,
or rendered native configuration. Startup resolves current curated metadata and
translates it inside the Agent workload, so a retry or restart can resolve a
later curated release for the same requested catalog ID. Kubernetes retains the
native OpenClaw installation registry in the Agent-owned state database; the
existing serialized gateway replacement prevents old and new revisions from
installing concurrently. The Agent workspace retains its existing lifecycle.
Failed catalog resolution, policy translation, integrity verification, or core
authentication keeps the candidate unready. A confirmed selected-plugin install
rejection or plugin authentication requirement disables that selection while
other successfully prepared plugins can serve. Ordinary retirement removes
old workload state, but does not delete the Agent-owned database.

Read `Agent.plugins` for saved selections and the AgentRevision for the
selections requested by that deployment. Check
[deployment status](agents.md#deployment-status) for startup results.
`activeRevisionId` is not evidence that installation succeeded: the worker
records it before runtime activation completes. Saved selections remain
readable if the catalog entry or Driver disappears.

For Compute-owned Kubernetes embedded OpenClaw and dedicated Codex workloads,
a selected native install rejection produces a `PLUGIN_INSTALL_FAILED` warning.
A successful Codex install response with apps that still need authentication
produces `PLUGIN_AUTH_REQUIRED`. Deployment can succeed with these warnings once
the failed selections are explicitly disabled in the effective native and
gateway configuration. Warnings contain only the admitted selection key and a
closed code; native error text and credentials are never returned.

The requested plugin map remains unchanged. Startup creates an effective map
that disables failed selections and preserves successful selections' policies.
Dedicated Codex also blocks failed gateway bridge entries so the gateway cannot
retry their installation during a turn. Runtime restarts recompute the result
and refresh the effective configuration before serving. Failure to apply or
verify that configuration remains fatal. Transport loss, timeouts, malformed
native responses, signals, and unrelated startup failures remain unattributed
startup failures. Provider-owned Harnesses and non-Kubernetes Compute paths
retain their existing generic startup-failure behavior.

SSH Compute currently supports embedded OpenClaw without selected plugins or an
Agent default plugin approver policy. A revision with either a nonempty
requested plugin map or an Agent default approver policy (even an empty list)
is rejected before SSH host effects, including when a PluginDriver is selected.

## HTTP operations

Plugin selections and default plugin approvers are managed through the existing
Agent create/update API.
There is no separate plugin resource, install/delete endpoint, policy mutation
endpoint, or plugin-tool invocation endpoint.

| Method and path                                  | Body                                                            | Successful response                     |
| ------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------- |
| `POST /namespaces/:namespaceId/agents`           | Agent create body with optional `plugins` and `pluginApprovers` | `201`, Agent response with saved policy |
| `PATCH /namespaces/:namespaceId/agents/:agentId` | Agent update body with optional `plugins` and `pluginApprovers` | `200`, Agent response with saved policy |

Every Agent update must include `configurationId`, even when only plugins
change. Agent creation also requires `name`. See the
[Agent request contract](agents.md#editable-configuration).

Agent creation requires Agent `create` on the Namespace and the existing exact
Configuration and ServiceAccount reads. Agent update requires exact-Agent
`update` plus the existing exact Configuration and ServiceAccount reads.
Agent GET requires exact-Agent `read`. Existing Namespace and resource
checks apply.

### Request fields

Use a Driver-qualified curated plugin ID that matches the identifier grammar.
Plugin IDs are 1–253 characters matching `^[A-Za-z0-9._~:@-]+$`. Tool IDs are
opaque Driver identifiers, 1–1024 characters without spaces or control characters.
Keep them unchanged; a tool's display name is not its policy ID. Callers cannot
submit a native source, release version, or owning Driver identity. Request
objects reject unknown fields. `plugins:null` is invalid.

On Agent create, an absent `plugins` field and `{}` mean no desired user plugins.
On update, omitting `plugins` preserves the existing map, `{}` clears it, and a
nonempty object replaces the whole map, including nested policies.
On update, omitted `pluginApprovers` preserves the default; `null` restores
legacy routing; `[]` denies Slack approval.

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
field. Omission inherits that field's default. The Driver
validates unsupported fields and combinations even when the plugin or tool is
disabled. Replace an entry without an optional field to remove its override.
The former `native`, `prompt`, and `approve` approval values, top-level
`approvalMode`, and category approval fields are not accepted. Reviewer `auto`
is a distinct value.

This example enables Diffs with its tools disabled by default, then enables its
known `diffs` tool. Use the Agent's current Configuration ID and deploy after
saving:

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

Setting that plugin's `enabled` to `false` blocks it, including the enabled tool
exception. Approval cannot re-enable a disabled tool.

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
advertises `[]` at both scopes. These arrays describe translation support;
runtime availability and managed requirements still need verification.

The `approvers` capability reports whether Agent defaults, plugin overrides, and
tool overrides can be saved. These are Slack identities for plugin approval
requests, separate from `reviewer` (`human` or `auto`).

This is capability discovery, not plugin or tool discovery. It does not prove
that a particular plugin is available to the Agent's credentials.

### Response fields

Agent GET, create, and update return saved selections under `data.plugins`.
They also return `data.pluginApprovers` when an Agent default was supplied.
Existing revision and deployment-status reads describe the deployed request and
startup outcome. Successful Agent mutations and authorization denials retain
attributable audit evidence.

The [Agent reference](agents.md#deployment-status) owns generic deployment
polling. Plugin failure responses use fixed platform messages and include only
the admitted plugin ID in `error.data`. Native text, command output,
credentials, claim tokens, and workload paths are never returned.

### Agent and revision plugin fields

[Agent responses](agents.md) optionally include `plugins`, an object keyed by
plugin ID whose values are the desired selections above. An absent or empty map
means no desired selections. These fields are managed through Agent
create/update bodies.

[AgentRevision responses](api.md) optionally include a `plugins` snapshot with
the following fields. This is admitted deployment state, not another mutation
body. It freezes requested state, not resolved native release metadata.

| Revision `plugins` field | Type                      | Meaning                                                |
| ------------------------ | ------------------------- | ------------------------------------------------------ |
| `driver`                 | Driver identity object    | Required `id` and `implementation` strings.            |
| `plugins`                | Object keyed by plugin ID | Frozen requested selections, matching `Agent.plugins`. |

`AgentRevision.pluginApprovers` freezes the Agent default for that deployment.

At startup, Codex translation writes native app defaults and explicit tool
settings, then configures selected-only OpenClaw bridge entries. The bridge keeps
`allow_all_plugins:false`; empty desired state keeps apps/plugins disabled.
See [native mappings](drivers/plugin-bundled.md#native-mappings-and-limits).

### Verification boundary

Source, schema, and fixture tests establish API and translation behavior. Native
runtime compatibility requires opt-in Kubernetes proof with a real Agent turn,
followed by a later deployment that disables or removes the selection and leaves
another Agent unchanged. Contributor fixture setup, service-account boundaries,
and current proof notes live in [Agent plugin testing](../testing/plugins.md).

This page documents the nested plugin wire contract. The
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

Without this policy, OpenClaw uses account-level Slack destinations (`allowFrom`
and `defaultTo`), never an implicit OCE-owner mapping. Console defaults remain
omitted until explicitly selected. Slack approval requires an authorized
destination. This policy routes runtime plugin approval requests; it creates no
review prompts and leaves exec approvals unchanged.

The Console resolves display names with the selected same-Namespace bot Secret
and stores IDs. Lookup requires Agent edit and Secret `operate` permission.
Operators can paste user IDs without lookup. The
[Slack Channel Driver](drivers/slack-channel.md) describes workspace display,
scopes, and pagination. The Secret stays on the server.

| `approval`         | Requested behavior                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `provider_default` | Let the Harness decide when review is needed. This does not select the automatic reviewer.       |
| `all_actions`      | Request review for every enabled action through the effective reviewer.                          |
| `write_actions`    | Request review for write and destructive actions, including actions not identified as read-only. |
| `none`             | Do not add a plugin approval step; other restrictions still apply.                               |

Resolve enablement, approval, and supported reviewer choices independently.
An explicit tool field overrides its matching `toolDefaults` field. If
enablement is omitted at both levels, native defaults apply. If approval is
omitted at both levels, use `provider_default`. An explicit tool
`approval:"provider_default"` replaces an inherited approval mode.
Reviewer omission inherits the effective Harness reviewer; OCE supplies no
universal reviewer default. Disabling the plugin is terminal. Native/operator
denies, managed requirements, and workload controls still apply; an OCE override
cannot bypass them. There is no configurable precedence switch or
category-to-tool expansion. Codex writes an app approval default, so newly added
actions inherit it without a tool inventory; explicit tool overrides still need
an observed owned tool ID.

### Reviewer

Approval controls **when** review is required. Reviewer controls **who** reviews:
`human` or `auto`. Automatic review can deny a call. Selecting a reviewer does
not force review when the approval mode would skip it, and cannot weaken
mandatory review.

Codex translates `toolDefaults.reviewer` to native app `approvals_reviewer`:
`human` maps to `user`, and `auto` to `auto_review`. Native Codex has no per-tool
reviewer setting, so explicit `tools.<toolId>.reviewer` values are rejected rather
than applied to the whole app. Diffs rejects explicit reviewers at either scope.
Unsupported choices fail even if the tool is disabled or the value matches an
inherited reviewer. Reviewer does not belong in `driverPolicy`.

For explicit Codex reviewers, startup checks effective app/account reviewer
settings and managed requirements. Automatic review requires current session
approval `on-request` or `granular`; a human reviewer must satisfy current-model
requirements. These checks do not establish reviewer routing after session or
model changes. See [native limits](drivers/plugin-bundled.md#native-mappings-and-limits).

### Codex-specific policy

Codex accepts one flat `driverPolicy` field: `destructiveEnabled`, the native app
default for tools classified as destructive. Explicit tool enablement can
override it. Do not combine it with an explicit `toolDefaults.enabled`: native
default tool enablement bypasses category filtering, so the Driver rejects that
combination. Codex treats unknown destructive annotations as destructive.

This selection fragment asks a human to review Codex actions that are not marked
read-only. It requires a compatible effective session; it is not a complete Agent
update:

```json
{
  "enabled": true,
  "toolDefaults": { "approval": "write_actions", "reviewer": "human" }
}
```

Codex tool IDs encode both app ownership and the exact native tool name; two apps
can expose the same name without sharing a policy. Runtime discovery verifies
that each requested tool belongs to the selected plugin. Unknown metadata is
`tools:null`; `tools:[]` means the observed inventory was empty for that read,
not that the remote tool set can never change. Destructive/write catalog
annotations are optional and are not required to express an explicit tool
override. See the [Codex mapping](drivers/plugin-bundled.md#native-mappings-and-limits)
for its native review trigger.

## Failures and boundaries

- `400`: invalid body or policy unsupported by the selected Driver.
- `403`: denied exact-Agent permission.
- `404`: missing or foreign Agent or Configuration.
- `409`: ordinary Agent conflict, such as duplicate name.
- `503`: temporarily unavailable platform dependency.

Errors use `{error,meta:{requestId}}`, with no top-level `data` field. The
[generated API reference](api.md) owns the full error envelope shape.

Invalid policy writes fail atomically before save. Nonempty selections require
a selected PluginDriver; a missing Driver produces `501 NOT_IMPLEMENTED`. OCC
revalidates policy at deployment admission. Catalog membership, native tool
ownership, authentication, runtime compatibility, and raw native approver lists
that conflict with inherited Agent policy remain startup checks. Their failures
leave the candidate failed or unready; they do not change the earlier Agent write.

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
