# Agent Gateway channel proxy

An Agent can select one upstream HTTP or HTTPS proxy for its permitted Gateway
channel connections. The Gateway still uses its assigned managed Envoy listener.
The selection does not change OCC, Harness, model, tool, or OpenShell routes.

## Agent operations

Agent create, guided provisioning, update, read, and revision reads use
`networkProxy: { url, credentialSourceId? }`. Omit the field on update to keep
the draft selection. Set it to `null` to clear the selection for a future
deployment. A revision retains the selection admitted for that deployment;
editing or clearing the draft does not change a serving revision.

The URL must identify an Installation-configured HTTP or HTTPS endpoint. Do not
include URL user information, a path other than `/`, a query, or a fragment.
For Basic authentication, select a ready static Credential Source in the
Agent's Namespace. Its value is the complete
`Basic <base64(username:password)>` authorization header. The API returns the
endpoint and Source ID. OCC TokenService owns the supported Source.

The caller needs the exact Agent operation and `credential_source:operate` on
the selected Source. Deployment also requires the Agent service principal's
exact Source grant. Worker checks both grants before staging or reusing the
credential. Compute rejects a malformed Basic header before writing the slot.
Deploy a new revision after rotating it. Withdrawal blocks delivery for the
affected revisions and stays pending until Stop or retirement clears the Envoy
copy. Remove the Source from the draft before deploying without it.

An unsupported endpoint or topology is an invalid request. Select an endpoint
installed for the current Compute topology. If enforcement is unavailable, retry.
If the failure continues, ask an Installation administrator to check the Envoy
fleet, trust bundle, and DNS. Error responses do not include the submitted URL
or credential value.

## Compute and trust boundary

The route requires single-cluster Kubernetes Compute with managed channel
egress and an Installation-configured endpoint. Unsupported Compute or topology
selections fail admission. An Agent without enabled channels receives no
listener binding or additional proxy egress grant.

Compute stages the header in the assigned Envoy credential slot in the OCC
release namespace. Workload managers in that namespace can mount the Secret.
Gateway receives the managed listener URL. The upstream header stays in Envoy.

Envoy authorizes the final CONNECT host and port before connecting to the
selected proxy. The proxy owns final destination resolution and address
enforcement; Envoy cannot prove the proxy chose a public last-hop address.
Provider TLS remains end-to-end. Proxy failure or authentication refusal has no
direct fallback.

See [Kubernetes channel egress](../drivers/kubernetes-compute/channel-egress.md)
for enforcement and Installation inputs, and [configure channel egress](../../guides/deploy/channel-egress.md)
for the operator and Console procedure.
