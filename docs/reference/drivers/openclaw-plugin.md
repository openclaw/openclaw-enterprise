---
kind: reference/driver/impl
---

# OpenClaw Plugin Driver

**Contents**

- [Overview](#overview)
- [Lifecycle](#lifecycle)
- [Configuration](#configuration)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)

## Overview

Select the OpenClaw Plugin Driver (`occ-plugin`, implementation
`occ/openclaw-plugin`) to offer plugins for an OpenClaw Harness. It follows the
[PluginDriver contract](plugin.md). OpenClaw Control Plane (OCC) saves Agent
selections and checks supported policy. Compute prepares the selected packages
and runtime configuration when an Agent revision starts.

| Agent                            | Catalog selection         | Runtime capability                                                 |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| Embedded OpenClaw                | `occ-plugin:diffs`        | Native `diffs` tool from `@openclaw/diffs@2026.8.2`.               |
| Dedicated OpenClaw on Kubernetes | `occ-plugin:google@1.0.0` | Google Workspace skill in the Gateway and `gog` CLI on the worker. |
| Dedicated OpenClaw on Kubernetes | `occ-plugin:slack@1.0.0`  | Hosted Slack MCP server at `https://mcp.slack.com/mcp`.            |

The dedicated catalog comes from the reviewed [managed package index](../../../apps/controller/plugins/marketplace.json). Google Workspace and Slack can be selected together. The complete Agent policy vocabulary belongs to the [Agent plugin reference](../agent-plugins.md).

## Lifecycle

Listing the bundled catalog does not install a plugin, grant access, or read a
credential. Loading Slack tool details uses the authorized account credential
to query the MCP server.
For a credentialed managed package, OCC lists compatible, ready Sources in the
Agent's Namespace that the caller can read. The Driver checks the release digest, credential
slot, Harness mode, Compute implementation, and requested policy before save
and again at deployment admission.

The next deployment saves the requested selections and Driver identity in an
Agent revision. Embedded OpenClaw installs the integrity-pinned Diffs package.
Compute uses `plugins install --no-enable`, refreshes the native registry, and
checks the plugin ID, package name, version, integrity, and resolved source path
before applying the selected policy. A runtime without `--no-enable` cannot
prepare the package. Identity or integrity failure prevents Gateway startup.
Dedicated OpenClaw uses managed package material shipped in the controller and
runtime images. Compute prepares the Google skill and worker CLI, or the Slack
worker MCP server and selected tool filter. CredentialService resolves each admitted
Source and the selected Proxy supplies its credential under the Sandbox policy.
Delivery through a running Plugin Agent still requires qualification. See
[Credential Sources](../credential-sources.md).

Kubernetes stores the native OpenClaw installation registry in the Agent-owned
state database and serializes Gateway replacement. A confirmed embedded native
install rejection can disable that selection and report `PLUGIN_INSTALL_FAILED`;
other preparation failures can keep the candidate unready. Check deployment
warnings and execute a real tool call before treating installation as verified.
A saved `activeRevisionId` is not readiness evidence.

Disabling or removing a selection affects the next successful deployment. It
does not interrupt a running turn, immediately revoke a running revision, remove
an attached credential source, or uninstall account-wide state. Ordinary
retirement removes old workload state but retains the Agent-owned database. For
immediate credential withdrawal, use the [source withdrawal procedure](../credential-sources/withdrawal.md).

## Configuration

Declare the Driver in trusted Installation YAML. No Plugin Driver is selected by
default. Restart the controller with the updated Installation configuration.

| Setting                          | Type   | Requirement | Value, default, and constraints                       |
| -------------------------------- | ------ | ----------- | ----------------------------------------------------- |
| `drivers.plugin[].id`            | string | Required    | `occ-plugin`.                                         |
| `drivers.plugin[].configuration` | object | Required    | `{}`; the Driver accepts no configuration properties. |

```yaml
drivers:
  plugin:
    - id: occ-plugin
      configuration: {}
```

Save selections on the Agent draft, then deploy a new revision. The minimum
embedded selection is:

```json
{
  "plugins": {
    "occ-plugin:diffs": { "enabled": true }
  }
}
```

An Agent update also requires its current `configurationId` and replaces the
supplied plugin map. Preserve other selections. See [HTTP operations](../agent-plugins.md#http-operations).

Managed package settings use a separate scope:

| Setting                               | Type         | Requirement | Value, default, and constraints                                                                                                                          |
| ------------------------------------- | ------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins.<id>.enabled`                | boolean      | Required    | Enables or disables the selected package.                                                                                                                |
| `plugins.<id>.driverPolicy`           | object       | Optional    | Omit to install without an account. A connected package requires the current `releaseSha256` and `credentials.account`, the selected `cs_...` Source ID. |
| `plugins.<id>.driverPolicy.toolNames` | string array | Optional    | Slack only. Exact upstream tool names; omission selects none. Globs are rejected.                                                                        |
| `plugins.<id>.tools.<name>.approval`  | string       | Optional    | Slack only, for a selected tool: `all_actions` requests human approval for each native call; `none` adds no approval. Omission adds none.                |
| `pluginApprovers`                     | array        | Optional    | Agent-wide Slack reviewers for plugin approval prompts; see [Slack approver users](../agent-plugins.md#slack-approver-users).                            |

Select the release digest and eligible Source from Agent plugin capabilities.
Google Workspace uses an OAuth Source with a matching Google Template. Slack
accepts a static bearer or OAuth Source whose Template permits the MCP request
to `https://mcp.slack.com/mcp`. Loading tools requires Source authorization
and API connectivity to the MCP server. See [Connection Templates](../connection-templates.md)
and [Agent Source grants](../credential-sources.md#bind-a-source-to-an-agent).

## Limits

- Managed packages require dedicated OpenClaw and Kubernetes Compute. Diffs
  requires embedded OpenClaw; it cannot be combined with managed packages.
- Agent plugin selections cannot add arbitrary MCP URLs, package versions,
  external catalogs, or external Plugin Driver packages. Adding a managed entry
  requires reviewed package material and updated images.
- Diffs supports enablement and `provider_default` or `none` approval; neither
  adds a review step. It rejects `all_actions`, `write_actions`, and explicit
  reviewers. Native deny rules remain effective.
- A selected native plugin cannot conflict with `plugins.enabled`,
  `plugins.allow`, `plugins.deny`, or its managed `plugins.entries` value in the
  Agent Configuration. Omit `plugins.entries.diffs` when possible. An exact
  `{"enabled":true}` or `{"enabled":false}` copy is accepted unless an enabled
  Diffs selection uses an HTTPS `gateway.publicOrigin` listed in
  `gateway.controlUi.allowedOrigins`; then the entry must be absent. See the
  [configuration checks](../../guides/topics/plugins-configure.md#before-you-start).
- Google Workspace uses a CLI, not MCP, and supports package enablement and an
  optional credential slot. It has no per-operation approval policy.
- Slack advertises only selected tools; the worker limit is 128 MCP tools. A
  generated alias must fit within 64 characters. An approval prompt identifies
  the server and tool but omits arguments. A script with the credential can
  directly call an enabled tool without Gateway approval; the Sandbox separately
  denies unselected tool names.
- Managed MCP supports Agent-wide `pluginApprovers`, not plugin or tool reviewer
  overrides. With the Slack channel enabled, native
  `approvals.plugin.slack.plugins` overrides conflict with managed MCP approval
  and prevent startup. Plugin-wide approval defaults, write-only review, and
  explicit reviewer selection are unsupported.
- Gateway readiness does not attest that mandatory managed MCP policy
  registration succeeded. The [current proof notes](../../testing/plugins.md#current-proof-notes)
  describe the remaining real Agent acceptance requirements.

## Troubleshooting

| Symptom                                          | First check                                                                                             | Corrective action and expected result                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Package is missing from the catalog              | Check the selected Harness mode and Driver registration.                                                | Use embedded OpenClaw for Diffs or dedicated OpenClaw on Kubernetes for Google Workspace and Slack; the compatible entry appears. |
| Account slot is empty or save rejects the source | Check Source grants, release digest, and slot compatibility.                                            | Grant access to an eligible Source and select the account again; save accepts the current release.                                |
| Slack **Load tools** fails                       | Check API egress, source authorization, token validity, and Slack scopes.                               | Repair the failing prerequisite and reload; the server's tool list appears.                                                       |
| Slack tool is absent                             | Check `driverPolicy.toolNames` and the deployed revision.                                               | Select the exact upstream name and deploy; the worker advertises it.                                                              |
| An approval-required deployment fails            | Check native Slack plugin overrides and the packaged managed MCP policy.                                | Remove conflicting overrides or use a matching runtime image; startup can prepare the policy.                                     |
| Diffs save or startup fails                      | Check `plugins.enabled`, `plugins.allow`, `plugins.deny`, `plugins.entries.diffs`, and tool deny rules. | Remove the conflicting setting or deselect Diffs; admission and startup accept the configuration.                                 |

For longer recovery procedures, see [Configure Agent plugins](../../guides/topics/plugins-configure.md) and [deployment status](../agents.md#deployment-status).
