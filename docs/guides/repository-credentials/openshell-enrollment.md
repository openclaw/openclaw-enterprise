# Enroll repositories for OpenShell Agents

This Helm walkthrough covers repository access with matching OpenShell **0.1.6**
components. Check the [OpenShell qualification contract](../../reference/drivers/openshell-sandbox.md#qualification-contract)
before planning a production rollout. Runtime admission checks the required facilities and policy proof.
The [local setup guide](../deploy/local-openshell-images.md) lists component versions. Select Kubernetes
Compute, dedicated Codex, and the same OpenShell Driver for Sandbox and
Credential Proxy. Repository access requires its own explicit Namespace policy;
installing OpenShell does not grant it.

### Register the Harness model source first

A fresh installation needs a ready, Gateway-owned model source before enabling
the repository Credential Proxy. If that source already exists, start at step 2.

1. Select the OpenShell Gateway and Sandbox. Leave `drivers.credential_proxy`
   and the Backend’s `drivers.credential_proxy` unset. [Register the model source](../deploy/openshell-credential-sources.md)
   and verify that its state and Gateway status are ready and that it has no `egress`.
2. Keep the Gateway selected and use that same source with
   `harnessAuth.method: credential_source`. Enable the repository Credential Proxy
   as described below. This procedure is for a fresh installation; changing an
   existing installation can affect running Agents.

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
