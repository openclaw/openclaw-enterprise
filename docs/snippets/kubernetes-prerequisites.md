---
published: false
---

- **Cluster and access:** Kubernetes 1.35 or later, IPv4 connectivity, a network
  plugin that enforces NetworkPolicies, and an explicitly selected Kubernetes
  context. The operator needs permission to create namespaces, RBAC, Secrets,
  and storage claims. Older Kubernetes versions are outside the supported boundary.
- **Routing:** Envoy Gateway, Gateway API CRDs, cert-manager, and an existing
  Envoy GatewayClass. Complete the [workspace routing requirements](/guides/deploy/workspace-routing/#requirements).
  The OCE chart does not install these controllers or create public TLS or Ingress.
  Provide an approved internal HTTPS origin and exact IPv4 `/32` egress destinations.
- **Operator tools:** Helm, a version-compatible `kubectl`, Python 3, `yq` v4,
  and the [OCC CLI](/guides/cli/). Use Bash for image selection and model
  verification. Profile generation and the API transport-credential example
  require Node.js 24.22.1 or newer; manual YAML with Console transport provisioning
  avoids those Node commands.
- **Images:** Docker and Git to [select published images](/guides/deploy/published-images/)
  and their matching source checkout and chart. Use immutable controller and
  runtime image digests. Buildx is needed only when building images. Every eligible
  node needs registry pull access; see [private registry delivery](/guides/deploy/private-registry-images/).
- **Database:** External PostgreSQL 18.6 with separate application and migration roles
  and verified TLS. Follow [database preparation and version checks](/guides/deploy/postgresql/).
  Prepare protected startup, database, authentication, and any
  selected Backend credentials during installation.
- **Node pools:** A trusted pool for OCC and dedicated Agent gateways, separate
  from the pool for Harness and embedded Agent Pods. Match the reviewed labels
  in `controlPlane.nodeSelector`, `runtime.gatewayNodeSelector`, and
  `runtime.nodeSelector`; see [Kubernetes cluster preparation](/guides/deploy/kubernetes/#prepare-the-cluster).
- **Storage:** A fresh protected bootstrap PVC and gateway storage. Dedicated
  Agent workspaces also need a default StorageClass supporting `ReadWriteOnce`.
  Use the [storage requirements](/guides/deploy/kubernetes/#prepare-storage-database-and-network-access)
  to select capacities and classes.
- **Agent authentication:** Installation alone does not need a model credential.
  To run an Agent with an OpenAI API key, provide the credential and grant the
  Agent `operate` on its exact Secret. Fresh native-IAM bootstrap gives its
  administrator service key the required Installation `administer`, Namespace
  `read`, and Secret `read` permissions. With a limited credential, arrange for
  an administrator to [create the grant](/guides/deploy/production-agents/#grant-the-agent-access-to-its-model-secret).
  Kubernetes RBAC does not replace OCC IAM.
