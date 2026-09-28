# Bundled PluginDriver implementations

Use this page to configure the bundled OpenClaw and Codex Plugin Drivers and
check their native policy mappings, preparation behavior, and limitations. The
[PluginDriver base contract](plugin.md) defines the exported interface and the
boundary between OCC, PluginDriver, and Compute. The [Agent plugin reference](../agent-plugins.md)
owns the API and policy vocabulary. The
[PluginDriver feature matrix](plugin-matrix.md) preserves an older source review.

## Selection and catalogs

Select at most one bundled implementation in trusted Installation YAML:

```yaml
drivers:
  plugin:
    id: occ-plugin
    configuration: {}
```

Dedicated Codex defaults to `catalogSource: hosted`, which discovers plugins
using a PAT or a Secret containing one. Select the hardcoded OpenAI catalog in
trusted Installation YAML to browse without a discovery credential or provider
catalog requests:

```yaml
drivers:
  plugin:
    id: codex-plugin
    configuration:
      catalogSource: openai-curated
```

The curated catalog includes Linear, Slack, GitHub, Notion, Figma, Canva,
Datadog, Sentry, Adobe, Coursera Learning, and Google Contacts. Their recorded
identities and presentation metadata do not include tool inventory or
account-specific availability. Notion, Figma, Canva, and Adobe include supported
hosted apps with skills. Sentry remains unavailable because its recorded release
has no concrete hosted app. Select a plugin and set its default policy; per-tool controls are
unavailable until the catalog supplies tool details. Startup resolves native
metadata independently and still requires the Agent's actual authentication and
provider access. Catalog membership does not grant access or prove execution.

An optional controller-side native `listCatalog` reader for hosted mode uses a
separate Codex profile:

```yaml
drivers:
  plugin:
    id: codex-plugin
    configuration:
      codexExecutable: /opt/codex/bin/codex
      codexHome: /var/lib/occ/codex-catalog
      requestTimeoutMs: 10000
```

Supply `codexExecutable` and `codexHome` together. Provision that home with Codex
backend authentication, separately from the operator's ordinary profile.
`requestTimeoutMs` defaults to 10,000 milliseconds and accepts 1–60,000.
This reader starts native app-server, calls `plugin/list`, and may update its cache.

In hosted mode, Create Agent discovery hydrates entered PAT identity and reads GLOBAL
plugin-service pages of up to 20 entries, fetching tools on demand. A nonempty
query uses hosted search; the curated catalog searches its bundled entries.
The console preloads the first page after a PAT is entered or selected in Create
Agent, and when opening an editable Agent's Plugins tab with a bound PAT Secret.
Opening **Configure plugins** reuses that page or its pending request. Replacing
the PAT clears discovery results and preloads a fresh first page; selections remain.
Console waits 300 ms after the last keystroke before searching and resets pagination
when the query changes. Loading feedback starts during that delay and continues
until the response, including when no earlier entries exist. Tool lookups show
loading feedback until details arrive. Enter, page navigation, and explicit loads
run immediately. Configured-plugin and tool filters remain instant and local.
Closing the picker or changing its credential cancels pending searches. Requests have
a 15-second deadline and 4 MiB response limit. Discovery does not read Codex home,
install plugins, or return download URLs. A same-Namespace Secret reference can supply the PAT; managed ServiceAccount references are unsupported. Plugin details show available website, privacy-policy,
and terms-of-service links; invalid or non-HTTPS URLs are omitted.
Catalog discovery does not verify current app connections. Check service-account
connections in administration before deployment; OCE does not gate deployment on
this unverified status.

To configure access:

1. Open [ChatGPT workspace plugins](https://chatgpt.com/admin/plugins?catalog=GLOBAL)
   and select the same workspace as the PAT. A workspace administrator must enable
   plugin and app access for the token's user or service account.
2. For service-account app credentials, open [OpenAI Admin](https://admin.openai.com/),
   select that workspace and service account, and configure its app connections.
   Workspace enablement and service-account credentials are separate requirements.
3. Return to Create Agent and reload plugins. This refreshes catalog availability,
   not connection verification. OCE plugin policies do not grant workspace access
   or configure external credentials.

Unavailable entries explain the reported cause and link to recovery guidance:

| Cause                                                    | Next step                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Disabled by administrator                                | Ask a workspace administrator to review access for the token's identity.                            |
| Plan not eligible                                        | Ask the administrator to review workspace plan availability.                                        |
| Required app unavailable                                 | Review app access and setup; credentials alone may not resolve this.                                |
| No recognized reason                                     | Review workspace plugin access without assuming a specific cause.                                   |
| Unsupported native components or no concrete hosted apps | Check [native limits](#native-mappings-and-limits); changing ChatGPT access cannot add OCE support. |

Catalog visibility and credentials do not establish native execution or policy
enforcement. Startup independently resolves selections using the Agent's projected
credentials. Unknown configuration options, arbitrary sources or versions, and
external PluginDriver packages are rejected.

| Driver ID      | Implementation        | Agent Harness     | Catalog source                                                                                               |
| -------------- | --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `occ-plugin`   | `occ/openclaw-plugin` | Embedded OpenClaw | Bundled catalog: `occ-plugin:diffs` (`@openclaw/diffs`), pinned to `2026.8.2` and npm integrity.             |
| `codex-plugin` | `occ/codex-plugin`    | Dedicated Codex   | Native `openai-curated-remote` marketplace; selection IDs are `codex-plugin:<plugin>@openai-curated-remote`. |

Codex startup resolves current identity, release metadata, and concrete apps from
`plugin/read`'s `detail.apps`. Template metadata alone grants no app access;
plugins without concrete apps are unsupported. Template lifecycle is deferred.

No PluginDriver is selected by default. Plugin-free deployments remain permitted.
Nonempty selections require valid supported policy and the same compatible Driver
at startup. Saving does not perform authenticated discovery; saved entries remain
readable without their original Driver. SSH Compute rejects nonempty plugin maps
and Agent default plugin approver policies before host effects; plugin-free
embedded OpenClaw revisions remain supported without that policy.

## Native mappings and limits

OCC rejects unsupported policy before saving an Agent. Startup additionally
checks native metadata, tool ownership, and effective configuration. Runtime
versions and the OpenClaw-to-Codex projection constrain enforcement: emitting a
native setting does not prove an Agent thread retains it.

| Surface                                  | Current translation                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin `enabled`                         | Gate the selected plugin; disabled plugins cannot be re-enabled by tool overrides.                                                              |
| OpenClaw default/tool `enabled`          | Resolve explicit tool enablement before the default using the pinned catalog's complete tool inventory. Emit native denies for disabled tools.  |
| OpenClaw `provider_default` / `none`     | Use existing native tool execution without an added plugin approval step. Existing denies and profiles remain effective.                        |
| OpenClaw `all_actions` / `write_actions` | Reject before save; no generic per-call review is implemented. Explicit reviewers and Driver policy fields are also unsupported.                |
| Codex approval defaults                  | Write app `default_tools_approval_mode`: `provider_default` → `auto`, `all_actions` → `prompt`, `write_actions` → `writes`, `none` → `approve`. |
| Codex explicit tool overrides            | Write only supplied `enabled` and `approval_mode` fields under the owning app and exact native tool name; use the same approval mapping.        |
| Codex `toolDefaults.enabled`             | Write native `default_tools_enabled` when supplied.                                                                                             |
| Codex `toolDefaults.reviewer`            | Write app `approvals_reviewer`: `human` maps to `user`, `auto` maps to `auto_review`. Per-tool reviewers are rejected.                          |
| Codex `driverPolicy`                     | Write `destructive_enabled` when supplied. Reject destructive defaults combined with explicit default tool enablement.                          |
| Empty Codex selection                    | Disable user apps/plugins; no remote install RPC runs.                                                                                          |

OpenClaw extends a nonempty native `tools.allow`, otherwise `tools.alsoAllow`,
with the selected plugin. It preserves other native restrictions. The pinned
catalog currently exposes the `diffs` tool owned by `diffs`; adding another entry
requires verified package and tool identities. Ambiguous global tool names or
partial denials that would also deny an allowed sibling are rejected.

Codex accepts all four approval values as app defaults and explicit tool settings.
The app default also applies to actions added later; it does not require a tool
inventory. `write_actions` asks for review when the native action lacks
`readOnlyHint: true`, including when the hint is missing. `toolDefaults.reviewer`
selects the reviewer for the app as a whole; omission inherits the effective
Harness reviewer.
Automatic review can deny. `none` skips the added plugin approval step, not
other native restrictions. The bridge keeps `allow_all_plugins:false` and an
entry for each selected plugin. Its normal
`allow_destructive_actions:"auto"` routes native review requests; an explicit
`destructiveEnabled:false` uses `false` to preserve that native category default.

Codex tool policy IDs are
`encodeURIComponent(appId) + "/" + encodeURIComponent(toolName)`. Treat
these as opaque. Hosted discovery uses the catalog action name; native inventory
IDs use the runtime tool name. At startup, `mcpServerStatus/list` supplies
authenticated `codex_apps` names and connector ownership. Its
`_meta._codex_apps.resource_uri` binds a catalog action to the observed native name
when the connector IDs match. Unknown, unowned, or ambiguous IDs fail startup,
as do two selected IDs targeting the same native tool.
Catalog classifications are not required, and app defaults are not expanded into
per-tool rules. The optional controller catalog reader still returns `tools:null`.

Codex plugins must expose concrete hosted apps and may include skills. Native
Codex installs the selected bundle and loads its skill instructions; OCE does not
repackage or translate them. Skills grant no additional app tool permissions.
Hooks, native MCP servers, and scheduled tasks remain unsupported, as do skill-only
and template-only plugins without concrete apps.

OCE selection constrains hosted app tools through native app policy and the
OpenClaw bridge. It does not restrict skills from other plugins already enabled
on the credential's account. Limiting those plugins requires separate native
plugin default enablement support and OCE startup integration.
The selected-only OpenClaw bridge is required for the dedicated Agent path.
Effective nested policy requires the bridge changes in
[OpenClaw #151260](https://github.com/openclaw/openclaw/pull/151260) and
[#152085](https://github.com/openclaw/openclaw/pull/152085), a compatible packaged
runtime, effective session settings that preserve review, and real Agent
verification. Codex can bypass MCP review when session approval is `never` with
a permissive profile unless strict review applies; writing an app-level
`all_actions` or `write_actions` default alone is insufficient. Source and fixture
checks do not establish that proof.

For an explicit app reviewer, startup reads `configRequirements/read`, compares
app/link reviewer values, and checks `allowedApprovalsReviewers`. Automatic review
requires current approval policy `on-request` or `granular`. Human review fails
if managed `requiredOnModels` includes the current model, or model selection
cannot be verified against a nonempty requirement. Omitted reviewers do not
trigger these explicit-choice checks.

Startup reads merged workspace configuration, explicitly disables unselected apps,
and writes admitted approval values at inherited tool/account keys. Table replacement
alone cannot remove lower-layer descendants. Tool enablement is replaced only when
explicitly specified by an override or default; these writes leave native managed
requirements unchanged.

Readback must match the selected policy before readiness. Unselected disabled apps,
serialized nulls, and omitted reviewers preserve inheritance. Category values resolve
requested app → requested global → native `true`; equivalent explicit values pass.
Nested tool enablement/approval must match its override or app default, and account
approval must match its app. Unexpected tool enablement, category defaults, exposure
restrictions, and enabled unselected apps fail verification.

This verifies loaded startup configuration, including trusted workspace layers.
Codex 0.156 does not expose managed app/tool requirements through `config/read` or
`configRequirements/read`; complete native effective-policy introspection remains
required. Later workspace/session/model changes, strict review, and real Agent
enforcement also remain acceptance gates. See
[runtime proof notes](../../testing/plugins.md#current-proof-notes).

Dedicated Codex starts without user plugins/apps, including when no PluginDriver
is selected. Compute writes the safe baseline into the Agent's isolated
`CODEX_HOME`, with native plugin loading and remote plugin loading disabled.
When a supported curated Codex app is selected, startup reads native catalog
detail, writes the selected app entry with `enabled:true`, and applies the
selected-only OpenClaw bridge configuration during native preparation. The
Driver's optional internal catalog reader remains available; the required OpenClaw Codex
transport plugin is separate infrastructure. Operator plugin directories and
configuration are never imported.

The Driver rejects conflicting raw Configuration for its managed fields rather
than silently overwriting it. For OpenClaw, this includes an existing selected
plugin entry in `values.plugins.entries` whose JSON differs from the managed entry.
For Codex, a differing
`values.plugins.entries.codex.config.codexPlugins` bridge selection conflicts
with Driver ownership. Identical managed entries are accepted. An enabled native
plugin entry also conflicts with `plugins.enabled:false`, a matching
`plugins.deny` entry, or a nonempty `plugins.allow` that excludes it. This includes
the Codex transport plugin required by selected Codex apps. Disabled OpenClaw
selections can remain denied. Gateway startup rejects these conflicts before
OpenClaw package installation or starting the Gateway. Policy capability checks
at save time do not inspect the raw native Configuration for these conflicts.
Native configuration outside managed
fields, including tool denies and profiles, is retained.

## Preparation and security

Revision plugin state carries only requested IDs/policies and selected Driver
identity. Compute resolves current native metadata and applies the resulting
nonsecret configuration inside the exact revision workload before readiness. Codex installation is verified through native API metadata and effective configuration. Codex owns its private cache layout and integrity; Enterprise does not parse its cache records or version directories.
Package files/configuration are revision-private. In Kubernetes, the native
installation registry remains in the persistent Agent-owned OpenClaw state
database. Existing embedded-gateway preparation leaves a different active
revision running; activation replaces it with a `Recreate` Deployment. The new
process installs only after the old gateway stops. This uses the existing
serialized lifecycle, with no database copy or plugin-specific coordinator.
Docker keeps native state in the replacement container's private temporary home.

OpenClaw preparation installs the supported exact npm version with
`plugins install --no-enable`, preserving plugin allow/deny lists and entry
settings. It refreshes the native registry, reapplies the requested policy to its
private writable configuration, and checks plugin ID, package name,
runtime/install version, recorded integrity, and that the runtime source resolves
within the resolved install path. This requires an OpenClaw runtime that supports
`--no-enable`; the currently pinned `2026.9.1` image must be updated before this
preparation path can ship. There is no fallback to installation that changes policy.
Identity, integrity, or effective-policy verification failure prevents the
replacement gateway from starting. A confirmed installation rejection can instead
disable that optional selection and produce a warning. The previous revision
record remains stored, but the worker does not restore the old active pointer:
it retains the candidate pointer and retries. This does not promise uninterrupted
availability or automatic rollback during replacement. Retries reuse the
requested IDs/policies and may resolve the current curated release at that
later startup.
Codex preparation writes native Codex configuration and, for supported curated
Codex apps, applies the separate OpenClaw Codex bridge configuration with
`allow_all_plugins:false` and one entry per selected plugin. Compute owns the native
installation and readiness path; the PluginDriver only translates requested state
after native discovery.

During native installation, the runtime preserves the admitted plugin map key
for each selected operation. Only two typed native observations become
attributed plugin warnings: a matching selected install failure, or a
successful Codex install response with nonempty apps that still need
authentication. The startup result includes only `{pluginId, code}` with
`PLUGIN_INSTALL_FAILED` or `PLUGIN_AUTH_REQUIRED`; it does not emit native text,
command output, credentials, or deployment IDs. Errors from discovery,
configuration, policy translation, transport, signals, cancellation, malformed
responses, or unknown exceptions remain ordinary startup failures.

Credentials use the existing Harness/ServiceAccount path at runtime. A direct
MCP call, package listing, or rendered bridge configuration cannot prove native
Agent behavior; contributor fixture setup and proof notes live in
[Agent plugin testing](../../testing/plugins.md).

Agent plugin approval is separate from platform IAM and workload containment.
The runtime overlay grants read-only access to packaged Codex binaries even with
no selected plugins; selected plugins also receive their skill-directory reads.
Existing workload and managed policies remain mandatory. Package preparation preserves other Agents' state and does
not write the shared native registry while the prior gateway is running.

## Source and verification

- [Bundled implementations](../../../apps/controller/src/drivers/plugin/index.ts).
- [Trusted selection](../../../apps/controller/src/composition/installation-config.ts).
- [Agent plugin runtime flow](../../flows/agent-plugins.md).
- [Deployment guide](../../guides/deploy.md), [testing guide](../../testing/plugins.md), and [implementation proof requirements](../../../specs/16-plugin-driver.md#verification).

Source and contract tests do not establish compatibility with every runtime
image. Native proof requires the testing guide's opt-in real-runtime lane.

Disabling a selection does not uninstall it or guarantee its skills are unloaded.
Native remote installation can enable a plugin on the credential's account;
Agent-local app configuration and the OpenClaw bridge block its hosted app tools.
Agent enablement does not manage account-wide installation state.
