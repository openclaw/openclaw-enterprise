# Gateway managed mode

OCE enables managed mode by default for each Agent. It applies to Gateway
administration through native clients, including the Console’s native admin UI.
An Installation administrator can turn it off to try local configuration changes.
Dedicated Gateways start with the model tool policy saved in OCE. With managed
mode off, an authorized Gateway admin can explicitly widen the local allowlist.
After a native Gateway restart, later Agent turns can use those tools if their
other permissions allow it.

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

Deploying with managed mode back on restores OCE’s saved configuration. Tools
excluded by that revision become unavailable again. Replacement can interrupt
service. Protecting files against direct writes under the Gateway’s identity
requires filesystem protection or separate write authority.
