# Enroll repositories for OpenShell Agents

For fresh repository-enabled installations, use the production Installation and
Helm procedure below with matching OpenShell **0.1.6** components. Packaging pins
this release; runtime admission checks the required facilities and policy proof,
not the release label. The
[local setup guide](../deploy/local-openshell-images.md) also lists component versions. Select Kubernetes
Compute, dedicated Codex, and the same OpenShell Driver for Sandbox and
Credential Proxy. Repository access requires its own explicit Namespace policy;
installing OpenShell does not grant it.

Choose model authentication first. Use a ready Gateway Harness source without
`egress`, named by `harnessAuth.method: credential_source`. Provision that source
through the supported Gateway-only configuration before selecting the repository
Credential Proxy if necessary. Keep the Gateway selected after enabling the Proxy.
A fresh Proxy-owned static model source cannot replace this Harness source.
See [model source setup](../deploy/openshell-credential-sources.md).

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
operator-managed worker-only Secrets, and `upstreamCidrs` to the approved provider
endpoints. Preserve the custody key across restarts. Never put keys in Agent JSON.

Complete [the request-phase service setup](../../reference/repository-credentials/protected-openshell-git.md#prepare-the-request-phase-service):
set `openshellGit.enabled: true`, `mode: protected`, its TLS Secret, public issuer
key ConfigMap and trusted Gateway/supervisor clients. Match the fragment's port
8445, issuer, audience and key ID to the actual Gateway. Register `oce-prepared-git`
with `binding_policy: allowlist` and `bindings: [http_request_pre_credentials]`.
Missing or response-only bindings are not sufficient. Render the normal Helm
release and run normal Installation startup validation before admitting Agents.

### Select repositories and deploy

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

Save, provision runtime credentials and deploy using the normal Agent [Agent workflow](../credential-proxy.md#register-authorize-and-deploy-an-openai-static-inference-source). Wait for the selected revision to become ready. Clone and push the selected
repositories over HTTPS, for example `https://github.com/example/project.git`.
GitHub App permissions and normal GitHub branch rules still apply. OCE adds no
branch list for `github-repository`; it does not promise every administrative
operation. Access is finite by default. Change selections and deploy a new revision
to change access; do not rewrite a narrow grant into a broader one in place.
