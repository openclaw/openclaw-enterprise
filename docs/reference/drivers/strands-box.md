# In-Pod Strands Box

Select single-cluster Kubernetes Compute with Gateway routing. Enable
`strandsBox.workerReadiness` in the installation Helm values and configure the
Strands control-plane peer to select that release's worker Pods. The chart grants
the worker TCP 18791 to Strands Agent Pods in its routed namespaces and read access to individual ReplicaSets for Pod ownership checks. The provider
creates tenant resources and uses the installation's DNS peer and Gateway route.

The first Gateway issues workspace-node setup. The trusted file node reports
migration or baseline failures through a private socket. The supervisor exposes
that failure on the authenticated diagnostic Service and starts Box only after
workspace setup succeeds.

Use a Gateway runtime that supports the Codex plugin setting `appServer.tlsPeerCertificate`. The worker checks the Pod's Deployment and ReplicaSet ownership before recording its public certificate in an immutable revision ConfigMap. The Gateway and worker verify that certificate on each connection to the supervisor before sending the transport bearer. Port 18791 accepts only the revision readiness request. Port 18790 accepts the Gateway upgrade. Both reach the same supervisor TLS server. The file node and contained workload receive neither the listener key nor the revision bearer.

A replacement Pod or restarted supervisor cannot reuse the recorded execution identity. Admit a new revision to resume after execution loss. Use API key authentication for the model and workspace workflow.

## Default container receiver

The receiver requires a Box build with the container-agent feature. The
contained Agent can read its model credential. Managed Codex plugins require a
ChatGPT workspace credential. The contained
launcher can install a selected plugin on first boot. A model turn also requires
the workspace to permit the Harness permission profile, `:danger-full-access`.
End-to-end qualification with managed plugins is pending.
Box records denied destinations in its network policy audit.

## Stock launcher preview

Use a separate, operator-controlled installation for this preview. In the
`strands-box-sandbox` Driver configuration, keep the node selector and
control-plane peer. Set these fields, replacing `team-test` with the exact
Kubernetes tenant name.

```yaml
kubernetes:
  stockLauncher:
    namespace: team-test
  seccompProfile: oce-strands-box-v0.3.1.json
policy:
  network:
    endpoints:
      - host: api.openai.com
        ports: [443]
```

This installation refuses other tenants. Select a dedicated Codex Agent using
an OpenAI API key and the Responses endpoint. Box 0.3.1 substitutes the key
for a placeholder on HTTPS `POST api.openai.com/v1/responses`. Every process
in the Agent may use this route. The caller controls the model, body and
hosted tools. Use a dedicated provider project with spending limits.

The dedicated-key revision uses a distinct Sandbox identity and ordinary
`unprotected` admission. Git, additional endpoints, standalone search and
managed plugins are unavailable in either stock mode. Stop the old Agent and confirm
retirement with the original Worker before switching launchers. Revoke a
previously exposed key. Rotation requires a fresh revision. For immediate
withdrawal, revoke at the provider.

Read the [deployment and isolation requirements](../../flows/strands-box-companion.md#stock-launcher)
before enabling the preview. Omit `stockLauncher` to keep the receiver.

### Use a managed OpenAI Source

Apply migration 0097 and upgrade the controllers and Workers before enabling
this mode. Select the `occ` TokenService, register a static OpenAI Source and
save the dedicated Codex Agent with that Source for model access. Keep it
stopped. The deployer and the Agent must each be authorized to use the Source.

Add one grant under `kubernetes.stockLauncher`, using the saved IDs.

```yaml
agentGrants:
  - agentId: <saved Agent ID>
    sourceId: <OpenAI Source ID>
    profile: openai-responses
```

Apply the same configuration to the API and Worker, then deploy the Agent.
This switches the installation to v8 `standalone` admission and staged
delivery. It accepts only the named
Agent and Source and still requires the exact endpoint above. Leave other
network and repository ceilings empty. Executable-specific rules cannot
authorize a whole Agent.

Stop the Agent and confirm retirement before changing the grant or key.
Withdrawing a required model Source blocks new OCE HTTP chats. A running
process can still use the installed key until an operator with Stop permission
retires the execution. Preserve the original API, Worker and grant until cleanup
finishes. Removing the pair disables its checks for retained copies.
To rotate the static key, update the Source after retirement,
then deploy a fresh revision.
