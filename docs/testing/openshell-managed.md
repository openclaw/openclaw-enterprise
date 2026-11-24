# Managed OpenShell tests

The local tests exercise the real Sandbox Driver with fixture transports and
run the image bootstrap on a filesystem. They cover `service` selection, the
`legacy` default, storage ownership, workload rendering, protobuf messages and
the required Envoy route.

```sh
node --test \
  tests/conformance/openshell-managed-bootstrap.test.ts \
  tests/conformance/openshell-gateway-wire.test.ts \
  tests/conformance/kubernetes-provider-harness.test.mjs \
  tests/conformance/kubernetes-harness-workspace-volume.test.mjs \
  tests/conformance/kubernetes-compute.test.mjs \
  tests/integration/sandbox-driver-startup.test.ts
```

On a disposable cluster, verify both Harnesses with OCE denied access to the
managed namespace. Check node enrollment and reconnection through Envoy and
removal of obsolete direct ingress policies. Deploy an Agent, write a workspace
file, complete a model or tool turn, then replace and restart the workload.
Check that Sandbox and PVC identities stay stable and the file persists.
Confirm that final Agent deletion removes the Sandbox and PVC. Exercise rejected
peers, failed bootstrap, unsupported updates and lost acknowledgments.
See [stop and replacement ordering](../flows/openshell-managed-workload.md#stop-and-replacement-ordering).

The Provider and [Git replacement](openshell-git-replacement.md) scenarios
exercise parts of that workflow.

## Template resource delivery

Select `openshell-template-resources` to check actual Agent container sizing in
both integration modes. The input labels `operator` and `managed` select
`integrationMode: legacy` and `integrationMode: service`, respectively.
Prepare two disposable loopback k3d installations with
enforcing NetworkPolicies, this branch's API and worker, compatible OpenShell
APIs, and digest-pinned Codex and Gateway images. Use an existing authorized model
Credential Source. Give the observer permission to list Pods and get
`sandboxes.agents.x-k8s.io` in the Harness namespace, and to list Pods and
exec into the Gateway Pod in the tenant namespace.

Create two private input files using the [Provider replacement inputs](#provider-replacement).
In each file set `kubeconfigPath` (absolute path), `kubernetesContext` (the
corresponding `k3d-*` context) and `harnessNamespace` (where OpenShell runs
the Agent Pod). The test reads the Sandbox name from the Pod’s controlling
Sandbox and verifies its ID against the gateway. Each file also needs
`expectedResources`, the independently selected Kubernetes container requests and
limits. Include the ephemeral-storage request `256Mi` and limit `1Gi`; use the
quantity spelling returned by Kubernetes. The operator file also needs
`expectedMounts`, a nonempty array of approved volume-mount objects such as
`{ "mountPath": "/sandbox/enterprise", "subPath": "workspace" }`.

Disable OpenShell's `allow_driver_config` permission for the managed installation.
The test first deploys through OCE, then sends a negative-control create request
with caller driver config. That request must fail specifically because caller
driver config is disabled. Cleanup deletes the probe if the server unexpectedly
accepts it. Keep this installation disposable.

Set `OCC_TEST_OPENSHELL_RESOURCES_INPUT_FILE` to a private JSON file that maps
`operator` and `managed` to the absolute paths of those two input files:

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_INSTALLATION=kubernetes \
  OCC_TEST_QA_PRESET=Codex OCC_TEST_QA_SCENARIOS=openshell-template-resources \
  OCC_TEST_OPENSHELL_RESOURCES_INPUT_FILE=/tmp/oce-test/resources.json \
  node --test tests/integration/qa-matrix-real.test.mjs
```

If the host can run only one cluster at a time, keep both paths in the input
map. Run the command twice. Add `--test-skip-pattern='operator template sizing'`
after `--test` while the managed cluster runs. Use
`--test-skip-pattern='managed template sizing'` while the operator cluster runs.
Each filtered report covers the named stage that ran. Check that both stages
passed at the same commit.

The scenario deploys an
Agent through the API, compares its real Pod resources, verifies operator mounts,
reads and writes a workspace file, and completes a real model turn. Cleanup removes
the run-owned Agent, role and grant. Each Agent uses the prepared source directly.

Focused lifecycle tests additionally check missing or changed resource readback,
protobuf round trips, and refusal of managed sizing changes before update/start.
Those controlled responses are not cluster proof of failed replacement.
This scenario is registered in the QA lane but is not in hosted advisory jobs;
those jobs do not prepare compatible managed installations.

## Provider replacement

Use a disposable loopback k3d installation with this branch's API and worker,
a gateway meeting the [managed runtime requirements](../reference/drivers/kubernetes-openshell-compute.md),
OpenShell-owned persistent Sandbox storage, one worker and rebuilt Codex runtime images.
Select its kubeconfig and context explicitly. Prepare a ready OCE Namespace, a
dedicated Codex Configuration and an authorized static model Credential Source.
The test creates two Agents and two sources that reference the existing model
Secret. Its service key needs permission to manage those resources, IAM grants and Agent
network policies. The runtime must include `/usr/bin/curl`. The network probe uses
`https://example.org/`, which must be reachable when granted and absent from the
Installation's default allowed routes for that binary.

The API and worker startup configuration must delegate the probe grant:

```yaml
sandboxNetworkPolicyCeiling:
  - id: managed-revision-probe
    binary: /usr/bin/curl
    host: example.org
    ports:
      - from: 443
        to: 443
```

Reload the API and worker after changing startup configuration. The ceiling
authorizes policy edits and the scenario applies the grant. See
[delegation limits](../reference/sandbox-policies.md).

Set `OCC_TEST_OPENSHELL_REPLACEMENT_INPUT_FILE` to a private JSON file:

```json
{
  "disposable": true,
  "apiUrl": "http://127.0.0.1:4000",
  "serviceKeyFile": "/tmp/oce-test/service-key.txt",
  "namespaceId": "ns_REPLACE",
  "gatewayNamespace": "REPLACE_TENANT_KUBERNETES_NAMESPACE",
  "configurationId": "cfg_REPLACE",
  "modelSourceId": "cs_REPLACE",
  "model": "REPLACE_AUTHORIZED_MODEL",
  "gatewayClient": {
    "endpoint": "https://127.0.0.1:8080",
    "rootCertificatePath": "/tmp/oce-test/ca.crt",
    "auth": {
      "mode": "mtls",
      "certificatePath": "/tmp/oce-test/tls.crt",
      "privateKeyPath": "/tmp/oce-test/tls.key"
    }
  }
}
```

Store the raw service key in a private regular file. Select the gateway used by
OCE and supply the model Credential Source ID.

```sh
export OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-test/kubeconfig
export OCC_TEST_KUBERNETES_CONTEXT=k3d-oce-test
export OCC_TEST_OPENSHELL_REPLACEMENT_INPUT_FILE=/tmp/oce-test/replacement.json
node --test tests/integration/openshell-provider-replacement-real.test.ts
```

The test changes model sources and network grants separately, then together,
and redeploys unchanged. It checks stable Sandbox identity, exact Provider
membership, loaded policy, model turns and continued peer access. Curl must
succeed after grant and fail after removal, while the peer stays denied.
The scenario covers acknowledged changes with a probe host outside model routes.

Cleanup removes test-created Agents, grants and sources, preserving prepared
resources. Missing input skips the standalone test. A selected QA run requires
it: use `OCC_TEST_QA_SCENARIOS=openshell-provider-replacement` with the Kubernetes
Codex preset.

For an operator-approved existing cluster, use the
[explicit cluster selection](openshell-git-replacement.md#existing-cluster-selection).
