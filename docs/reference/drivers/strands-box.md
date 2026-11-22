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
image. Its `source` must be `https://github.com/openclaw/openclaw` and its
`commit` must match `commit` in the controller checkout's
`deploy/runtime/openclaw-source.json`. A mismatch leaves the Gateway unready.
Pin that image by digest and use it as the base for the companion image.

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

Use a dedicated Codex Harness with a workspace node and ordinary API-key
authentication. Set [`drivers.compute.configuration.runtime.modelProvider`](kubernetes-compute/model-provider.md)
to protocol `openai-responses` and base URL `https://api.openai.com/v1` before
deploying the revision. Disable managed plugins and standalone web search.
Other endpoints, authentication modes and custom launch inputs are unsupported.

**Every process in the Sandbox can use everything the key permits on the Responses
endpoint.** Box checks the temporary bearer and substitutes the key only on
HTTPS POST to the canonical path `/v1/responses`. The caller controls the
query, body and other headers, including applicable organization and project
headers. It can select models, spend quota and ask the provider to use tools
or send data to remote MCP servers. Trust the provider and its responses.

Use an application-specific key in a dedicated project. Verify the effective
project and organization, restrict endpoint, model and data access, and set
enforced limits where available. Configure alerts and name an operator who
can revoke the key. Alerts alone do not cap spending.

To rotate the key, stop the execution, verify it can no longer serve requests,
revoke and replace the key, then deploy a new Agent revision. The preview
provides no live withdrawal, protected Credential Source grants or GitHub
access. Installed qualification is pending.
