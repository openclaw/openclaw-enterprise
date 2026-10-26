# Gateway managed mode

OCE enables managed mode by default for each Agent. It applies to Gateway
administration through native clients, including the Console’s native admin UI.
An Installation administrator can turn it off to try local configuration changes.
Harness Gateway policies apply in both modes.

In the Console, open the version draft’s **Configuration** tab. Creating an Agent
with `gatewayManagedMode=false` or changing the saved setting requires Installation
`administer` alongside the usual permissions. Anyone authorized to deploy the Agent
can apply the saved setting. The revision records the requested mode. OCE can
select the revision before the replacement starts, so verify that deployment
succeeded on a supporting runtime before relying on the restrictions.

After configuration setup, OCE sets three variables on the managed Gateway.

| Setting                                      | Effect                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `OPENCLAW_CONFIG_READONLY=1`                 | The OpenClaw config writer refuses edits. The watcher still picks up trusted OCE updates.  |
| `OPENCLAW_DISABLE_GATEWAY_LOCAL_TERMINALS=1` | The Gateway refuses local terminals. Authorized node-relayed terminals remain available.   |
| `OPENCLAW_DISABLE_CRON_HOST_EXECUTION=1`     | The Gateway refuses Gateway-hosted command jobs. Ordinary scheduled Agent turns still run. |

The [pinned OpenClaw revision](../../../deploy/runtime/openclaw-source.json) includes all three controls.
The Compute Driver must declare support and launch a qualified runtime.
Kubernetes requires a configured Gateway runtime. SSH rejects managed revisions.
See the [Docker deployment limits](../drivers/docker-compute.md).
After a hard crash in either mode, an embedded Gateway can require
[operator recovery](../../guides/topics/agent-troubleshoot.md#an-embedded-gateway-reports-an-unverifiable-state-owner).

Deploying with managed mode back on restores OCE’s configuration and can discard
Gateway-local edits. Replacing the Gateway can interrupt service. If a deployment
must also prevent direct filesystem writes under the Gateway’s identity, it needs
filesystem protection or separation of write authority.
