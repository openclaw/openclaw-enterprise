# Verify Git access across managed Sandbox revisions

Run this scenario after deploying matching OCE API, worker and runtime images
with managed OpenShell replacement support. It exercises Git enablement,
disablement, re-enablement, unchanged settings, and repository additions and
removals through the real Agent API and worker. It also
terminates the run-owned Harness supervisor through OpenShell exec and verifies
automatic recovery under the same revision. It does not change installation
configuration or write to GitHub.

## Prepare the installation

Use the disposable loopback k3d installation and private JSON input described in
[Provider replacement](openshell.md#provider-replacement). This Git scenario does
not need the example.org delegation ceiling or its curl probe.
For an operator-approved existing cluster, use the
[explicit cluster selection](#existing-cluster-selection) instead.

Complete [OpenShell repository enrollment](../guides/repository-credentials/openshell-enrollment.md):
configure the GitHub App, Namespace registry policy, worker credentials, durable
route storage, authenticated middleware registration and Supervisor connectivity.
Use dedicated Codex. Set `modelSourceId` in the input file to an existing, ready
Gateway-owned model Credential Source in the selected Namespace, with no `egress`.
The scenario binds both Agents to that source through the API and grants their
service principals permission to use it.

The Git-only Credential Proxy currently refuses new model source registration.
Reuse a source registered before enabling the Proxy, as described in
[model source enrollment](../guides/repository-credentials/openshell-enrollment.md#register-the-harness-model-source-first).
The normal Console API-key creation flow registers a new source even when you
select an existing Secret, so use this API scenario for now. It does not test
model source registration or replacement.

Add this object to the input file, replacing the example references and URLs:

```json
{
  "git": {
    "repositoryRef": "application",
    "profile": "github-repository",
    "url": "https://github.com/example/approved-private.git",
    "additionalRepositoryRef": "library",
    "additionalUrl": "https://github.com/example/library-private.git"
  }
}
```

Both repositories must exist, have a commit, and be approved for the selected
Namespace with `github-repository` and the same explicit permission map. The
second starts outside the Agent's grant and is added during the test. Use lowercase
HTTPS URLs ending in `.git`. Tokens do not belong in these URLs or the input file.

Public repositories can verify allowed and denied access across revisions.
Use a private allowed repository to also verify credential delivery; a successful
public fetch does not establish that credentials were used.

## Existing cluster selection

The Provider and Git replacement scenarios can use an existing cluster with
explicit operator approval. They create and delete their own Agents and IAM
resources, and the Provider scenario also creates model sources. They preserve
the prepared Namespace, Configuration, model source and cluster configuration.

Replace `disposable` in the private input file with:

```json
{
  "existingCluster": {
    "context": "REPLACE_APPROVED_CONTEXT",
    "server": "https://REPLACE_KUBERNETES_API:8443",
    "kubeSystemUid": "REPLACE_KUBE_SYSTEM_NAMESPACE_UID"
  }
}
```

Set the kubeconfig and context variables explicitly. Read the selected API
endpoint with `kubectl --kubeconfig PATH --context CONTEXT config view --minify`
and the UID with `kubectl --kubeconfig PATH --context CONTEXT get namespace kube-system -o jsonpath='{.metadata.uid}'`.
The runner requires all three values to match before creating resources. Keep
these installation-specific inputs outside the checkout. This selection applies
only to the two replacement scenarios; other Kubernetes suites still require
their documented disposable clusters.

## Run and inspect the result

With the kubeconfig, context and `OCC_TEST_OPENSHELL_REPLACEMENT_INPUT_FILE` selected:

```sh
OCC_TEST_QA_MATRIX=1 \
OCC_TEST_QA_INSTALLATION=kubernetes \
OCC_TEST_QA_PRESET=Codex \
OCC_TEST_QA_SCENARIOS=openshell-git-replacement \
node --test tests/integration/qa-matrix-real.test.mjs
```

The scenario creates one Agent without Git and a peer with repository A selected.
It denies Git access on the first Agent, writes a workspace marker, and verifies
model turns. It enables A on that Agent and requires the same Sandbox and marker,
a successful fetch of A, and denial of B. It then verifies automatic recovery
with the same Sandbox and revision, allowed and denied Git reads, and model turns.

The scenario redeploys unchanged settings, adds B, removes A, disables Git with an
empty repository selection, and enables A again. Each replacement retains the
Sandbox ID and fetched files. Git-enabled revisions require fresh middleware and
authority; Git-free revisions must have no Git Provider, middleware, environment
setup or enrollment configuration. Old Providers and profiles must be deleted.
Removed or unselected repositories must be denied, and each revision must complete
a model turn. The peer keeps access to A and cannot access B throughout. Cleanup
deletes test-created Agents and IAM resources and preserves the prepared model
source and its Secret. The scenario does not change registry permissions, test Git
writes, or switch profiles that change static policy.

Local tests use controlled OpenShell responses for failure cases. The live runs
below record the separately verified cluster behavior.

On 2026-11-06, the repository-change checks passed on the operator-approved cluster
with these deployed images:

- Controller: `quay.io/gordons/oce-controller@sha256:4c702414978b6e01331937207b6f321bfc1a97928beec753350793793541bc91`
- Runtime: `quay.io/gordons/oce-runtime@sha256:d8a0b5524d3874704394f390f09afcd147acf902b0d3a2521a79ab9c8ea360bf`
- OpenShell Gateway: `quay.io/gordons/openshell-gateway@sha256:ac8e5ffe38b59b602a9e17956253b697ad03382aa15fb67e2b9e9bd936445549`

The run verified unchanged redeployment, repository addition and removal,
retained files and Sandbox identity, retired Providers, model turns after each
replacement, and peer isolation. Fetching the second, private repository verified
credential delivery. Removing the first repository denied subsequent remote access
while preserving local files. The scenario and parent test passed with no skips.
Cleanup restored the original API inventory and removed test-owned Pods and PVCs.
The worker needed no Pod access in OpenShell-managed namespaces.

Both repository grants used the same read-only permission map. Live replacement
of registry permissions and Git writes remain unverified.

On 2026-11-09, the complete scenario passed, including automatic recovery with
the same Sandbox and revision, allowed and denied Git access, and model turns
for the recovered Agent and its peer. Unchanged redeployment, repository addition
and removal, retained files, retired Providers and peer isolation also passed.
The run used the same OpenShell Gateway image as above, with:

- Controller: `quay.io/gordons/oce-controller@sha256:1d9ba7b4daa4f71e30fa22009d0430c6247f33e42ffa258ae3fd6d823001bb53`
- Runtime: `quay.io/gordons/oce-runtime@sha256:ce010a3c334db23875ca47746baa4532de6ae77e494fc6a1aea0002d81667662`

This run verified both recovery fixes: changing internal OpenShell annotations
do not invalidate the retained launch, and repeated equivalent readiness reads
preserve the installed launcher's acknowledgment. The test waits for an
authenticated Harness WebSocket before submitting each model turn because Git
can become available before Codex finishes startup. The scenario and parent test
passed with no skips. Cleanup restored the original API inventory and removed
test-owned Pods and PVCs.

Local tests cover operator and managed execution without Kubernetes access,
ownership refusals, execution changes, repository additions/removals, changed
permission maps, Git toggles, interrupted cleanup, lost policy/attachment/workload/start
replies, stale cleanup and denial of the retired middleware binding with controlled
OpenShell responses. The live scenario
does not restart the worker.

On 2026-11-17, the expanded scenario passed on the operator-approved existing
cluster with these deployed images:

- Controller: `quay.io/gordons/oce-controller@sha256:74929b60cbc759f3181438f4d60aa6aa559cdb9b4f81d59a54825d77118663ed`
- Runtime: `quay.io/gordons/oce-runtime@sha256:d6568685a0809df6b3b9a4863fc8cb2221840ff535e1342d4c6bca9702b1a6bf`
- OpenShell Gateway: `quay.io/gordons/openshell-gateway@sha256:ac8e5ffe38b59b602a9e17956253b697ad03382aa15fb67e2b9e9bd936445549`

API and worker copies of `openshell/managed.ts` matched the tested checkout.
The run used dedicated Codex with `gpt-5.6-luna` and verified Git enablement,
unchanged redeployment, repository addition/removal, disablement and re-enablement
on the same Sandbox. Retained files, fresh Git authority, removed-access denial,
retired Providers/profiles, automatic Harness recovery, model turns and peer
isolation all passed. The second repository was confirmed private, so its fetch
also verified credential delivery.

The scenario and parent test passed with no skips in approximately eight minutes.
Cleanup restored the original Agent, Credential Source, role and access-binding
inventories and deleted the test Configuration. The existing user Agent was
preserved. This run does not qualify permission-map changes, Git writes, worker
restart, or profile transitions that change static policy.
