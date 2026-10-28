# Gateway managed mode

With managed mode on, an administrator changes Gateway configuration in OpenClaw
Enterprise (OCE) and deploys the Agent to apply it. The running Gateway refuses
native config writes, Gateway-local terminals, and jobs that execute commands on
the Gateway host. OCE groups these OpenClaw controls under the Agent deployment
setting `gatewayManagedMode`. [OCE #2982](https://github.com/openclaw/openclaw-enterprise/pull/2982)

## Set the mode for a deployment

New Agents default to managed mode on when their Compute Driver supports it and
off otherwise. In the Console, open the version draft’s **Configuration** tab.
Creating an Agent with `gatewayManagedMode=false` or changing the saved setting
in either direction requires Installation `administer` alongside the usual
permissions for the operation. Saving changes only the draft. Anyone authorized
to deploy the Agent can apply it. Deployment replaces the running Gateway and can
interrupt service. Check that the replacement started successfully, since OCE can
select a revision before its workload starts. [OCE #3810](https://github.com/openclaw/openclaw-enterprise/pull/3810) · [OCE #3807](https://github.com/openclaw/openclaw-enterprise/pull/3807)

An Installation administrator can turn managed mode off and redeploy so a Gateway
admin can try native edits. Those edits stay local. Redeploying in **either mode**
starts the Gateway from the configuration saved in OCE. On Kubernetes, replacing
the Pod also restores that configuration. Persistent Agent data, including
conversations and workspace files, has a separate lifecycle.
[Kubernetes configuration copy](../drivers/kubernetes-compute/managed-native-configuration.md)

## What OpenClaw enforces

OCE sets these variables on the Gateway after preparing the configuration. A
local shell or a host command could otherwise edit a writable file directly,
bypassing the config writer. [Pinned OpenClaw source](../../../deploy/runtime/openclaw-source.json)

| Gateway control                              | Effect on native administrators                                                                                                                                                                          | OpenClaw change                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `OPENCLAW_CONFIG_READONLY=1`                 | The config writer refuses edits, including `config.set`, `config.patch`, and `config.apply`. Reads and trusted configuration reloads continue.                                                           | [#140719](https://github.com/openclaw/openclaw/pull/140719) |
| `OPENCLAW_DISABLE_GATEWAY_LOCAL_TERMINALS=1` | The Gateway refuses local terminals. An authorized user can still open a terminal on a connected node.                                                                                                   | [#177855](https://github.com/openclaw/openclaw/pull/177855) |
| `OPENCLAW_DISABLE_CRON_HOST_EXECUTION=1`     | The Gateway blocks host commands in job payloads, on-exit watchers, and host-backed stream sources, even for existing jobs. Admins can disable or remove them. Ordinary scheduled Agent turns still run. | [#177855](https://github.com/openclaw/openclaw/pull/177855) |

The stock editor and CLI config writes routed through a running Gateway use this
guard. On a refused config write, the RPC returns `OPENCLAW_CONFIG_READONLY` in
`error.details.code`. If `OPENCLAW_NIX_MODE=1`
is also set, OpenClaw returns its Nix guidance instead. [OpenClaw #185299](https://github.com/openclaw/openclaw/pull/185299)

## Limits

- **Model tools.** In both modes, OCE installs the saved [Gateway tool policy](../configuration.md#gateway-tool-policy) on dedicated Gateways. An embedded Gateway applies a tool policy only when the Configuration sets one. With managed mode off, a Gateway admin can edit the local allowlist and restart the Gateway. Later turns can use newly allowed tools within their remaining permissions. Redeploying restores the saved policy. [OpenClaw tool and action filtering](https://github.com/openclaw/openclaw/pull/174547) · [OpenClaw model automation restrictions](https://github.com/openclaw/openclaw/pull/174580) · [OCE integration](https://github.com/openclaw/openclaw-enterprise/pull/2633)
- **Files and reloads.** A process with filesystem write access can bypass the config writer. The Gateway watches its effective config and included files. Depending on the key, a valid edit can take effect live or require a restart. Protecting against direct writes requires filesystem permissions or a separate trusted writer. Standing execution approvals, pairing records, sessions, and workspace files have their own access controls. [RFC 21 administration inventory](../../../specs/rfcs/0021-managed-runtime-mode/gateway-administration.md#configuration-changes-and-protection)
- **Compute support.** Kubernetes requires a configured Gateway runtime. SSH does not support managed mode. OCE refuses a request to enable managed mode, or to deploy an Agent that already enables it, on an unsupported Compute Driver. See the [Docker deployment limits](../drivers/docker-compute.md). After a hard crash in either mode, an embedded Gateway can require [operator recovery](../../guides/topics/agent-troubleshoot.md#an-embedded-gateway-reports-an-unverifiable-state-owner).
