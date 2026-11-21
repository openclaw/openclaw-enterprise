# Agent Gateway channel proxy

An Agent can select one upstream HTTP or HTTPS proxy for its permitted Gateway
channel connections. The Gateway still uses its assigned managed Envoy listener.
The selection does not change OCC, Harness, model, tool, or OpenShell routes.

## Agent operations

Agent create, guided provisioning, update, read, and revision reads use
`networkProxy: { url, credentialSecretId? }`. Omit the field on update to keep
the draft selection. Set it to `null` to clear the selection for a future
deployment. A revision retains the selection admitted for that deployment;
editing or clearing the draft does not change a serving revision.

The URL must identify an Installation-configured HTTP or HTTPS endpoint. Do not
include URL user information, a path other than `/`, a query, or a fragment.
For Basic authentication, select an existing Secret in the Agent's Namespace.
Its value is the complete `Basic <base64(username:password)>` authorization
header. The API returns only the endpoint and Secret ID. Proxy credentials are
separate from channel credentials.

The caller needs the exact Agent operation and `operate` on the selected
Secret. Deployment uses the normal exact-source grant for the Agent principal;
admission and worker dispatch check authority again. A changed credential
version cannot alter an existing binding on retry. Deploy a new revision after
rotating the Secret.

## Compute and trust boundary

The route requires single-cluster Kubernetes Compute with managed channel
egress and an Installation-configured endpoint. Unsupported Compute or topology
selections fail admission. An Agent without enabled channels receives no
listener binding or additional proxy egress grant.

Envoy authorizes the final CONNECT host and port before connecting to the
selected proxy. The proxy owns final destination resolution and address
enforcement; Envoy cannot prove the proxy chose a public last-hop address.
Provider TLS remains end-to-end. Proxy failure or authentication refusal has no
direct fallback.

See [Kubernetes channel egress](../drivers/kubernetes-compute/channel-egress.md)
for enforcement and Installation inputs, and [configure channel egress](../../guides/deploy/channel-egress.md)
for the operator and Console procedure.
