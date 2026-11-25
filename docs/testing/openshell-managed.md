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

The installed Provider replacement scenario in this section exercised the
retired protected Git middleware. Its [earlier procedure](https://github.com/openclaw/openclaw-enterprise/blob/67865414220f9d67820f165fe932fe23df025322/docs/testing/openshell-managed.md) applies to the matching release.
