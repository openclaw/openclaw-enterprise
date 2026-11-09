# Managed OpenShell tests

The [managed Compute selection](../reference/drivers/kubernetes-openshell-compute.md)
requires rebuilt Harness images and the upstream OpenShell workload-update API
specified in that reference. Its independent wire fixture records the upstream
commit used for the lifecycle, workload-update and service-exposure messages.
The opt-in Provider replacement scenario below covers Credential Source changes;
it does not qualify the complete managed lifecycle.

Local checks cover launch inputs through Compute preparation, Kubernetes mounts,
OpenShell rendering and real filesystem bootstrap. The launch refactor removed
reverse-Deployment parser checks; identity, private setup delivery and retained
storage assertions now inspect constructed requirements or rendered resources.
These checks do not establish live managed-Workspace integration.

Local checks:

```sh
node --test tests/conformance/openshell-managed-bootstrap.test.mjs tests/conformance/openshell-gateway-wire.test.mjs tests/conformance/kubernetes-provider-harness.test.mjs tests/conformance/kubernetes-harness-workspace-volume.test.mjs tests/conformance/kubernetes-compute.test.mjs tests/integration/sandbox-driver-startup.test.mjs
```

Before qualification, extend the QA matrix's regular Agent workflow on a disposable
cluster. Deny OCE access to the managed namespace. Deploy, read/write an allowed
workspace file, run a model/tool turn, replace the revision, stop/restart, then
delete the Agent. Confirm stable Sandbox/PVC identity and retained files through
replacement; confirm deletion only at final Agent removal. Exercise both Harnesses,
rejected peers, failed bootstrap, unsupported updates and lost acknowledgments.
See [stop and replacement ordering](../flows/openshell-managed-workload.md#stop-and-replacement-ordering) for the assumptions about failed stop requests.

For Git repository changes across revisions, use the [Git replacement scenario](openshell-git-replacement.md).

## Provider replacement

Use a disposable loopback k3d installation with this branch's API and worker,
a gateway meeting the [managed runtime requirements](../reference/drivers/kubernetes-openshell-compute.md),
managed Workspaces, one worker and rebuilt Codex runtime images.
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

This ceiling permits Agent policy edits; it does not grant network access itself.
An empty ceiling refuses the test grant. Reload both API and worker after changing
startup configuration. See [delegation limits](../reference/sandbox-policies.md).

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

The service-key file contains the raw key. The OpenShell endpoint must reach the
same gateway used by OCE. No model credential value belongs in this input file.

```sh
export OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-test/kubeconfig
export OCC_TEST_KUBERNETES_CONTEXT=k3d-oce-test
export OCC_TEST_OPENSHELL_REPLACEMENT_INPUT_FILE=/tmp/oce-test/replacement.json
node --test tests/integration/openshell-provider-replacement-real.test.ts
```

The test changes model sources and network grants separately, then together,
and redeploys unchanged. It checks stable Sandbox identity, exact Provider
membership, loaded policy, model turns, and continued peer access. Real curl
requests must succeed after granting access and fail after removal; the peer
must remain denied. The example.org grant does not overlap model credentials,
so this does not reproduce the upstream inspection defect. Local tests cover
lost-response recovery; this scenario does not inject failures.

Cleanup removes test-created Agents, grants and sources, preserving prepared
resources. Missing input skips the standalone test. A selected QA run requires
it: use `OCC_TEST_QA_SCENARIOS=openshell-provider-replacement` with the Kubernetes
Codex preset.

For an operator-approved existing cluster, use the
[explicit cluster selection](openshell-git-replacement.md#existing-cluster-selection).
