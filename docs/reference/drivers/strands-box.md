# In-Pod Strands Box

Select single-cluster Kubernetes Compute with Gateway routing. Enable
`strandsBox.workerReadiness` in the installation Helm values and configure the
Strands control-plane peer to select that release's worker Pods. The chart grants
the worker TCP 18791 to Strands Agent Pods in its routed namespaces. The provider
creates tenant resources and uses the installation's DNS peer and Gateway route.

The first Gateway issues workspace-node setup. The trusted file node reports
migration or baseline failures through a private socket. The supervisor exposes
that failure on the authenticated diagnostic Service and starts Box only after
workspace setup succeeds. Use API key authentication for the verified model and workspace workflow.

Managed Codex plugins require a ChatGPT workspace credential. The contained
launcher can install a selected plugin on first boot. A model turn also requires
the workspace to permit the Harness permission profile, `:danger-full-access`.
End-to-end qualification with managed plugins is pending.
Box records denied destinations in its network policy audit.
