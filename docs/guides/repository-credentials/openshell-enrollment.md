# Enroll repositories for OpenShell Agents

This Helm walkthrough covers repository access with matching OpenShell **0.1.6**
components. Check the [OpenShell qualification contract](../../reference/drivers/openshell-sandbox.md#qualification-contract)
before planning a production rollout. Runtime admission checks the required facilities and policy proof.
The [local setup guide](../deploy/local-openshell-images.md) lists component versions. Select Kubernetes
Compute, dedicated Codex, and the same OpenShell Driver for Sandbox and
Credential Proxy. Repository access requires its own explicit Namespace policy;
installing OpenShell does not grant it.

### Register the Harness model source first

For a fresh local k3d installation, use the authenticated
[Gateway setup](#prepare-an-authenticated-local-gateway).

A fresh installation needs a ready, Gateway-owned model source before enabling
the repository Credential Proxy. If that source already exists, start at step 2.

1. Select the OpenShell Gateway and Sandbox. Leave `drivers.credential_proxy`
   and the Backend’s `drivers.credential_proxy` unset. [Register the model source](../deploy/openshell-credential-sources.md)
   and verify that its state and Gateway status are ready and that it has no `egress`.
2. Keep the Gateway selected and use that same source with
   `harnessAuth.method: credential_source`. Enable the repository Credential Proxy
   as described below. This procedure is for a fresh installation; changing an
   existing installation can affect running Agents.

### Prepare an authenticated local Gateway

Complete [local setup](../deploy/local-setup.md) before adding repository access.
The Kubernetes-only launcher enables Gateway TLS, mTLS and authentication before
its first startup. It keeps Credential Gateway selected for model access.

Leave `OCC_DEVELOPMENT_PROTECTED_EGRESS` unset, empty or set to `0`. The value `1`
is rejected because new local [static-inference launches are retired](../deploy/local-openshell-images.md#select-the-protected-profile).
Remove `OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP` entirely; any presence is rejected.
Repository access retains the ordinary authenticated Gateway defaults. No Gateway
configuration repair or Pod deletion is needed for the default profile.

### Configure authorized repositories

Start with the shipped
[OpenShell Installation fragment](../../../deploy/examples/repository-credentials/openshell.fragment.yaml)
and [repository registry](../../../deploy/examples/repository-credentials/openshell.registry.json).
Merge the fragment into your Installation, preserving other Backends and Drivers.
Set the existing OpenShell Backend's `drivers.credential_proxy` to the same ID as
`drivers.sandbox.id`. For example, when the Sandbox ID is `openshell-sandbox`,
add this selection to the Installation:

```yaml
drivers:
  credential_proxy:
    id: openshell-sandbox
    configuration: {}
```

Keep `drivers.credential_gateway` and its Backend member for model authentication.
The repository authority is configured by `repository.openShell`; do not carry
the static-inference Proxy's authority configuration into this empty selection.
Use the normal [production Installation and Helm procedure](../deploy/production-installation.md).
The development launcher's native repository input is a separate path and does
not accept this protected registry.

Do not combine it with `repository.nativeSender` or Compute
`network.repositoryCredentials`. The separate `registry.json` example is for
ref-limited native Git; leave existing narrow grants unchanged.

Replace the example App ID, installation ID, Namespace ID, repository names and
stable numeric repository IDs with operator-verified values. Add one entry per
repository that the Namespace may select. Set `profiles: ["github-repository"]`
explicitly. Copy the same approved repository permission map to each entry in a
selection. The example permits contents, pull requests and issues writes; it does
not grant those permissions to the App. Configure the App and installed permissions
accordingly. Do not substitute `github-installation`, organization permissions or
an installation-wide token. No branch list or preview workspace is required.

Mount the edited registry as `registry.json` in an immutable versioned ConfigMap.
In the OCE Helm values set `repositoryCredentials.registryConfigMapName` to that
ConfigMap, `backendId: repository-backend`, `authority: prepared-git`, and
`enabled: false`. Set `appKeySecretName` and `preparedCustodySecretName` to the
operator-managed worker-only Secrets, and `upstreamCidrs` to the
[worker GitHub API ranges](#allow-the-worker-to-reach-github).
Preserve the custody key across restarts. Never put keys in Agent JSON.

Complete [the request-phase service setup](../../reference/repository-credentials/protected-openshell-git.md#prepare-the-request-phase-service):
set `openshellGit.enabled: true`, `mode: protected`, its TLS Secret, public issuer
key ConfigMap and trusted Gateway/supervisor clients. Match the fragment's port
8445, issuer, audience and key ID to the actual Gateway. Register `oce-prepared-git`
with `binding_policy: allowlist` and `bindings: [http_request_pre_credentials]`.
Missing or response-only bindings are not sufficient. Render the normal Helm
release and run normal Installation startup validation before admitting Agents.

### Allow the worker to reach GitHub

`repositoryCredentials.upstreamCidrs` is an OCE Helm value: a nonempty list of
approved IPv4 ranges for the worker's outbound repository-credential requests.
The chart uses it in a Kubernetes NetworkPolicy with
`repositoryCredentials.upstreamPort` (default `443`). It does not grant the Agent
or OpenShell supervisor network access.

For this GitHub.com setup, the worker calls `api.github.com` to check the App
installation and issue or revoke tokens. Get the current `api` ranges from
[GitHub's Meta endpoint](https://docs.github.com/en/rest/meta/meta#get-github-meta-information).
Run this in the operator shell to generate a Helm YAML fragment:

```bash
gh api --hostname github.com /meta --jq '
  [.api[] | select(contains(":") | not)] | unique |
  "repositoryCredentials:\n  upstreamCidrs:\n" +
  (map("    - " + .) | join("\n"))
' > "$RUN_DIR/github-api-egress.yaml"
cat "$RUN_DIR/github-api-egress.yaml"
```

Review the ranges, then merge this fragment into the existing OCE Helm values
without replacing the other `repositoryCredentials` settings. Keep the approved
ranges with the deployment record and refresh them when GitHub changes its
inventory. Do not substitute a snapshot of DNS answers. If the worker uses a
private issuer or an outbound proxy, use its approved destination ranges instead.
The OpenShell supervisor's HTTPS access to the Git origin is configured separately.

### Allow the Supervisor to reach the authority

If the Supervisor namespace enforces egress, add this policy to the Sandbox
configuration's `gateway.networkPolicyResources`. For an existing namespace,
also apply the same file there before deployment. Replace `openclaw-system` with
the OCE Kubernetes namespace and the release label with the worker's observed
label. Keep existing DNS and management allowances.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-oce-prepared-git
spec:
  podSelector:
    matchLabels:
      openshell.ai/managed-by: openshell
      openshell.ai/boundary-role: supervisor
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: openclaw-system
          podSelector:
            matchLabels:
              app.kubernetes.io/name: openclaw-enterprise
              app.kubernetes.io/instance: openclaw-enterprise
              app.kubernetes.io/component: worker
      ports:
        - { protocol: TCP, port: 8445 }
```

```bash
kubectl --context "$CONTEXT" -n "$SUPERVISOR_NAMESPACE" \
  apply -f supervisor-authority-egress.yaml
```

`SUPERVISOR_NAMESPACE` is the observed Kubernetes namespace, not its OCE Namespace
ID. If the Gateway is also isolated for egress, allow its observed Pod labels to
the same worker and port. Do not select Agent workload Pods as trusted peers.

### Select repositories and deploy

Before activating a repository binding, verify the App installation from the
current worker. Use its mounted signing key and the issuer's CA configuration;
an operator's `gh` result or an unsigned HTTPS read does not check this path.
The [installation check](../../assets/openshell-quickstart/verify-github-installation.mjs)
uses the worker's signer and issuer request-options factory, but sends only a
bodyless installation GET. It creates no admission and requests no token.

Set `ISSUER_CA_PATH` to `repository.preparedGitHub.issuerCaPath`, or leave it
empty if that setting is absent. The example uses the fragment's standard mount
paths and GitHub.com. Use `namespace` from the quickstart session for the OCE Namespace ID approved in the
registry. Set `WORKER_POD` to the current worker Pod and `PLATFORM_NS`
to its Kubernetes namespace, then run from the matching release checkout:

```bash
kubectl --context "$CONTEXT" -n "$PLATFORM_NS" get pod "$WORKER_POD" \
  -o jsonpath='{.metadata.uid}{"\n"}{.spec.containers[?(@.name=="worker")].image}{"\n"}{.status.containerStatuses[?(@.name=="worker")].imageID}{"\n"}'

kubectl --context "$CONTEXT" -n "$PLATFORM_NS" exec -i "$WORKER_POD" -c worker -- \
  node --input-type=module - "$namespace" "${ref:-application}" "${ISSUER_CA_PATH:-}" \
  < docs/assets/openshell-quickstart/verify-github-installation.mjs
```

Require `success: true`: HTTP 200, verified TLS and matching App and installation
IDs. The helper keeps the key, JWT, headers and response body inside the worker.
Save the context, Pod UID, selected image, runtime image ID and result together.
Check the result's `connection` addresses against the worker's enforced egress
rule and approved provider inventory. The helper records at most four DNS
addresses and four connection errors, plus TCP, verified TLS and request-end
stages. A DNS snapshot from another Pod or workstation does not verify this path.
If it fails, keep the Agent stopped and correct the observed prerequisite before
deployment. A successful GET does not prove token issuance or Git access. If an
issuance is already uncertain, preserve its original recovery bound and follow
the [Token Service lifecycle](../../reference/repository-credentials.md#token-service-lifecycle).

Select any authorized set of up to 16 repositories on the Agent. The normal Agent
create/update JSON uses registry references, for example:

```json
{
  "repositoryBindings": [{ "repositoryRef": "application" }, { "repositoryRef": "library" }]
}
```

This is a fragment of the Agent request; preserve its other required fields.
For CLI updates, include the current `configurationId` from `occ agent get` in
`agent.json`, then run `occ agent update "$AGENT_ID" --file agent.json`.
Omitting `repositoryBindings` preserves the selection on update; an empty array
clears it.
Omitting `profile` resolves to `github-repository` only for the explicit policy
above. It does not widen an existing `git-write` grant. All selected repositories
must share the registry's App and installation and the same approved permissions.
The worker prepares a token restricted to exactly the selected numeric IDs.
Repository availability in the registry alone does not authorize an Agent.

Save the Agent with the selected repositories and the Gateway model source, provision its runtime credentials, and deploy. Wait for the selected revision to become ready. Clone and push the selected
repositories over HTTPS, for example `https://github.com/example/project.git`.
GitHub App permissions and normal GitHub branch rules still apply. OCE adds no
branch list for `github-repository`; it does not promise every administrative
operation. Access is finite by default. Change selections and deploy a new revision
to change access; do not rewrite a narrow grant into a broader one in place.

### Plan for request limits

Unmodified OpenShell 0.1.6 buffers complete requests. These are byte limits, not
repository or source-file size allowances:

| Request                                                  | Maximum                 |
| -------------------------------------------------------- | ----------------------- |
| Selected-repository REST JSON                            | 1 MiB (1,048,576 bytes) |
| GraphQL, installation-preview API, ref-scoped draft JSON | 64 KiB (65,536 bytes)   |
| Git fetch negotiation request                            | 1 MiB                   |
| Complete Git push request                                | 4 MiB (4,194,304 bytes) |

For Contents API writes, base64 expansion, JSON metadata and whitespace all count.
Use canonical repository paths: letters, digits, underscores, hyphens and dots in
resource segments; percent-escaped filenames are currently refused. Other shape,
permission and current-authority checks still apply, including draft field limits.

Use native Git for larger file payloads where available, but measure the complete
push: pack bytes, commands and framing must fit 4 MiB. HTTP chunking cannot bypass
the limit; chunk framing and trailers also consume the supplier's allowance.
Smaller pushes can help only when each complete request fits; they cannot split
an arbitrary large new object into admissible requests. Larger objects and uploads
need an approved separate workflow. Do not bypass the protected route or increase
its configured maximum beyond stock support. The authority deadline starts after
buffering; it is not an end-to-end upload deadline.
