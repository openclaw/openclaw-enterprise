# Gateway managed mode

OpenClaw Enterprise (OCE) deploys the Gateway from the Agent’s saved
configuration. If an admin edits the Gateway directly, the Agent’s draft still
contains the old settings. The next deployment overwrites the local edit. OCE
therefore enables managed mode by default for new Agents on supported Compute
Drivers. Admins make lasting changes in the OCE Console.
[Managed mode in OCE](https://github.com/openclaw/openclaw-enterprise/pull/2982)

## Change Gateway configuration in OCE

You can follow these steps with managed mode on.

1. In the OCE Console, open **Agents** in the Agent’s Namespace and select the Agent.
2. Select **Open draft**. On the **Configuration** tab, select **Edit Configuration**.
3. Edit the Gateway settings and select **Save Configuration**. This saves the draft.
4. Select **Deploy new version** to apply the saved settings. Deployment replaces
   the running Gateway and can interrupt service. Check that the new version starts
   successfully. OCE can select a revision before its Gateway starts.

Saving the Configuration requires Configuration `update`. Deploying it requires
Agent `deploy`. The read-only banner in the Gateway links here through the
`OPENCLAW_CONFIG_READONLY_NOTICE` that OCE sets on managed Gateways.
[Configuration tab](../../guides/console/configuration-plugins-and-files.md#configuration-tab)

## What OpenClaw enforces

A Gateway admin could use a local terminal or a command job to change writable
files without using the config editor. OCE therefore closes those two paths
alongside native config writes. [Pinned OpenClaw source](../../../deploy/runtime/openclaw-source.json)

| Blocked on a managed Gateway              | What the admin sees                                                                                                                                                                                                                         | OpenClaw control                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Native config writes**                  | The Gateway refuses saves from its editor and writes through `config.set`, `config.patch`, and `config.apply`. Config reads and trusted reloads still work.                                                                                 | [`OPENCLAW_CONFIG_READONLY=1`](https://github.com/openclaw/openclaw/pull/140719)                 |
| **Gateway-local admin terminals**         | The Gateway refuses to open a shell on its own host. An authorized admin can still open a terminal on a connected node.                                                                                                                     | [`OPENCLAW_DISABLE_GATEWAY_LOCAL_TERMINALS=1`](https://github.com/openclaw/openclaw/pull/177855) |
| **Jobs that run commands on the Gateway** | The Gateway refuses to create or run jobs that execute host commands, including existing jobs and commands triggered on exit or by a host-backed stream. Admins can disable or remove those jobs. Ordinary scheduled Agent turns still run. | [`OPENCLAW_DISABLE_CRON_HOST_EXECUTION=1`](https://github.com/openclaw/openclaw/pull/177855)     |

CLI writes routed through the running Gateway use the same config writer.
A refused write returns `OPENCLAW_CONFIG_READONLY` in `error.details.code`.
If `OPENCLAW_NIX_MODE=1` is also set, OpenClaw returns its Nix guidance instead.
[OpenClaw config write errors](https://github.com/openclaw/openclaw/pull/185299)

## Set the mode for a deployment

To try a temporary edit in the Gateway, open the draft’s **Configuration** tab
and select **Turn off managed mode for next deployment**. The button saves the
setting. Deploy a new version to apply it. Creating an Agent with `gatewayManagedMode=false`
or changing the saved mode in either direction requires Installation `administer`
alongside the usual permissions for the operation. Anyone authorized to deploy
the Agent can apply the saved mode.
[Mode support](https://github.com/openclaw/openclaw-enterprise/pull/3810) · [Mode permissions](https://github.com/openclaw/openclaw-enterprise/pull/3807)

Redeploying in **either mode** starts the Gateway from the configuration saved
in OCE. On Kubernetes, replacing the Pod also restores that configuration.
Conversations and workspace files have a separate lifecycle.
[Kubernetes configuration copy](../drivers/kubernetes-compute/managed-native-configuration.md)

## Limits

- **Model tools.** In both modes, OCE installs the saved [Gateway tool policy](../configuration.md#gateway-tool-policy) on dedicated Gateways. An embedded Gateway applies a tool policy only when the Configuration sets one. With managed mode off, a Gateway admin can edit the local allowlist and restart the Gateway. Later turns can use newly allowed tools within their remaining permissions. Redeploying restores the saved policy. [OpenClaw tool and action filtering](https://github.com/openclaw/openclaw/pull/174547) · [OpenClaw model automation restrictions](https://github.com/openclaw/openclaw/pull/174580) · [OCE integration](https://github.com/openclaw/openclaw-enterprise/pull/2633)
- **Files and reloads.** A process with filesystem write access can bypass the config writer. The Gateway watches its effective config and included files. Depending on the key, a valid edit can take effect live or require a restart. Protecting against direct writes requires filesystem permissions or a separate trusted writer. Standing execution approvals, pairing records, sessions, and workspace files have their own access controls. [RFC 21 administration inventory](../../../specs/rfcs/0021-managed-runtime-mode/gateway-administration.md#configuration-changes-and-protection)
- **Compute support.** New Agents default to managed mode off on Compute Drivers that do not support it. Kubernetes requires a configured Gateway runtime. SSH does not support managed mode. OCE refuses a request to enable managed mode, or to deploy an Agent that already enables it, on an unsupported Compute Driver. See the [Docker deployment limits](../drivers/docker-compute.md). After a hard crash in either mode, an embedded Gateway can require [operator recovery](../../guides/topics/agent-troubleshoot.md#an-embedded-gateway-reports-an-unverifiable-state-owner).
