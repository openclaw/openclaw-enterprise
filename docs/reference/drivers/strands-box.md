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

Managed Codex plugins require a ChatGPT workspace credential. The contained
launcher can install a selected plugin on first boot. A model turn also requires
the workspace to permit the Harness permission profile, `:danger-full-access`.
End-to-end qualification with managed plugins is pending.
Box records denied destinations in its network policy audit.

## Experimental OpenAI API key isolation

By default, Codex receives the model API key. To keep that key in the trusted
supervisor container, build the controller and [companion image](../../flows/strands-box-companion.md)
from the same revision. Set the following fields in the Sandbox Driver configuration.

```yaml
policy:
  network:
    experimentalOpenAiModelCredential: true
    endpoints:
      - host: api.openai.com
        ports: [443]
```

Use a dedicated Codex Harness with a workspace node, ordinary API-key authentication
and a saved `modelProvider.baseUrl` of `https://api.openai.com/v1`. Disable managed
plugins and standalone web search. Other endpoints, authentication modes and
custom launch inputs are unsupported.

**Every process in the Sandbox can spend the model quota.** Box checks a temporary
bearer and injects the key only for HTTPS POST to the canonical path
`/v1/responses`. The rule does not inspect query parameters, request bodies
or executable identity. Callers can set other request headers. Trust the model
provider and its responses.

Stop the execution and deploy a new Agent revision to rotate the key.
The preview provides no live withdrawal, protected Credential Source grants or
GitHub access. Installed qualification is pending.
