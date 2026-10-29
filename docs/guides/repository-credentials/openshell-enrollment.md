# Enroll repository collaboration with OpenShell

Use the existing Installation YAML and Helm values for protected delivery.
The production profile renderer's repository option selects the native sender;
it does not select OpenShell. Do not enable that option for this procedure.
Follow the production guide's [manual configuration path](../deploy/production-installation.md#advanced-copy-manual-yaml-examples)
and preserve its Compute, IAM, Secret, Configuration, image and routing settings.

This prepares the composition, not release qualification. Stock OpenShell is not
qualified for enforced protected Git. A valid configuration or healthy rollout
is not evidence of enforcement. Read the [protected OpenShell requirements](../../reference/repository-credentials/protected-openshell-git.md)
before enrolling credentials. The sample leaves observed-hook preview off;
do not turn it on to work around a refused profile.

## Prepare the installation

1. Configure the [OpenShell Backend, Sandbox and Credential Gateway](../../reference/drivers/openshell-credential-gateway.md#configure-the-driver)
   with Kubernetes Compute and dedicated Codex. Use the actual executable paths
   in the pinned runtime image and the existing Sandbox policies. Keep the
   Backend administrator mTLS material in its own Secret. Its `ca.crt`, `tls.crt`
   and `tls.key` are mounted at `/etc/openclaw/openshell` by Helm
   `backend.openshell.clientSecretName`.
2. Bootstrap the platform and create the real platform Namespace. With Credential
   Gateway selected and Credential Proxy still absent, enroll the Namespace's
   model source through the ordinary credential-source workflow. Verify that it
   is ready and has **no `egress`**. Select it with
   `harnessAuth.method: credential_source` and retain the exact Agent-principal
   authorization. See [model-source topology](../credential-proxy.md#enroll-prepared-github-access).
   A new static source registered after the Git-only Proxy is selected takes the
   wrong topology and is refused. If a suitable source cannot be prepared, stop;
   substituting a model Secret does not satisfy this composition.
3. Append the GitHub Backend in the [Installation fragment](../../../deploy/examples/repository-credentials/openshell.fragment.yaml).
   Preserve the existing OpenShell Backend and add its `credential_proxy` member,
   with the **same ID as the selected Sandbox**, to match
   `drivers.credential_proxy.id`. Merge the fragment's `repository` settings and
   Proxy selection. Do not replace the whole Backend list or Drivers map.
   Remove any `repository.nativeSender` and Compute
   `network.repositoryCredentials`; they belong to the native composition.
4. Apply the [OpenShell values overlay](../../../deploy/examples/repository-credentials/openshell.values.yaml)
   to the site-specific production values. Replace its example names, issuer
   `/32`, and Gateway/supervisor selectors with reviewed deployment inputs.
   Keep the immutable registry ConfigMap separate from the worker-only App-key
   and custody Secrets. Keep the existing custody key stable across restarts.
   Prepare the serving certificate and Gateway public key, and configure the
   middleware, using the [request-phase service procedure](../../reference/repository-credentials/protected-openshell-git.md#prepare-the-request-phase-service).
   The Gateway signing private key never belongs in OCE's public-key ConfigMap.
5. Register the repository and Namespace policy below, then validate the complete Installation and render the chart with the pinned
   controller version before applying it. Match the authority's host, port and
   mounted paths to `openshellGit`; retain `repositoryCredentials.enabled: false`.
   Start the request-phase worker before the Gateway's authenticated middleware
   discovery. Do not interpret successful configuration validation as permission
   to enroll an unsupported repository profile.

## Register one repository and its Namespace policy

Copy the [OpenShell registry example](../../../deploy/examples/repository-credentials/openshell.registry.json)
to the immutable registry ConfigMap named by the values overlay. Replace its
App ID, installation ID, provider instance, repository ID/name and Namespace ID
with your actual inputs. `repositoryId` is the stable numeric GitHub repository
ID encoded as a string; the repository name alone does not select authority.
Use the actual platform Namespace ID, not its Kubernetes namespace name.

The Namespace entry explicitly selects `profiles: ["github-repository"]` and
contains the exact approved repository-only App `permissions` map. The example's
four permissions are illustrative, not a default: replace the entire map with
the reviewed permissions for your App. OCE neither adds permissions nor copies
organization, account or installation-wide rights. Unknown permission names are
refused. `metadata: read` is required. Do not add `transport`, `pushRefAllowlist`,
`pullRequestBase` or `draftPullLimit` to this policy.

The worker requests an installation token restricted to this one repository and
checks the returned repository and permissions before use. GitHub's permissions,
branch protections and rulesets still apply. Another repository installed on the
same App is not implicitly granted. Changing the repository or permissions
changes the grant identity and requires fresh admission.

## Select the Agent and assurance mode

Complete the [ordinary Gateway source enrollment and Agent authorization](../deploy/openshell-credential-sources.md#create-the-agent-and-grant-the-source).
Create the Agent with its real Configuration ID and the ready source from the
first stage. Add these fields to the normal dedicated Codex Agent request:

```json
{
  "executionMode": "dedicated",
  "harnessAuth": { "method": "credential_source", "sourceId": "cs_replace" },
  "credentialSources": [{ "sourceId": "cs_replace" }],
  "repositoryBindings": [{ "repositoryRef": "application", "profile": "github-repository" }]
}
```

Replace both source IDs with the same authorized source. The source must remain
listed in `credentialSources`. Select exactly one repository binding. Omitting
`profile` still selects the existing `git-write` behavior, not collaboration.
Do not substitute `git-full` or `github-installation`, and do not put permissions
or a token in the Agent request. The latter profile intentionally requests the
whole installation's inherited scope.

The default development OpenShell release is pinned to 0.1.5, including its
Gateway, Sandbox and supervisor images. Selecting candidate images is a separate
explicit development override and does not qualify the stock release.

The sample leaves observed-hook preview off. To deliberately select the stock
OpenShell 0.1.5 **observed preview**, an operator must set
`drivers.credential_proxy.configuration.observedHookPreviewWorkspace` to the
actual dedicated, operator-controlled OpenShell Workspace name. Keep Backend mTLS
and the middleware's `timeout = "5s"`. Discovery must explicitly confirm the
`github_repository` delivery profile with `request-hook-observed`; a missing
confirmation is a refusal. This observation does not prove the hook cannot be
disabled or that withdrawal is mandatorily enforced. It is not production
qualification. For enforced delivery, select a separately qualified sender;
do not treat the preview setting as an enforcement switch.

Use normal Agent creation and deployment after authorization. Inspect deployment
status until it reports success; a saved Agent or active revision ID alone is
insufficient. Verify a model reply and independently read back an approved test
branch after a normal `git push`. Test denial of an ungranted private repository
through Git, REST and GraphQL. Check renewal, loss and withdrawal for the selected
assurance mode. Do not retry a write with an unknown outcome before checking
remote state. Configuration validation alone proves none of those runtime results.
