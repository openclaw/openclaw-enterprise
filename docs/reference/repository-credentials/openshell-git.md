# Git and draft pull requests through OpenShell

The earlier broker-backed trial cannot start with this release. Stop new admissions and
drain accepted work on its original owner before updating the control plane. Preserve the
original owner’s database, registry, custody key and issuer access until it settles the
work. Do not transfer a receipt into new authority or replay an uncertain request.

A replacement requires a qualified protected sender. [Protected Git through Credential
Proxy](protected-openshell-git.md) describes its release requirements and configuration.
Release remains blocked until the actual sender and TLS path are qualified.

## Prerequisites

Check these before qualifying a protected release; each one can stop Git or the Agent:

- **Kernel.** The Driver requires Landlock (`hard_requirement`), and Sandboxes need
  Landlock ABI v3 or later, Linux 6.2 or newer. A node on an older kernel, such as
  the 5.15 kernel of Ubuntu 22.04, fails Sandbox startup.
- **Supervisor trust.** The OpenShell supervisor makes its own TLS connections to
  GitHub and the model endpoint, using its image's CA bundle. If a private CA or a
  TLS-inspecting proxy sits on either path, use a supervisor image that trusts that
  CA; otherwise the model probe times out and Git requests fail.
- **Unattended commands.** With
  `plugins.entries.codex.config.appServer.approvalPolicy: on-request` and no
  approver, Codex declines the shell commands it asks about, so Git never runs. For
  unattended qualification, select an approval policy appropriate for that environment.

## Prepare the request-phase service

For a qualified protected release, select Kubernetes Compute, the OpenShell Sandbox and
Credential Proxy from the same installed Driver, dedicated Codex, and the
[OpenShell Installation fragment](../../../deploy/examples/repository-credentials/openshell.fragment.yaml).
The GitHub Backend still requires its registry, and only the worker receives the GitHub App
key and dedicated custody key. Preserve that custody key across restarts. Never put either
key in Agent configuration or Helm values.

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
  mode: protected
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
The registration name must match `repository.openShell.registrationName`.
OCE attaches the selected binding to the sandbox policy with `on_error: fail_closed`
for `github.com` and `api.github.com`. Do not hand-author its binding identifier.
Those hosts, and every other name under `github.com` (such as `ssh.github.com`,
`codeload.github.com`, `gist.github.com`, `docs.github.com` and `*.pkg.github.com`),
come only from this route: if another Sandbox Driver network policy
(`policy.networkPolicies`, such as a `source-control` policy) also allows one, the
Installation refuses to start and names that policy. `ghcr.io` and
`githubusercontent.com` hosts are not covered. The Driver still needs at
least one policy, such as the model endpoint's. An Agent network grant for those
hosts on any port is refused the same way: saving it for an Agent with a repository
binding, adding the binding beside it, deploy and live application each fail with a
`409` that names the grant. IP-address hosts (IPv4, IPv6 or a range, private and
loopback included) may lead to GitHub, so both checks refuse them too; use DNS names,
such as a Service name. The checks compare names only: a DNS name that resolves to
GitHub (a wildcard-IP name or your own record) is not detected; do not add one.
Retain HTTPS, hostname verification and authenticated Gateway JWTs; do not enable
`allow_insecure_transport`. This policy attachment still has the stock enforcement
and origin-TLS limits stated above.

## Use the admitted repository

New work requires the qualified protected release and an explicit repository binding.
The GitHub App installation sets the permission ceiling; keep independent branch protection.
The draft limit belongs to the grant (repository, review branch and base). A one-draft
grant consumes its allowance at authorization, before OCE knows whether the sender sent the
request or GitHub created the draft. A lost push or draft response is an unknown outcome:
inspect the original operation and do not replay it. See [refusal reasons](openshell-git-refusals.md).

## Route state, restarts and recovery

The worker verifies each admitted Sandbox's Git route itself: the exact Sandbox,
its supervisor instance and the installed provider generation, re-read through the
Gateway every few seconds and on every request. A deployment waits as
`REPOSITORY_GIT_ROUTE_PENDING` until that route is verified. The prepared material
is issued only once the version is active and installs within a few seconds; an
active version that loses its material reports `REPOSITORY_GIT_ROUTE_PENDING`
again. A route the worker has closed for good (the Sandbox or its supervisor process
was replaced, a provider write's outcome is unknown, or access was withdrawn) fails
the deployment with `REPOSITORY_GIT_ROUTE_BLOCKED`; an active version in that
state keeps serving chat, but every Git request answers 403 until a new version
deploys, unless maintenance must retire the runtime.

At the admitted Git deadline, request authorization closes immediately. Maintenance
retires the issued credentials, fences the Git route, and conditionally removes only
its provider from the running Sandbox. This requires a separately attached model
credential and a launch witnessed by this release. The worker verifies that the
original supervisor and workload Pods, session and process report Git revoked and
that model provider ready in the same reduced configuration. A subsequent model
reply in the same conversation is the end-to-end check. If the detach reply is lost,
the worker verifies the current attachments without sending it again. If only the
Sandbox resource version changes before the request, the worker waits for a fresh
observation before sending. An unresolved observation stays pending.

Maintenance also checks that the remaining providers do not grant GitHub access. It
reads each profile in the scope its provider selects. In OpenShell, an empty profile
workspace selects the platform profile, even if the Workspace has a profile with the
same name. If the gateway denies that read or the profile overlaps GitHub, maintenance
keeps Git closed and retires the runtime. An unsafe identity change, loss of model
access or an explicit stop also retires the runtime.
A new grant requires a new revision.

Installing or removing the material resets the Sandbox's connections. OpenShell 0.1.4
(`5a7728c3`) folds every attached provider's record version into the Sandbox's
provider environment revision and answers a change with a policy runtime reload
that closes each connection out of the Sandbox: the workspace node's WebSocket to
the Gateway and any in-flight model stream included
(`crates/openshell-server/src/grpc/policy.rs`,
`crates/openshell-supervisor-network/src/opa.rs`). Activation therefore reports
`REPOSITORY_GIT_MATERIAL_PENDING` until the route verifies the first install,
`WORKSPACE_NODE_RECONNECT_PENDING` for about 2 s after it, then
`WORKSPACE_NODE_PENDING` until the Gateway reports the node connected again, so
the deployment succeeds only once the node is back. Stated limit: each later
renewal (about every 50 minutes: tokens live an hour and the worker renews ten
minutes early) repeats the reset. Chat answers 500 for about 1-7 s while the node
reconnects, and other open tunnels close with it; the request can be retried.
Scoping the reset to the changed provider is OpenShell's to do and is being taken
upstream.

After a Gateway or worker restart, Git stays closed until the worker verifies
the same Sandbox, provider generation, supervisor process and network instance.
A new Gateway control session is expected. On its first maintenance pass the
worker reads identity and custody (never a token) from
`occ.credential_deliveries`, verifies the installation, then reads the prepared
material. This usually takes less than a minute. A failed read retries with
bounded backoff; it does not repeat a write.

A replaced installation, an uncertain provider write, withdrawal or a Sandbox
predating the route record requires a new revision. The Agent stays active.
[Route recovery](openshell-git-restarts.md) explains adoption, worker fencing
and the OpenShell 0.1.4 limit. Look for `OPENSHELL_GIT_RECONCILIATION_REQUIRED`,
`worker.openshell-git-route-warning` or `worker.openshell-git-route`. Each refusal
logs `worker.openshell-git-denied` with a [reason](openshell-git-refusals.md).

## GitHub App key rotated or revoked

If GitHub rejects the App key, the active Agent keeps its status and chat still
works. Already issued material can remain usable until expiry. Once it expires,
all Git requests, including reads, return 403. A new deployment waits at
`REPOSITORY_GIT_MATERIAL_PENDING` and fails at its convergence deadline. Neither
status currently identifies the rejected key.

Alert on the worker's `PREPARED_GITHUB_RECOVERY_REQUIRED` (reason `quarantined`,
then `blocked`, with Namespace, revision and `repositoryRef`). Expect roughly
one event per minute per binding. Readiness reports `REPOSITORY_GIT_ROUTE_PENDING`;
the first refusal logs `worker.openshell-git-route-warning` and each refusal logs
`worker.openshell-git-denied`, both with `material_unavailable`. These may follow
the recovery warning by up to about ten minutes.

Recovery: put a key GitHub accepts in the `private-key.pem` entry of the Secret
named by `repositoryCredentials.appKeySecretName` (the worker re-reads the mounted
file on each pass; a Secret update reaches the mount within about a minute), then
deploy a new version of each affected Agent. The quarantined
preparation never issues again, so restoring the key alone does not reopen the
old version's route. Material is still issued only to an Agent's active version,
so an operator's test of the restored key is that new version's first `git fetch`.
