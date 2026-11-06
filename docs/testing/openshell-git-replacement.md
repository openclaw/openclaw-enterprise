# Verify Git access across managed Sandbox revisions

Run this scenario after deploying matching OCE API, worker and runtime images
with managed OpenShell replacement support. It exercises unchanged repository
settings through the real Agent API and worker. It does not change installation
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
    "deniedUrl": "https://github.com/example/unselected-private.git"
  }
}
```

Both repositories must exist. The first must have a commit and
be approved for the selected Namespace and profile. The second must be outside
the Agent's grant. Use lowercase HTTPS URLs ending in `.git`. Tokens do not
belong in these URLs or the input file.

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

The scenario creates two Agents with the same repository selection. It fetches
the approved repository, writes a workspace marker, and deploys a new revision
without changing Git settings. It requires the same Sandbox ID, retained files,
a new middleware binding, removal of the old Provider/profile, and successful Git
fetch and model turns after replacement. The unselected repository must remain
denied, and the peer Agent must retain Git and model access. Cleanup deletes the
test-created Agents and IAM resources. It preserves the prepared model source
and its Secret.

Live verification on the operator-approved cluster with controller image
`quay.io/gordons/oce-controller@sha256:ade513a3e845d56009f5b51271d0f98b3e6a28b1d466b874db7700b7c7a6a687`
on 2026-11-06 passed both initial deployments, model turns on both Agents, an
allowed fetch and denial of the unselected repository. Startup used API-based
identity checks without granting worker Pod access to OpenShell-managed
namespaces. The earlier TLS hostname failure was resolved by updating the
service certificate; hostname verification remained enabled. The direct Codex
test input used the native model ID, without OCE's provider prefix.

Replacement failed with `REPOSITORY_GIT_ROUTE_BLOCKED`. The worker reported
`git-provider-generation` continuity refusal and
`OPENSHELL_GIT_RECONCILIATION_REQUIRED`. Investigation found that enrollment
compared OpenShell policy version 4 with the new OCE plan's generation 1 and
rejected the installation. The startup challenge matched the admitted plan, but
the Harness timed out waiting for enrollment. Later runtime Provider renewal
changed the aggregate Provider environment revision and triggered the continuity
refusal; the observed execution identity did not change.

The counter fix passed that enrollment check on a second live run with controller
image `quay.io/gordons/oce-controller@sha256:985e4ddc680c8adcb53d004f93537210fab8491ec348a65511383ce1b0d450d5`.
Both initial deployments, model turns and Git allow/deny checks passed again.
Replacement then failed when enrollment storage refused the successor receipt
under the retained Sandbox ID. The local fix retains receipts per revision and
retires the previous enrollment after a confirmed stop. Repeat the scenario with
rebuilt images to verify this transition. Retained files, Git and model access
after replacement, and peer isolation remain unverified. Both runs removed their
test-owned Agents and IAM resources and preserved the original API inventory.

Local tests cover operator and managed execution without Kubernetes access,
ownership refusals, execution changes, interrupted cleanup and denial of the
retired middleware binding with controlled OpenShell responses. The live scenario
does not inject failures or restart the worker.
