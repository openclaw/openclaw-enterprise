# PluginDriver

The optional PluginDriver supports native curated catalog discovery, validates one
Agent's desired selections at startup, and renders native configuration. OCC
owns Agent metadata, exact-resource authorization, transactions, and immutable
revision admission. Compute owns installation, runtime connections, readiness,
activation, and retirement. The Driver never installs Agent packages in OCC.

The [Agent plugin reference](../agent-plugins.md) owns the API and policy meaning.
This page owns Installation selection and native compatibility.
Compare implementations in the [PluginDriver feature matrix](plugin-matrix.md),
with searchable support statuses and commit-pinned evidence.

## Selection and catalogs

Select at most one bundled implementation in trusted Installation YAML:

```yaml
drivers:
  plugin:
    id: occ-plugin
    configuration: {}
```

Dedicated Codex Agents can use `configuration: {}`: startup resolves selections
with the Agent's projected credentials. An optional catalog reader supports the
Driver's internal `listCatalog` interface:

```yaml
drivers:
  plugin:
    id: codex-plugin
    configuration:
      codexExecutable: /opt/codex/bin/codex
      codexHome: /var/lib/occ/codex-catalog
      requestTimeoutMs: 10000
```

`codexExecutable` and `codexHome` must be supplied together. The home must be a
dedicated, operator-provisioned native Codex profile with existing Codex backend
authentication. The optional timeout defaults to 10,000 milliseconds and accepts
1–60,000. Catalog reads start native app-server and use `plugin/list`; native
startup may update that profile's own cache. Use a separate profile from the
operator's ordinary Codex workspace.

An empty Codex Driver configuration permits Agent writes and deployment without
controller-side catalog discovery. No HTTP plugin inventory endpoint is exposed. Agent startup uses
its own projected credentials to resolve its selections independently of this
reader. Unknown options, arbitrary package selectors, and external PluginDriver
packages are rejected. Existing required Driver selections remain necessary.

| Driver ID      | Implementation        | Agent Harness     | Catalog source                                                                                                   |
| -------------- | --------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `occ-plugin`   | `occ/openclaw-plugin` | Embedded OpenClaw | Bundled OpenClaw catalog, including `occ-plugin:diffs` (`@openclaw/diffs`).                                      |
| `codex-plugin` | `occ/codex-plugin`    | Dedicated Codex   | Existing native Codex `openai-curated-remote` catalog, exposed as `codex-plugin:<plugin>@openai-curated-remote`. |

The OpenClaw catalog is bounded and pins Diffs `2026.8.2` plus npm integrity.
The Codex catalog is discovered from the existing native curated marketplace at
list/read time; Linear and Google Calendar are test fixtures, not production
allowlist entries. API callers cannot choose arbitrary sources or versions.
Startup resolves the current native identity, app mapping, and release metadata
for each requested catalog ID.

No PluginDriver selection is the default. Existing plugin-free deployments
remain permitted. Saving Agent plugin selections does not require catalog
membership validation. Nonempty selections cannot start with a missing,
changed, or Harness-incompatible Driver. Saved entries remain listable without
their original Driver.

SSH Compute currently rejects every nonempty requested plugin map before host
effects. It can run embedded OpenClaw revisions only when their requested plugin
set is empty.

## Native mappings and limits

Native policy takes effect only when the complete requested behavior can be
represented during Agent startup. Unsupported combinations fail or leave the
candidate unready with startup diagnostics; they are not authentication or
installation errors. Runtime versions and the OpenClaw-to-Codex projection also
constrain support: a native Codex setting alone does not prove the effective
Agent thread retains it.

| Surface                                       | Current behavior                                                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw `always` and enable/disable          | Set `plugins.entries.<id>.enabled`; enabled selections receive existing `tools.alsoAllow` plugin grants without removing operator restrictions.                         |
| OpenClaw `never`                              | Disable the selected plugin, blocking its owned execution surfaces.                                                                                                     |
| OpenClaw `prompt`, `auto`, reviewer           | Startup failure; no equivalent generic native plugin approval control is implemented.                                                                                   |
| Tool/category policy on catalog entries       | Startup failure when current curated entries do not expose reliable per-tool metadata to Enterprise.                                                                    |
| Codex internal `listCatalog`                  | Reads native `openai-curated-remote` entries when the optional catalog reader is configured; saved selections remain on Agent reads. No HTTP inventory endpoint exists. |
| Codex selected-app `auto`                     | Render native Codex apps/plugins enablement with the selected app `enabled:true`, plus a selected-only OpenClaw Codex bridge entry.                                     |
| Codex selected-app `never` or `enabled:false` | Render the resolved install identity while omitting the native app entry and disabling the selected bridge entry so execution remains blocked.                          |
| Codex selected-app `approvalsReviewer`        | Render native app reviewer configuration for the selected app ID with `user` or `auto_review`.                                                                          |
| Codex `always`                                | Set per-plugin `allow_destructive_actions:true`; the bridge accepts supported approvals without prompting. Explicit `auto_review` is unsupported for this mode.         |
| Codex `prompt`, category/tool modes           | Startup failure when every-call prompting or reliable tool metadata is unavailable.                                                                                     |
| Codex empty desired set                       | Apply a plugin-free native configuration; no remote install RPC runs.                                                                                                   |

The Codex boundary is separate from approval-mode translation. Marketplace
visibility does not prove Agent support. The inspected `rust-v0.149.0` native
runtime does not provide a general selected-only gate for all remote plugin
skills and MCP surfaces, so this release does not enable arbitrary account
plugins or unsupported policy modes. Supported curated Codex apps are handled
through the existing OpenClaw Codex bridge: the bridge keeps
`allow_all_plugins:false`, sets `codexPlugins.enabled:true`, and writes one entry per selected plugin. The Codex `app_mcp_routing` path strips raw app
MCP tools from ChatGPT auth; Enterprise applies the selected bridge configuration
before readiness. Configuration and fixture checks do not establish effective
native Agent execution; see the [runtime proof notes](../../testing/plugins.md#current-proof-notes).

The [API policy vocabulary](../agent-plugins.md#approval-policy) retains independent
trigger and reviewer semantics for representable implementations. Native Codex
`auto` and app reviewer settings are used for supported curated Codex apps.
`always` uses the bridge's existing automatic acceptance with the default or
`user` reviewer. Explicit `auto_review` with `always`, `prompt`, category
overrides, and tool overrides remain unsupported at startup. Unsafe approval
schemas and ambiguous ownership continue to be declined.

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
with Driver ownership. Identical managed entries are accepted. Native
configuration outside managed fields is retained.

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

OpenClaw preparation installs the supported exact npm version, refreshes the native
registry, reapplies the requested policy to its private writable configuration,
and checks plugin ID, package name, runtime/install version, recorded integrity,
and that the runtime source resolves within the resolved install path.
Failure prevents the replacement gateway from starting. The previous revision
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

Credentials use the existing Harness/ServiceAccount path at runtime. A direct
MCP call, package listing, or rendered bridge configuration cannot prove native
Agent behavior; contributor fixture setup and proof notes live in
[Agent plugin testing](../../testing/plugins.md).

Agent plugin approval is separate from platform IAM and workload containment.
This Driver adds no sandbox, egress grant, filesystem grant, approval service,
OAuth interface, or permission hook. Existing workload and managed policies
remain mandatory. Package preparation preserves other Agents' state and does
not write the shared native registry while the prior gateway is running.

## Source and verification

- [Bundled implementations](../../../apps/controller/src/drivers/plugin/index.ts).
- [Trusted selection](../../../apps/controller/src/composition/installation-config.ts).
- [Agent plugin runtime flow](../../flows/agent-plugins.md).
- [Deployment guide](../../guides/deploy.md), [testing guide](../../testing/plugins.md), and [implementation proof requirements](../../../specs/16-plugin-driver.md#verification).

Source and contract tests do not establish compatibility with every runtime
image. Native proof requires the testing guide's opt-in real-runtime lane.

Disabled and `never` selections remain installed. Native remote installation can enable a plugin on the credential’s account; Agent-local app configuration and the OpenClaw bridge still block its execution. Agent enablement does not manage account-wide installation state.
