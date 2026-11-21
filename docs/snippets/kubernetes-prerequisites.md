---
tags: [human_verified]
last_verified: "2026-11-18"
published: false
---

- **Cluster:** Kubernetes 1.35+, IPv4, enforced NetworkPolicies, and an explicitly selected context. Operator permissions to create namespaces, RBAC, Secrets, and storage claims.
- **Routing:** Envoy Gateway (tested v1.6.7), Gateway API and Envoy Gateway CRDs, cert-manager and its CRDs, and an accepted Envoy GatewayClass. Provide an approved internal HTTPS origin and exact IPv4 `/32` egress destinations. [Install routing separately](/guides/deploy/workspace-routing/#requirements); OCE does not install these controllers or create public TLS or Ingress.
- **Channels:** Before installing with channels enabled, [prepare managed channel egress](/guides/deploy/channel-egress/), including EnvoyPatchPolicy support and actual Pod, Service, and node address exclusions. Helm defaults channel egress on but does not install the Envoy controller or CRDs. Match the Helm and Installation settings; private workspace routing uses a separate fleet.
- **Tools:** Helm, version-compatible kubectl, Python 3, jq, yq v4, Bash, and the [OCC CLI](/guides/cli/). Profile generation also needs Node.js `>=24.22.1 <26 || >=26.12.1`; manual YAML does not.
- **Images:** Docker and Git for [image selection](/guides/deploy/published-images/), immutable controller/runtime digests, a matching checkout and chart, and [registry pull access](/guides/deploy/private-registry-images/) on every eligible node. Buildx is required only for source builds.
- **Database and credentials:** External [PostgreSQL 18.6](/reference/settings/operations/#postgresql-server-compatibility), verified TLS, and separate application and migration roles. Protected startup, database, authentication, and selected Backend credentials.
- **Node pools:** A trusted pool for OCC and dedicated Agent gateways, separate from Harness and embedded Agent Pods, with [matching node selectors](/guides/deploy/kubernetes/#prepare-the-cluster).
- **Storage:** Gateway storage and a precreated bootstrap credential Secret. Dedicated Agent workspaces also need a default `ReadWriteOnce` StorageClass; see [storage requirements](/guides/deploy/kubernetes/#prepare-storage-database-and-network-access).
- **Agent authentication:** An OpenAI API key and Agent `operate` permission on its exact Secret to run an Agent; no model credential to install OCE. The operator needs Installation `administer`, Namespace `read`, and Secret `read` permissions, supplied by native-IAM bootstrap or an [administrator grant](/guides/deploy/production-agents/#grant-the-agent-access-to-its-model-secret). Kubernetes RBAC does not replace OCE IAM.
