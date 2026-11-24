# In-Pod Strands Box

Select single-cluster Kubernetes Compute with Gateway routing. Enable
`strandsBox.workerReadiness` in the installation Helm values and configure the
Strands control-plane peer to select that release's worker Pods. The chart grants
the worker TCP 18791 to Strands Agent Pods in its routed namespaces and read access to individual ReplicaSets for Pod ownership checks. The provider
creates tenant resources and uses the installation's DNS peer and Gateway route.

For a dedicated Codex Agent, add the supervisor route below to
`drivers.compute.configuration.network`. Without it, the worker refuses
to prepare the revision.

```yaml
providerHarness:
  mode: namespace
  port: 18790
```

Before deployment, check `/opt/oce/runtime/provenance.json` in the Gateway
image. Verify that `source` is `https://github.com/openclaw/openclaw` and
`commit` matches the controller checkout’s `deploy/runtime/openclaw-source.json`.
Check the image directly. Gateway readiness alone does not verify its provenance.
Pin the image by digest and use it as the base for the companion image.

The first Gateway issues workspace-node setup. The trusted file node reports
migration or baseline failures through a private socket. The supervisor exposes
that failure on the authenticated diagnostic Service and starts Box only after
workspace setup succeeds.

## Configure the sandbox without Credential Proxy

**Ordinary API-key authentication makes the model key readable by Codex and
its tools.** For an isolation test, use an invented key and a controlled
[Responses endpoint](kubernetes-compute/model-provider.md). Leave Credential
Proxy and repository credentials unconfigured.

1. Build the [companion image](../../flows/strands-box-companion.md) with a
   matched set of Box binaries. Released Box 0.3.0 lacks the
   `--receive-container` launcher that this Pod uses to preserve Kubernetes’
   masked `/proc`. [Box #482](https://github.com/strands-agents/box/pull/482)
   supplies the experimental launcher. Set `drivers.compute.configuration.images.agent`
   to the companion image digest.
2. Select Linux ARM64 nodes that support Pod user namespaces. Install the
   [Strands seccomp profile](../../../scripts/generate-strands-box-seccomp.ts)
   generated from the node’s RuntimeDefault. Use a network plugin that enforces
   Kubernetes NetworkPolicy.
3. Add the following fields to the Installation. Keep the required Compute
   settings and supervisor route above. Replace the node label, profile path,
   Worker namespace, release name and both instances of the model hostname.
   This example disables projection of the Agent identity token.

```yaml
drivers:
  compute:
    configuration:
      servicePrincipalCredentials: { mode: disabled }
      runtime:
        modelProvider:
          protocol: openai-responses
          baseUrl: https://model.example.test/v1
  sandbox:
    id: strands-box-sandbox
    configuration:
      kubernetes:
        seccompProfile: profiles/strands-box.json
        nodeSelector:
          kubernetes.io/arch: arm64
          oce-role: agents
        controlPlanePeer:
          namespace: openclaw-system
          podLabels:
            app.kubernetes.io/name: openclaw-enterprise
            app.kubernetes.io/instance: oce
            app.kubernetes.io/component: worker
      policy:
        network:
          endpoints:
            - host: model.example.test
              ports: [443]
```

Deploy a dedicated Codex Agent and test a model turn and workspace read/write.
The endpoint list applies to every workload process and allows whole hosts and
ports. Try an allowed destination, a different host or port, and a direct
connection with the proxy disabled. Check the receiving servers to verify that
only the allowed request arrived.

## Gateway and transport

Use a Gateway runtime that supports the Codex plugin setting `appServer.tlsPeerCertificate`. The worker checks the Pod's Deployment and ReplicaSet ownership before recording its public certificate in an immutable revision ConfigMap. The Gateway and worker verify that certificate on each connection to the supervisor before sending the transport bearer. Port 18791 accepts only the revision readiness request. Port 18790 accepts the Gateway upgrade. Both reach the same supervisor TLS server. The file node and contained workload receive neither the listener key nor the revision bearer.

A replacement Pod or restarted supervisor cannot reuse the recorded execution identity. Admit a new revision to resume after execution loss. Use API key authentication for the model and workspace workflow.

Managed Codex plugins require a ChatGPT workspace credential. The contained
launcher can install a selected plugin on first boot. A model turn also requires
the workspace to permit the Harness permission profile, `:danger-full-access`.
End-to-end qualification with managed plugins is pending.
Box records denied destinations in its network policy audit.
