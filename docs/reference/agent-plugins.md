# Agent plugins

An Agent owns desired plugin selections independently of its reusable
[Configuration](configuration.md). Plugin changes take effect on the next
successful deployment. They never modify another Agent or an active revision.
The Installation selects one bundled [PluginDriver](drivers/plugin.md). Agent
create/update stores structurally valid desired policy; Agent startup resolves
the current curated catalog metadata, validates native support, and translates
policy into runtime configuration.

## Current support

OpenClaw supports the bundled Diffs selection, plugin enable/disable, and
`always`/`never` policy. All curated catalog entries currently return
`tools:null`, so saved tool and category policy starts a candidate that fails
or remains unready with startup diagnostics.

Codex discovers installable entries from the existing `openai-curated-remote`
catalog, supports a plugin-free runtime baseline, and enables selected-only
curated apps for dedicated Codex Agents when the requested policy can be
represented by the existing OpenClaw Codex bridge.
`approvalMode:"auto"` enables a selected curated app with native Codex auto
approval semantics; `approvalMode:"never"` or `enabled:false` renders a blocked
bridge entry. Enterprise API fields use camelCase. The optional
`approvalsReviewer` value maps to native Codex app
reviewer configuration. Codex `always` maps to per-plugin `allow_destructive_actions:true`: supported approval
requests are accepted without a user prompt. `always` with explicit
`approvalsReviewer:"auto_review"` fails startup because native AutoReview can run
before the bridge receives the request. `prompt`, category overrides, and tool
overrides fail startup when the native runtime cannot represent them exactly.
Linear and Google Calendar are test fixtures, not production allowlist entries.

## Lifecycle

New Agents have no desired user plugins. Adding a plugin map entry records
install intent; it does not install a package in the controller or running
Agent. Setting `enabled:false` retains the selection but blocks it at runtime
when represented natively. Removing the map entry removes desired selection.
Neither operation immediately revokes an active tool or interrupts a turn.

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

Read `Agent.plugins` for saved selections and the active AgentRevision for its
requested plugin snapshot. Check deployment status for startup outcomes;
`activeRevisionId` alone is not installation evidence because the worker records
the pointer before runtime activation completes. Saved configuration remains
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

SSH Compute currently supports plugin-free embedded OpenClaw only. A revision
with any nonempty requested plugin map is rejected before SSH host effects,
including when a PluginDriver is selected.

## HTTP operations

Plugin selections are managed through the existing Agent create/update API.
There is no separate plugin resource, install/delete endpoint, policy mutation
endpoint, or plugin-tool invocation endpoint.

| Method and path                                  | Body                                          | Successful response                            |
| ------------------------------------------------ | --------------------------------------------- | ---------------------------------------------- |
| `POST /namespaces/:namespaceId/agents`           | Agent create body with optional `plugins` map | `201`, Agent response containing the saved map |
| `PATCH /namespaces/:namespaceId/agents/:agentId` | Agent update body with optional `plugins` map | `200`, Agent response containing the saved map |

Agent creation requires Agent `create` on the Namespace and the existing exact
Configuration and ServiceAccount reads. Agent update requires exact-Agent
`update` plus the existing exact Configuration and ServiceAccount reads.
Agent GET requires exact-Agent `read`. Existing Namespace and resource
checks apply.

### Request fields

Use a Driver-qualified curated plugin ID that matches the identifier grammar.
Catalog membership is resolved at Agent startup. Plugin and tool IDs are 1-253
characters matching `^[A-Za-z0-9._~:@-]+$`. Callers cannot submit a native
identity, Driver identity, source, version, or arbitrary settings. Request
objects reject unknown fields. `plugins:null` is invalid.

On Agent create, an absent `plugins` field and `{}` both mean no desired user
plugins. On Agent update, omitting `plugins` preserves the existing map, `{}` clears
all desired plugins, and any nonempty object replaces the whole map. The update
does not merge plugin entries or nested tool policies.

In the tables below, **mode** means `always`, `never`, `prompt`, or `auto`.
Structural validity does not imply native support; startup validates the
complete requested selection against the selected Driver and native runtime.

| Plugin map value field        | Type                             | Behavior                                                                   |
| ----------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `enabled`                     | Boolean                          | Required plugin enablement intent.                                         |
| `approvalMode`                | Mode                             | Required plugin default.                                                   |
| `approvalsReviewer`           | Optional `user` or `auto_review` | Omission inherits native review settings.                                  |
| `destructiveActions`          | Optional mode                    | Category override applied at startup when native metadata supports it.     |
| `writes`                      | Optional mode                    | Category override applied at startup when native metadata supports it.     |
| `tools`                       | Optional object keyed by tool ID | Tool overrides applied at startup when authoritative metadata supports it. |
| `tools.<toolId>.enabled`      | Optional Boolean                 | Explicit tool enablement override.                                         |
| `tools.<toolId>.approvalMode` | Optional mode                    | Explicit tool approval override.                                           |

Each supplied tool override must contain `enabled`, `approvalMode`, or both.
Omitted optional fields inherit the plugin/category/native policy. To remove an
optional override, replace the plugin entry without that field. To remove one
tool override, replace the `tools` map without that tool ID. To remove all
plugin selections, update the Agent with `"plugins": {}`.

For example, create or update an Agent with the available OpenClaw entry, then
explicitly deploy the Agent:

```json
{
  "plugins": {
    "occ-plugin:diffs": {
      "enabled": true,
      "approvalMode": "always"
    }
  }
}
```

A later Agent update can disable that selection without deleting it:

```json
{
  "plugins": {
    "occ-plugin:diffs": {
      "enabled": false,
      "approvalMode": "always"
    }
  }
}
```

The following illustrates the nested request shape only. The current Diffs
catalog lacks reliable tool metadata, so this can be saved as desired state but
will fail the deployment/startup candidate with startup diagnostics:

```json
{
  "plugins": {
    "occ-plugin:diffs": {
      "enabled": true,
      "approvalMode": "auto",
      "destructiveActions": "never",
      "writes": "prompt",
      "tools": {
        "example_tool": { "enabled": true, "approvalMode": "always" }
      }
    }
  }
}
```

### Response fields

Agent GET, create, and update return saved selections under `data.plugins`.
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

At startup, Codex translation uses native Codex app settings and, when a
supported curated Codex app is selected, OpenClaw Codex bridge configuration.
The active native configuration sets the selected app entry to `enabled:true`
and optional native `approvals_reviewer`, translated from Enterprise
`approvalsReviewer`. The bridge configuration sets
`plugins.entries.codex.config.codexPlugins.enabled` to true, keeps
`allow_all_plugins:false`, and includes one entry per selected plugin. Empty
desired state keeps apps/plugins disabled.

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

| `approvalMode` | Requested behavior                                                                        |
| -------------- | ----------------------------------------------------------------------------------------- |
| `always`       | No plugin approval step; authorization and other restrictions still apply.                |
| `never`        | Block tool execution.                                                                     |
| `prompt`       | Request review for each call through the effective reviewer.                              |
| `auto`         | Use native Codex annotation and remembered-approval behavior to decide whether to review. |

`approvalsReviewer` independently selects `user` or `auto_review`. It does not
force review: `auto` can skip review, while `prompt` requests review for every
call. An absent reviewer inherits the native setting.

For enabled tools, requested precedence is explicit tool mode, then the
stricter applicable category override, then the plugin default. Category
strictness is `never > prompt > auto > always`. Disabled plugins/tools cannot be
re-enabled by a mode override. Destructive means native `destructiveHint=true`;
missing destructive metadata is conservative. Writes means native
`readOnlyHint` is not true. Classification never uses a tool's name.

The API saves structurally valid policy without proving that the selected
Driver can represent it exactly. Startup performs that validation. See
[native mappings and current limits](drivers/plugin.md#native-mappings-and-limits).
Unknown tool metadata produces `tools:null`; tool/category selections then fail
the deployment/startup candidate when the selected Driver cannot represent them.

## Failures and boundaries

- `400`: invalid body or identity/source fields.
- `403`: denied exact-Agent permission.
- `404`: missing or foreign Agent or Configuration.
- `409`: ordinary Agent conflict, such as duplicate name.
- `503`: temporarily unavailable platform dependency.

Errors use `{error,meta:{requestId}}`, with no `data` field. The
[generated API reference](api.md) owns the full error envelope shape.

Structurally invalid Agent writes fail atomically before save. Catalog
membership, native metadata, and policy representability are startup concerns:
unsupported behavior is reported through the existing failed or unready
candidate path and does not change the earlier Agent write or deployment
response into HTTP 501. Authentication, installation, and transport failures
remain failures of those operations.

Namespace plugin configuration, arbitrary catalogs, importing an owner's Codex
configuration, plugin-specific settings/credential APIs, Code Mode, and new
plugin permission restrictions are outside this feature. Existing sandbox,
network, filesystem, managed policy, and authorization controls remain in force.
An approval setting does not grant filesystem access or isolate plugin code.

## Related documentation

- [PluginDriver](drivers/plugin.md): selection, catalogs, mapping, and runtime limits.
- [Agent plugin flow](../flows/agent-plugins.md): request, admission, and preparation.
- [Agent plugin testing](../testing/plugins.md): contributor fixtures and proof notes.
- [Agent lifecycle](agents.md) and [deployment](../guides/deploy.md).
