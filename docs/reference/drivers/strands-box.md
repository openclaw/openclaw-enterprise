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

With the `standard-codex` preset, enter the model ID without the `codex/` prefix. For a custom Configuration, use the full model reference.

- With `codex/<model>`, set the model’s `agentRuntime.id` to `codex`. You can omit the Codex plugin block.
- With `openai/<model>`, selecting the Codex runtime also requires you to set `plugins.entries.codex.enabled` to `true` and `plugins.entries.codex.config.appServer.transport` to `websocket`. OCE checks this prerequisite before calling Strands.

Strands sets `appServer.transport`, `url`, `authToken` and `tlsPeerCertificate` on the revision to connect the Gateway to its own listener, even if you supply different values. You can omit the URL, token reference and peer certificate in both cases. Strands also omits `appServer.headers` from this connection so custom headers cannot change the listener hostname or authorization token. The saved Configuration keeps your original settings. Deployment still requires separate Harness authentication for model access. The Gateway transport bearer does not authenticate the model.

If you omit `appServer.mode`, new Strands revisions use the preset’s `guardian` mode. This also applies if your Configuration already specifies all connection fields. With full execution and no explicit approval policy, the default changes from `never` to `on-request`. Strands copies any explicit mode and approval policy into the revision. The runtime applies its own policy checks.

A replacement Pod or restarted supervisor cannot reuse the recorded execution identity. Admit a new revision to resume after execution loss. Use API key authentication for the model and workspace workflow.

Managed Codex plugins require a ChatGPT workspace credential. The contained
launcher can install a selected plugin on first boot. A model turn also requires
the workspace to permit the Harness permission profile, `:danger-full-access`.
End-to-end qualification with managed plugins is pending.
Box records denied destinations in its network policy audit.
