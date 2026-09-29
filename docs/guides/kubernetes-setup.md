# Set up OpenClaw Enterprise on Kubernetes

Prepare a Kubernetes cluster you already operate, then follow the shared
[production installation runbook](deploy/production-installation.md) to install
and authenticate to the OpenClaw Control Plane (OCC). If you want to try
OpenClaw Enterprise on your machine, use [Local Setup](quickstart.md).

## Before you start

You need:

- Kubernetes 1.35 or later, IPv4 connectivity, and a network plugin that enforces NetworkPolicies. You need permissions to create the control-plane namespace, RBAC, Secrets, and storage claims.
- Envoy Gateway, Gateway API CRDs, cert-manager, and an existing Envoy GatewayClass. Complete the [workspace routing requirements](deploy/workspace-routing.md#requirements) before installing OCC; the OCC chart does not install these controllers.
- Helm, a version-compatible `kubectl`, Python 3, `yq` v4, and the [OCC CLI](cli.md).
- Bash for the image-selection and model-verification commands. Node.js 24 or newer
  for profile generation and the API transport-credential example. Manual YAML
  plus console transport provisioning avoids those Node commands.
- Docker and Git to [select the latest published images](deploy/published-images.md)
  and their matching source checkout; Buildx only if building your own images.
- External PostgreSQL with separate application and migration roles, verified TLS, and a registry your cluster can pull controller and runtime images from.
- Storage for the bootstrap and gateway volumes, and an approved internal HTTPS origin for OCC. Dedicated Agent workspaces also need a default StorageClass that supports `ReadWriteOnce`. The chart does not create public Ingress or TLS.
- To run an Agent with an OpenAI API key: a model credential and OCC permissions to grant the Agent `operate` on its exact Secret. Fresh native-IAM bootstrap gives its administrator service key the required Installation `administer`, Namespace `read`, and Secret `read` permissions. If you use a limited credential, arrange for an Installation administrator to [create the grant](deploy/production-agents.md#grant-the-agent-access-to-its-model-secret). Kubernetes RBAC does not replace it.

The [standard Kubernetes guide](deploy/kubernetes.md#prepare-the-cluster) covers node pools, storage, and network access in detail. For AWS, start with [Amazon EKS](deploy/eks.md); it uses the same Helm installation procedure.

## 1. Check the cluster

Run from the repository root. Set the private directory and approved cluster context. Save the administrator-provided kubeconfig at the path shown before continuing:

```bash
export OCC_INPUT_DIRECTORY='/secure/occ'
export KUBECONFIG_FILE="$OCC_INPUT_DIRECTORY/kubeconfig"
export CONTEXT='<approved-cluster-context>'
install -d -m 700 "$OCC_INPUT_DIRECTORY"
# Save the administrator-provided kubeconfig at $KUBECONFIG_FILE before continuing.
chmod 600 "$KUBECONFIG_FILE"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" version
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" get nodes -L oce-role
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" get storageclasses
```

Confirm the server version, that nodes have the control-plane and Agent labels you plan to use, and that the required StorageClasses exist. The provided examples use `oce-role=control` and `oce-role=agents`. If your labels differ, replace `oce-role` in the `get nodes` command with your label key and update the configuration.

## 2. Prepare the inputs and install OCC

In the same operator shell, complete [Install the production control
plane](deploy/production-installation.md) through its authentication check. It
covers image selection, configuration, system Secrets, private routing, the
bootstrap volume, and Helm installation. Generate configuration with its
recommended profile path, or use its advanced manual YAML branch when you need
custom settings.

If installation fails, follow [platform troubleshooting](operate/troubleshooting.md) and
[bootstrap recovery](../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap).

## 3. Deploy and verify an Agent

A ready control plane and a passing
[authentication check](deploy/production-installation.md#authenticate-to-the-production-api)
do not prove that an Agent can answer a model request.

Keep the same shell and temporary key copy to [prepare Namespaces and deploy Agents](deploy/production-agents.md), then [verify workspace access](deploy/production-agents.md#verify-workspace-access) and [a real model response from that Agent](deploy/production-agents.md#verify-production-workloads). These are separate completion checks; a successful deployment does not establish either one. At the end, [remove only the temporary credential copies](deploy/production-agents.md#end-the-operator-session). The [local first-Agent walkthrough](first-agent.md) uses a different installation and should not be run against this one.
