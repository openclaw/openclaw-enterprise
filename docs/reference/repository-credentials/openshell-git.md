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

## Prerequisites

Check these before the trial; each one stops Git or the Agent:

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
  an unattended trial, set it to `never`, which removes the approval step.
- **PATH.** Draft creation needs the helper on PATH; see the login-shell note below.

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

Enroll one repository and exact writable branch in the registry and bind it to
the Agent. For draft creation select `transport: git-and-draft-pr` and an explicit
`pullRequestBase`, such as `main`; Git-only grants do not enable draft creation.
The App installation needs the corresponding repository contents and pull request
permissions. GitHub permissions themselves are broader than the middleware's
branch and draft checks; keep independent GitHub branch protection.

The Agent may force-push or delete its own review branch; OCE admits both.
Deleting it closes its draft. To stop either, protect the branch on GitHub.

[Codex OAuth](../../testing/openshell-oauth.md) does not grant Git access. OpenShell Git
binds a live revision to its installed credential and authorizes each request; other
sandbox repository bindings remain refused.

From the admitted Agent shell, use ordinary GitHub URLs. OpenShell strips proxy
variables and routes the sandbox's connections itself. Replace the repository and
branch below with the enrolled values:

```bash
git clone https://github.com/example-org/example-repo.git
cd example-repo
git switch -c review/agent-change origin/main
# Make and commit the requested change.
git push origin HEAD:refs/heads/review/agent-change
oce-github pr-create --draft --head review/agent-change --base main \
  --title 'Review the proposed change' --body 'Describe the change and validation.'
```

With `git-and-draft-pr`, the Sandbox can read the image's repository client and
its PATH ends with `/opt/oce/repository-credentials/bin`. If a login shell resets
PATH, call `/opt/oce/repository-credentials/bin/oce-github`. Like Git, the helper
sends its one draft-create request to `api.github.com` and OpenShell routes it
through the middleware; the helper ignores proxy variables. It accepts explicit `--body` text, not `--body-file`, and
records a local attempt ID before sending. A local ID does not make GitHub
creation idempotent. If a push or draft-create response is lost, inspect GitHub
for the commit or draft before any new attempt. Do not retry another way. A
refused request answers 403 with a [reason code](openshell-git-refusals.md).

The draft limit belongs to the grant (repository, review branch and base): every
Agent version bound to it shares one draft, and closing or merging the draft does
not reset it. A second create is refused before GitHub, and the helper says the
binding already opened its draft. OCE never sees GitHub's reply here, so it records
no pull request number. For another draft, enroll and bind a new review branch; a
redeploy or rebind does not reset it.

Known limit, with an opt-out: to trust the Agent, set `draftPullLimit: "none"`
beside `pullRequestBase` in the registry's namespace policy and redeploy (it changes
the grant). Creates are then unlimited but still draft-only, review branch to base.
OCE keeps the first create's receipt; the supervisor's OpenShell HTTP log records
later ones. The broker route keeps one per grant.

During the accepted trial, use an authorized test repository to verify clone,
pull of an independently known commit, push to the allowed branch, and draft
creation from the same admitted Agent. Independently
read back the pushed SHA and draft. In a disposable repository, verify refusal of
another repository, another writable branch and a non-draft create. Remove the
Agent repository binding, confirm a fresh fetch is denied, and confirm ordinary
chat still works. Withdrawal cannot erase an existing clone or recall a sent push.
These checks do not prove that every sandbox must use the middleware or that the
connection from OpenShell to GitHub uses verified TLS.

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

Neither a Gateway restart nor a worker restart requires a new version. A read the
worker cannot complete only closes the route until the same installation verifies
again (bounded backoff, nothing rewritten or replayed). A replaced Gateway Pod
gives each supervisor a new control session, adopted only when the verified
observation is the same installation (Sandbox, provider generation, supervisor
process and network instance IDs); a worker restart re-adopts each route from its
PostgreSQL record (`occ.openshell_git_routes`: identity and custody facts, never a
token) on the first maintenance pass, after the same full verification, and reads
the material again from prepared custody instead of replaying it. Git requests are
denied from the restart until that first verified read, typically well under a
minute. A route that does not verify, a provider write of unknown outcome, a
withdrawn route and a Sandbox prepared by a release before the record existed are
closed for good: the Agent stays active and needs a new version.
[OpenShell Git route restarts](openshell-git-restarts.md) has the exact adoption
rules, the multi-worker fence, the stated OpenShell 0.1.4 limit and the worker log
vocabulary (`worker.error` with `OPENSHELL_GIT_RECONCILIATION_REQUIRED`,
`worker.openshell-git-route-warning`, `worker.openshell-git-route`); each refused
request logs one `worker.openshell-git-denied` line with a
[reason code](openshell-git-refusals.md).

## GitHub App key rotated or revoked

Known gap: when GitHub rejects the App's private key (rotated at GitHub without
updating the Secret, or revoked), nothing in Agent status or deployment status
says so. The active version keeps its status, chat works, and every Git request
from its Sandbox (reads included) answers 403. A new version's material is
requested only after it activates, so its deployment waits as
`REPOSITORY_GIT_MATERIAL_PENDING` (the status points at the worker log) and fails
at the convergence deadline; it does not report success with Git denied. Naming
the cause in deployment status is a planned follow-up.

Detection is in the worker log. Preparation for the active version is
quarantined, and maintenance logs `worker.error` with
`PREPARED_GITHUB_RECOVERY_REQUIRED` about once a minute per binding:
`reason: quarantined` (`blocked` once a later pass finds the quarantined attempt),
the Namespace, revision and `repositoryRef`. The version's route then reports
`REPOSITORY_GIT_ROUTE_PENDING` to Compute readiness, each refused request logs
`worker.openshell-git-denied` with `reason: material_unavailable`, and the first of
them logs one `worker.openshell-git-route-warning` with
`reason: material_unavailable`. Alert on the recovery-required and warning lines.
If the key was rotated at GitHub but the Secret still holds the old one, the
material already issued stays usable until it expires, so the route lines can lag
the recovery-required line by up to about ten minutes.

Recovery: put a key GitHub accepts in the `private-key.pem` entry of the Secret
named by `repositoryCredentials.appKeySecretName` (the worker re-reads the mounted
file on each pass; a Secret update reaches the mount within about a minute), then
deploy a new version of each affected Agent. The quarantined
preparation never issues again, so restoring the key alone does not reopen the
old version's route. Material is still issued only to an Agent's active version,
so an operator's test of the restored key is that new version's first `git fetch`.
