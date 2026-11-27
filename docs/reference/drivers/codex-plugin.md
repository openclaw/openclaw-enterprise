---
kind: reference/driver/impl
---

# Codex Plugin Driver

**Contents**

- [Overview](#overview)
- [Lifecycle](#lifecycle)
- [Configuration](#configuration)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)

## Overview

Use the Codex Plugin Driver to offer selected apps and skills to dedicated Codex
Agents. It implements the [PluginDriver contract](plugin.md) as
`occ/codex-plugin`, selected with `codex-plugin` in trusted Installation YAML.
The Driver discovers plugins, reports supported policy, and validates selections.
Compute prepares the native Codex runtime and the selected-only OpenClaw bridge.
The [Agent plugin reference](../agent-plugins.md) owns the shared Agent API and
policy fields.

The Driver supports two discovery sources. `hosted`, the default, searches the
ChatGPT plugin service's GLOBAL catalog using a CredentialService Source for a Codex
personal access token (PAT) or Codex OAuth login. `openai-curated` searches recorded
catalog entries without a discovery credential. Both use selection IDs of the
form `codex-plugin:<plugin>@openai-curated-remote`; neither source grants app or
workspace access.

The recorded catalog includes Linear, Slack, GitHub, Notion, Figma, Canva,
Datadog, Sentry, Adobe, Coursera Learning, and Google Contacts. Recorded entries
have no tool inventory or account-specific availability. Sentry is unavailable
because its recorded release has no concrete supported hosted app. Details accept
the entry's `remoteId` or selection `id`. See the
[Codex plugin guide](../../guides/integrations/codex-plugins.md) for a complete
Agent workflow.

## Lifecycle

### Discover and save

Hosted discovery reads GLOBAL pages of up to 20 entries and fetches tool details
on demand. Queries use hosted search. Requests have a 15-second deadline and a
4 MiB response limit. Discovery does not install packages, read the operator's
Codex home, return download URLs, or verify external app connections. The Console
preloads and reuses the first page, waits 300 ms after the last search keystroke,
and cancels pending discovery when the picker closes or its credential changes.
The bundled catalog searches its local entries.

OCC validates policy before saving an Agent and again at deployment admission.
Deployment saves requested selections and the selected Driver identity in an
Agent revision. It does not save resolved Codex release metadata or app mappings.
A startup retry or restart can therefore resolve a later curated release for the
same selection ID. See the [Agent lifecycle](../agent-plugins.md#lifecycle).

### Prepare and verify the runtime

Compute starts Codex with an isolated `CODEX_HOME`. Before each startup it
replaces its owned configuration and disables app and plugin defaults with
`apps._default.enabled=false` and `plugins._default.enabled=false`. An empty
selection disables these features and skips remote plugin RPCs. Operator plugin
directories and configuration are not imported.

For enabled selections, startup resolves native metadata through `plugin/search`
and `plugin/read`. It grants exactly the selected native `name@marketplace` IDs
before `plugin/install` so authentication setup can run. It then rechecks release
identity, version, apps, and reported components. Only after those checks succeed
does it write final plugin, app, and tool grants. Failed and disabled selections
receive disabled entries; unselected apps remain disabled. An explicitly enabled
unselected plugin blocks readiness. Entries without `enabled` inherit default-off;
approval-only or MCP-policy-only entries do not activate a plugin. Account and
source restrictions can still prevent activation.

Startup reads merged workspace configuration before writing inherited tool and
account approvals: replacing a table alone cannot remove descendants from lower
configuration layers. It writes tool enablement only when a tool override or
default explicitly supplies it. Readback must match the requested policy before
readiness. It rejects unexpected tool enablement, category defaults, exposure
restrictions, enabled unselected apps, and mismatched nested approvals. Category
values resolve from the requested app, then the requested global setting, then
native `true`; equivalent explicit values are accepted. Omitted reviewers and
serialized nulls preserve inheritance. Native managed requirements remain in
force.

The selected-only OpenClaw bridge keeps `allow_all_plugins:false` and entries for
selected plugins. It normally uses `allow_destructive_actions:"auto"` to route
native review requests; `destructiveEnabled:false` preserves a native category
default of `false`. Gateway startup rejects a conflicting raw `codexPlugins`
bridge or plugin policy that disables the required Codex transport plugin.
Dedicated Agents also enforce the
[Gateway tool policy](../configuration.md#gateway-tool-policy).

Codex owns its private package cache and integrity records. OCE verifies native
API metadata and loaded configuration; it does not parse cache version directories.
Kubernetes reports only the admitted plugin key and a closed warning code for a
confirmed selected installation failure (`PLUGIN_INSTALL_FAILED`) or a successful
installation whose apps still need authentication (`PLUGIN_AUTH_REQUIRED`). Other
plugins can serve. Discovery, transport, timeout, malformed response, policy, and
verification failures remain startup failures. The worker retries the candidate;
it does not promise automatic rollback or uninterrupted replacement. Disabling a
selection does not uninstall an account-wide remote installation. See the
[native preparation flow](../../flows/agent-plugins.md#4-prepare-native-runtime-state-and-hand-off-readiness).

## Configuration

Declare Driver settings in trusted Installation YAML. Apply Installation changes
through the normal controller configuration lifecycle. Agent selection changes
apply on the next successful Agent deployment.

| Setting                          | Type   | Requirement | Value, default, and constraints                                            |
| -------------------------------- | ------ | ----------- | -------------------------------------------------------------------------- |
| `drivers.plugin[].id`            | string | Required    | `codex-plugin`; implementation `occ/codex-plugin`.                         |
| `drivers.plugin[].configuration` | object | Required    | Driver settings; `{}` selects hosted discovery. Unknown keys are rejected. |

Settings inside `configuration`:

| Setting            | Type    | Requirement | Value, default, and constraints                                                                  |
| ------------------ | ------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `catalogSource`    | string  | Optional    | `hosted` (default) or `openai-curated`.                                                          |
| `codexExecutable`  | string  | Optional    | Nonempty executable path for the controller-side native catalog reader. Requires `codexHome`.    |
| `codexHome`        | string  | Optional    | Nonempty, separately authenticated Codex home for the native reader. Requires `codexExecutable`. |
| `requestTimeoutMs` | integer | Optional    | Native reader timeout, 1–60,000 ms; default 10,000 ms. Requires both reader paths.               |

Minimal credential-free discovery configuration:

```yaml
drivers:
  plugin:
    - id: codex-plugin
      configuration:
        catalogSource: openai-curated
```

For hosted discovery, omit `catalogSource` or set it to `hosted`. Select an
authorized Codex PAT or OAuth Source in the Agent's Namespace. An issued
ServiceAccount PAT has its own Source. The API needs DNS and HTTPS access to
`auth.openai.com` and `chatgpt.com`. See [hosted discovery connectivity](../../guides/deploy/installation-profiles.md#hosted-discovery-connectivity).
Enable the plugins and connect external apps for the same ChatGPT workspace
and identity. A ChatGPT login is required for native remote
installation; an API-key login receives `PLUGIN_AUTH_REQUIRED` when best-effort
preparation can report authentication warnings.

The optional native reader serves explicit controller-side `listCatalog` calls in
hosted mode. Configure `codexExecutable` and `codexHome` together, provision that
home with separate ChatGPT-backed authentication, and optionally set
`requestTimeoutMs`. The reader starts app-server, calls `account/read` and
`plugin/list`, and may update its cache. Without it, an explicit hosted
`listCatalog` call fails; HTTP hosted discovery and supported Agent deployment do
not require the reader. The reader currently returns `tools:null`.

### Agent policy mapping

Use the shared [Agent plugin fields](../agent-plugins.md#request-fields) on Agent
create or update. An enabled selection can set these Codex-specific values:

| Setting                           | Type    | Requirement | Value, default, and constraints                                                                               |
| --------------------------------- | ------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `enabled`                         | boolean | Required    | Master plugin switch; a tool override cannot enable a disabled plugin.                                        |
| `toolDefaults.approval`           | string  | Optional    | `provider_default` → native `auto`; `all_actions` → `prompt`; `write_actions` → `writes`; `none` → `approve`. |
| `toolDefaults.enabled`            | boolean | Optional    | Native app `default_tools_enabled`; omit when setting `driverPolicy.destructiveEnabled`.                      |
| `toolDefaults.reviewer`           | string  | Optional    | `human` → native `user`; `auto` → `auto_review`; omission inherits the Harness reviewer.                      |
| `driverPolicy.destructiveEnabled` | boolean | Optional    | Native app `destructive_enabled`. Cannot be combined with explicit `toolDefaults.enabled`.                    |
| `tools.<toolId>.enabled`          | boolean | Optional    | Exact scoped tool enablement override.                                                                        |
| `tools.<toolId>.approval`         | string  | Optional    | Exact scoped tool approval override, using the same mapping as the default.                                   |

Tool IDs are `encodeURIComponent(appId) + "/" + encodeURIComponent(toolName)`;
treat them as opaque. Startup uses authenticated `mcpServerStatus/list`
`codex_apps` inventory and connector ownership. It binds hosted catalog action
names to native runtime tool names through `_meta._codex_apps.resource_uri` only
when connector IDs agree. Unknown, unowned, ambiguous, or duplicate native targets
fail startup. App defaults also cover actions added later and are not expanded
into tool rules. `write_actions` requests review unless `readOnlyHint:true`, even
when the hint is absent. `none` removes only the added plugin review step.

For an explicit reviewer, startup checks app and link reviewer values against
`configRequirements/read` and `allowedApprovalsReviewers`. Automatic review needs
current native approval policy `on-request` or `granular`. For automatic review,
Agent admission requires configured `appServer.approvalPolicy` to be `on-request`
or `on-failure`; Compute maps `on-failure` to native `on-request`. Human review
fails when managed
`requiredOnModels` includes the current model, or model selection cannot be
verified against a nonempty requirement. Omitted reviewers do not trigger those
explicit-choice checks. See [reviewer constraints](../agent-plugins.md#reviewer)
and [Codex policy](../agent-plugins.md#codex-specific-policy).

## Limits

- OCE accepts only the curated remote marketplace. Arbitrary marketplace names,
  plugin sources, versions, and external Plugin Driver packages are rejected.
- Supported releases contain concrete apps, skills, or both. Reported hooks,
  plugin MCP servers, scheduled tasks, and template-only releases are unsupported.
  Startup checks metadata, not bundle contents; selecting a package activates its
  complete native bundle, including unreported components. There is no component
  sandbox. Skills do not grant app tool permissions.
- Per-tool reviewers and plugin- or tool-specific Slack approvers are rejected.
  Only Agent-wide `pluginApprovers` is supported for Slack delivery.
- A compatible Codex build must enforce plugin defaults; older binaries can echo
  settings without enforcing them. The selected-only bridge requires compatible
  OpenClaw changes, including [#151260](https://github.com/openclaw/openclaw/pull/151260)
  and [#152085](https://github.com/openclaw/openclaw/pull/152085).
- These app and plugin settings are ordinary layered configuration, not enterprise
  requirements. Later workspace, session, or model changes and direct host
  `mcpServer/tool/call` are outside the startup guarantee. A permissive session
  with approval policy `never` can bypass MCP review unless strict review applies.
  An app-level approval default alone does not prove enforcement.
- Complete native effective-policy introspection and real Kubernetes Agent
  verification remain acceptance requirements. See the
  [current proof notes](../../testing/plugins.md#current-proof-notes).

## Troubleshooting

| Symptom                                 | First check and corrective action                                                                                                                                       | Expected result                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Hosted discovery fails                  | Check the credential's workspace and API egress to `auth.openai.com` and `chatgpt.com`. Refresh the credential or correct egress, then load plugins again.              | Discovery returns accessible GLOBAL entries.                                                |
| Explicit `listCatalog` fails            | Check that both native reader paths are configured and that `codexHome` has a ChatGPT-backed login.                                                                     | The reader returns curated marketplace entries.                                             |
| A catalog entry is unavailable          | Read its reported reason. Check workspace access, plan eligibility, required app access, and supported components.                                                      | A supported accessible entry becomes selectable; unsupported components remain unavailable. |
| `PLUGIN_AUTH_REQUIRED`                  | Check the Agent's ChatGPT login and the selected app connection in the same workspace. Connect the app and deploy again.                                                | Startup prepares the selection without that warning.                                        |
| `PLUGIN_INSTALL_FAILED`                 | Check the admitted plugin key, current catalog metadata, and runtime compatibility. Correct the selection or runtime and deploy again.                                  | Installation succeeds or the failed selection remains disabled with a warning.              |
| Startup rejects tool or reviewer policy | Check scoped tool ownership, duplicate targets, session approval policy, managed reviewer/model requirements, and raw bridge conflicts. Correct the draft and redeploy. | Native configuration readback matches the selected policy and the workload becomes ready.   |
| No approval appears during a call       | Check effective session approval and reviewer settings, then use a normal Agent turn to verify the decision and execution.                                              | A review-required call waits for the configured reviewer.                                   |
