# Bundled Plugin Drivers

Select a Plugin Driver for each Agent Harness whose catalog the Installation
offers. Each implementation reference explains its lifecycle, configuration,
limits, and troubleshooting. The [PluginDriver contract](plugin.md) defines the
shared interface; the [Agent plugin reference](../agent-plugins.md) defines
selection and approval fields.

| Driver         | Implementation        | Supported Agents                                                                       | Reference                                    |
| -------------- | --------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| `occ-plugin`   | `occ/openclaw-plugin` | Embedded OpenClaw Diffs; dedicated OpenClaw managed CLI and MCP packages on Kubernetes | [OpenClaw Plugin Driver](openclaw-plugin.md) |
| `codex-plugin` | `occ/codex-plugin`    | Dedicated Codex apps and skills from `openai-curated-remote`                           | [Codex Plugin Driver](codex-plugin.md)       |

## Selection and catalogs

Register Drivers under `drivers.plugin` in trusted Installation YAML. No Plugin
Driver is selected by default. External Plugin Driver packages are not selectable.
See [OpenClaw configuration](openclaw-plugin.md#configuration) and
[Codex configuration](codex-plugin.md#configuration) for examples and catalog
settings.

## Native mappings and limits

See [OpenClaw limits](openclaw-plugin.md#limits) for Diffs and managed MCP policy,
and [Codex limits](codex-plugin.md#limits) for app and tool policy mappings,
reviewers, and native runtime restrictions.

## Preparation and security

Compute prepares and verifies the selected plugins before the replacement
workload can serve. See [OpenClaw lifecycle](openclaw-plugin.md#lifecycle),
[Codex lifecycle](codex-plugin.md#lifecycle), and the
[Agent plugin runtime flow](../../flows/agent-plugins.md).

## Source and verification

The [bundled implementations](../../../apps/controller/src/drivers/plugin/index.ts)
and [Installation loader](../../../apps/controller/src/composition/installation-config.ts)
own selection and policy. Use the [plugin testing guide](../../testing/plugins.md)
to distinguish source and fixture checks from real Agent execution.
