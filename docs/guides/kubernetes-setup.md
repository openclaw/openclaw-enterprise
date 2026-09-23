# Set up OpenClaw Enterprise on Kubernetes

Install the OpenClaw Control Plane (OCC) in a Kubernetes cluster you already operate. This guide takes you from checking the cluster to authenticating to the installed API, with private routing for Console workspace access enabled as part of setup. If you want to try OpenClaw Enterprise on your machine, use [Local Setup](quickstart.md); that profile runs OCC in Compose and Agent workloads in k3d.

## Before you start

You need:

- Kubernetes 1.35 or later, IPv4 connectivity, and a network plugin that enforces NetworkPolicies. You need permissions to create the control-plane namespace, RBAC, Secrets, and storage claims.
- Envoy Gateway, Gateway API CRDs, cert-manager, and an existing Envoy GatewayClass. Complete the [workspace routing requirements](deploy/workspace-routing.md#requirements) before installing OCC; the OCC chart does not install these controllers.
- Helm, a version-compatible `kubectl`, Python 3, `yq` v4, and the [OCC CLI](cli.md).
- External PostgreSQL with separate application and migration roles, verified TLS, and a registry your cluster can pull controller and runtime images from.
- Storage for the bootstrap and gateway volumes, and an approved internal HTTPS origin for OCC. Dedicated Agent workspaces also need a default StorageClass that supports `ReadWriteMany`. The chart does not create public Ingress or TLS.
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

Use [Install the production control plane](deploy/production-installation.md) to select published images or build your own, configure protected Helm values and Installation YAML with image digests, create the system Secrets, and prepare the fresh bootstrap volume. The chart does not create these inputs. Stop when you reach **Install the chart with native values** in [Prepare the fresh bootstrap output PVC](deploy/production-installation.md#prepare-the-fresh-bootstrap-output-pvc). Complete its required **Prepare workspace access** step, including the service-key Secret, before returning here. Keep routing enabled in both Helm values and the Installation startup configuration. Keep the same shell and protected files, then run Helm once:

```bash
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  --wait --timeout 5m
```

The release runs migration and bootstrap before the API and worker. A ready release means the control-plane probes passed; it does not show that you can authenticate or that an Agent can answer a model request. If installation fails, start with [platform troubleshooting](operate/troubleshooting.md).

## 3. Authenticate and continue to an Agent

Retrieve `initial-admin-service-key.json` from the protected bootstrap volume through your approved storage process. Keep that original in protected storage: bootstrap will not reissue it. Set the endpoint and protected original path:

```bash
export OCC_URL='https://<internal-occ-host>'
export OCC_BOOTSTRAP_KEY_FILE="$OCC_INPUT_DIRECTORY/initial-admin-service-key.json"
```

In the same shell, follow [Authenticate to the production API](deploy/production-installation.md#authenticate-to-the-production-api) to create a separate private copy and run `occ installation get`.

Expect the displayed `ID` to match `meta.installationId` in the key file. If it does not authenticate, see [Troubleshoot API authentication](operate/troubleshooting.md#authentication-fails-after-installation). If initialization did not finish, follow [bootstrap recovery](../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap).

Keep the same shell and temporary key copy to [prepare Namespaces and deploy Agents](deploy/production-agents.md), then [verify workspace access](deploy/production-agents.md#verify-workspace-access) and [a real model response from that Agent](deploy/production-agents.md#verify-production-workloads). These are separate completion checks; a successful deployment does not establish either one. At the end, [remove only the temporary credential copies](deploy/production-agents.md#end-the-operator-session). The [local first-Agent walkthrough](first-agent.md) uses a different installation and should not be run against this one.
