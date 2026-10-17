# Git and draft pull requests through OpenShell

This opt-in, pre-release integration lets a dedicated Codex Agent use native Git
and create a draft pull request through stock OpenShell 0.1.4. The OCE worker
holds the GitHub App signing key and prepared credential custody key. OpenShell
calls the worker's authenticated request-phase middleware for the admitted
repository binding before forwarding a GitHub request.

**Use this only for an explicitly accepted pre-release trial.** Stock OpenShell
cannot require this middleware on every sandbox, and its middleware request does
not independently prove TLS to the GitHub origin. Registering the service does
not close either gap. This is not a general hardened credential-isolation claim.
Qualify your actual deployment before admitting a real repository credential;
chart renders and source tests do not establish an AWS deployment result.

## Prepare the installation

Start with the [repository installation inputs](../../guides/repository-credentials/installation.md)
and [prepared Git policy](prepared-native-git.md). Select Kubernetes Compute,
the OpenShell Sandbox Driver and dedicated Codex. Keep the ordinary OpenShell
inference configuration for Codex; this integration adds repository access.
Select `repositoryCredentials.authority: prepared-git` in Helm and merge
[`openshell.fragment.yaml`](../../../deploy/examples/repository-credentials/openshell.fragment.yaml)
into the Installation. Do not select `credential_proxy`, `egressAuthority`, or
the separate metadata-read `preparedGitHub` Helm settings for this route.

The existing repository inputs still supply the registry, broker image and
configuration, public CA, GitHub App key and dedicated 32-byte custody key.
`repositoryCredentials.preparedCustodySecretName` supplies `custody.key`, and
`repositoryCredentials.appKeySecretName` supplies `private-key.pem`; only the worker
mounts these under `/etc/openclaw/prepared-repository`. Preserve the custody key
across restarts. Never put these keys in Agent configuration or Helm values.

Prepare a separate serving certificate whose DNS SAN covers
`openclaw-enterprise-openshell-git.openclaw-system.svc`, its private key, and the
**public** PEM key from the selected OpenShell Gateway JWT signing bundle.
Create these resources in the OCE namespace with your approved Kubernetes context:

```bash
kubectl --context "$CONTEXT" -n openclaw-system create secret tls openshell-git-tls \
  --cert=/secure/occ/openshell-git/tls.crt \
  --key=/secure/occ/openshell-git/tls.key
kubectl --context "$CONTEXT" -n openclaw-system create configmap openshell-gateway-public \
  --from-file=gateway-public.pem=/secure/occ/openshell-git/gateway-public.pem
```

Add this to the existing production values. Replace the example namespace and Pod
labels with observed labels for your Gateway and trusted supervisors; both call
the middleware. Do not select Agent workload Pods as trusted callers.

```yaml
openshellGit:
  enabled: true
  port: 8445
  tlsSecretName: openshell-git-tls
  issuerPublicKeyConfigMapName: openshell-gateway-public
  clients:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: openshell-system
      podSelector:
        matchLabels:
          app: openshell-gateway
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: openshell-system
      podSelector:
        matchLabels:
          app: openshell-supervisor
```

The chart exposes a ClusterIP Service on port 8445 and allows that port only from
these peers under the chart's default-deny policy. It mounts the serving key,
certificate and public issuer key at the fragment's `/etc/openclaw/openshell-git`
paths in the worker. The API, initialization Job and repository sidecar do not
receive this projection. Keep the worker port equal in Helm and the Installation.
If the OpenShell namespace enforces egress, also permit its Gateway and supervisors
to reach this Service's selected worker Pods on TCP 8445 and resolve cluster DNS.

Set `authority.issuer` to `openshell-gateway:<gateway_id>` from the actual Gateway
JWT configuration, `keyId` to the contents of its `kid_path`, and `audience` to the
registration audience below. The fragment's values are examples, not discovery.
The Gateway's signing private key stays with the Gateway. Render and inspect the
combined production values, then use your normal Helm upgrade procedure.

## Register the request-phase service

Stock OpenShell 0.1.4 uses static operator configuration. Add the following entry
to the Gateway configuration, using the certificate's exact Service DNS name.
Mount the serving CA's public certificate at `tls_ca_cert_path` on the Gateway.
Its existing `[openshell.gateway.gateway_jwt]` must be configured with signing key,
public key, key ID and gateway ID matching the OCE verifier settings.

```toml
[[openshell.supervisor.middleware]]
name = "oce-prepared-git"
grpc_endpoint = "https://openclaw-enterprise-openshell-git.openclaw-system.svc:8445"
tls_ca_cert_path = "/etc/openshell/certs/oce-git-ca.pem"
audience = "oce-prepared-git"
max_payload_bytes = 4194304
timeout = "3s"
```

Start the configured OCE worker before restarting the Gateway: Gateway startup
calls authenticated `Describe` and refuses an unavailable or incompatible service.
OCE advertises the request-phase binding; policy admission calls `ValidateConfig`.
The registration name must match `drivers.repo.openShell.registrationName`.
OCE attaches the selected binding to the sandbox policy with `on_error: fail_closed`
for `github.com` and `api.github.com`. Do not hand-author its binding identifier.
Retain HTTPS, hostname verification and authenticated Gateway JWTs; do not enable
`allow_insecure_transport`. This policy attachment still has the stock enforcement
and origin-TLS limits stated above.

## Use the admitted repository

Enroll one repository and exact writable branch in the registry and bind it to
the Agent. For draft creation select `transport: git-and-draft-pr` and an explicit
`pullRequestBase`, such as `main`; Git-only grants do not enable draft creation.
The App installation needs the corresponding repository contents and pull request
permissions. GitHub permissions themselves are broader than the middleware's
branch and draft checks; keep independent GitHub branch protection.

From the admitted Agent shell, use its managed proxy environment and ordinary
GitHub URLs. Replace the repository and branch below with the enrolled values:

```bash
git clone https://github.com/example-org/example-repo.git
cd example-repo
git switch -c review/agent-change origin/main
# Make and commit the requested change.
git push origin HEAD:refs/heads/review/agent-change
oce-github pr-create --draft --head review/agent-change --base main \
  --title 'Review the proposed change' --body 'Describe the change and validation.'
```

The helper sends one draft-create request through the selected OpenShell proxy.
It accepts explicit `--body` text, not `--body-file`, and records a local attempt
ID before sending. A local ID does not make GitHub creation idempotent. If a push
or draft-create response is lost, inspect GitHub for the commit or draft before
any new attempt. Do not bypass the proxy or retry directly.

During the accepted trial, use an authorized test repository to verify clone,
pull of an independently known commit, push to the allowed branch, and draft
creation from the same admitted Agent. Independently
read back the pushed SHA and draft. In a disposable repository, verify refusal of
another repository, another writable branch and a non-draft create. Remove the
Agent repository binding, confirm a fresh fetch is denied, and confirm ordinary
chat still works. Withdrawal cannot erase an existing clone or recall a sent push.
These checks do not prove that every sandbox must use the middleware or that the
connection from OpenShell to GitHub uses verified TLS.
