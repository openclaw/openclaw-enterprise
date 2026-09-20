# PluginDriver contract

## Overview

`PluginDriver` supplies a curated catalog for an Agent Harness. OpenClaw Control
Plane (OCC) owns Agent selections, authorization, and immutable revisions.
Compute owns native installation, runtime connections, readiness, activation,
and retirement. Bundled startup code also translates selected policy into native
configuration; those helpers are not methods on the exported Driver interface.

An Installation can select at most one bundled Plugin Driver. The default is no
Driver, which permits plugin-free deployments. External Plugin Driver packages
are not selectable. See [Driver selection](selection.md) and the
[Agent plugin reference](../agent-plugins.md).

## Interface

### Selection and catalogs

The [shared interface](../../../packages/contracts/src/index.ts) requires only
`listCatalog(context)`. It receives the read-only Namespace, Agent, Harness
identity and mode, native Configuration, and an abort signal. It returns entries
with `id`, `name`, and `tools`; `tools` is either a list of tool metadata or
`null` when that metadata is unavailable. A tool entry has `id`, `name`,
`destructive`, and `writes`. Catalog entries do not grant access, select a plugin,
or prove the requested policy can run.

There is no exported install, enable, policy-translation, or preparation method.
The optional _backend reader_ in bundled Codex is different from the required
`listCatalog` method: without that reader, an explicit catalog call fails, but
saving Agent selections and deploying supported selections can still use the
Agent runtime's discovery path. There is no public HTTP plugin inventory endpoint.
See [bundled selection and catalog setup](plugin-bundled.md#selection-and-catalogs).

## IAM

OCC authorizes the exact Agent operation. Reading or changing Agent selections
does not grant provider access, plugin permissions, or approval to perform a
plugin action. Plugin approval settings are separate from platform IAM, workload
isolation, and the external provider's authentication. Runtime credentials use
the existing Harness and ServiceAccount path; never put credential values or
native command output in startup diagnostics. The Driver supplies no sandbox,
egress grant, filesystem grant, approval service, OAuth interface, or IAM hook.
See [Agent plugin permissions](../agent-plugins.md) and [authorization](../authorization.md).

## Lifecycle

### Preparation and security

Trusted startup creates the selected bundled Driver and validates its configuration.
The shared interface has no startup, shutdown, or uninstall operation. Saving an
Agent's requested plugin map does not validate catalog membership; saved entries
remain readable even if the original Driver is unavailable. A revision with
nonempty selections records the selected Driver's ID and implementation and the
requested IDs and policies, not credential values or native release metadata.

At runtime, Compute and the bundled preparation helpers resolve current native
metadata, translate supported policy, and apply it to the specific revision
before declaring readiness. Nonempty selections cannot start with a missing,
changed, or Harness-incompatible Driver. An unsupported policy or unsafe native
configuration prevents startup or leaves the revision unready. Retries reuse the
requested IDs and policy; they may resolve a newer curated release at that later
startup. Saving a selection is not evidence that it can start.

Only two recognized native outcomes can become optional plugin warnings:
`PLUGIN_INSTALL_FAILED` and `PLUGIN_AUTH_REQUIRED`, attributed to the requested
`pluginId`. They contain no native output or credentials. Other discovery,
configuration, policy, transport, cancellation, or malformed-response errors
remain startup failures. See [bundled preparation and security](plugin-bundled.md#preparation-and-security)
and [Compute startup warnings](compute.md#plugin-startup-warnings).

## Limits

### Native mappings and limits

- A catalog entry does not guarantee that its policy can be enforced by a given
  Harness. The current bundles reject policy they cannot represent; see the
  [native support table](plugin-bundled.md#native-mappings-and-limits).
- Callers cannot choose arbitrary sources or versions. SSH Compute rejects every
  nonempty plugin map; an empty selection remains supported for its embedded Harness.
- Agent enablement does not manage account-wide installation. A disabled or
  `never` selection can remain installed while its execution is blocked locally.
- A catalog response, rendered configuration, or direct MCP call does not prove
  native Agent execution. Compare current support in the [feature matrix](plugin-matrix.md).

## Troubleshooting

| Symptom                                                           | What to check                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A catalog call fails                                              | Check that the selected Driver matches the Harness. Bundled Codex also needs its optional controller catalog reader configured for this method.                     |
| A saved selection will not deploy                                 | Confirm the same Driver is still selected, the Harness is supported, and its native policy can represent the whole requested selection.                             |
| Startup reports `PLUGIN_AUTH_REQUIRED` or `PLUGIN_INSTALL_FAILED` | Check the selected plugin and its Harness/provider access. Other startup errors are not translated into these warnings; consult the selected backend's diagnostics. |
| A disabled plugin still appears installed                         | Installation and Agent-local execution are separate. Check effective Agent configuration and policy before treating the plugin as enabled.                          |

## Implementations

- [Bundled OpenClaw and Codex Drivers](plugin-bundled.md): `occ-plugin` serves
  embedded OpenClaw; `codex-plugin` serves dedicated Codex.
- [PluginDriver feature matrix](plugin-matrix.md): capability and verification
  differences between the two bundled implementations.

## Related

### Source and verification

- [Bundled Driver source](../../../apps/controller/src/drivers/plugin/index.ts), [runtime translator](../../../apps/controller/src/drivers/plugin/runtime-translator.ts), and [trusted selection](../../../apps/controller/src/composition/installation-config.ts)
- [Agent plugin runtime flow](../../flows/agent-plugins.md), [deployment](../../guides/deploy.md), and [verification guide](../../testing/plugins.md)
- [Implementation proof requirements](../../../specs/16-plugin-driver.md#verification)
