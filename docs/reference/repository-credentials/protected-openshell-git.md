# Protected repository access with OpenShell

**Stock OpenShell 0.1.5 is not qualified for protected access.** Registered
middleware, a loaded policy and a successful rollout do not prove mandatory
per-request authorization or an identity that cannot be reused. Qualify the exact
sender and TLS path before enrolling credentials. See the
[release requirements](../../../specs/rfcs/0023-egress-proxy-credential-lifecycle/online-authorization.md)
and [Driver delivery profiles](../drivers/credential-proxy.md#delivery-profiles).
OCC's v7 support is for a capable exact-dispatch Driver with verified reduction;
it does not qualify this stock adapter or upgrade its v5/v6 guarantees.

The bundled OpenShell Driver therefore refuses `git-write` delivery: deploy returns
`409 REPOSITORY_GIT_SENDER_UNQUALIFIED` and creates no revision, and a revision
admitted before this check fails with the same code instead of waiting for the
convergence deadline. Use [native prepared Git](prepared-native-git.md) or a separately
installed sender qualified for the profile, or remove the binding.

For an existing installation, first follow the
[compatibility upgrade](../../guides/deploy/credential-proxy-upgrade.md#check-compatibility-before-interrupting-access).
You can retain current selections and unprotected admissions. Keep Credential
Gateway while using the bundled OpenShell Backend, even with no sources.

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

## Configuration for a qualified release

<a id="install-without-the-repository-broker"></a>

Select Kubernetes Compute, dedicated Codex, and Sandbox and Credential Proxy
from the same Driver registration. Use the
[OpenShell Installation fragment](../../../deploy/examples/repository-credentials/openshell.fragment.yaml).
Keep `repository.preparedGitHub`, `repository.openShell`, the session duration,
and the GitHub Backend registry at `/etc/openclaw/repository-registry/registry.json`.
Omit `controlSocket`, `publicCaPath`, and `repository.nativeSender`.

Set Helm `openshellGit.enabled: true`, `openshellGit.mode: protected`,
`repositoryCredentials.enabled: false`, and
`repositoryCredentials.authority: prepared-git`. The `repositoryCredentials`
inputs select the registry ConfigMap, worker-only App-key and existing custody
Secrets, and approved issuer CIDRs. Preserve the custody key across restarts;
never put either key in Agent configuration or Helm values.

## Prepare the request-phase service

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

The adapter uses static operator middleware configuration. Add the following entry
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
`allow_insecure_transport`. This attachment alone does not establish qualified enforcement.

## Grant access to a GitHub App installation

Use the [GitHub App setup](../../guides/repository-credentials/team-runbook.md#register-and-install-the-github-app)
for membership and permissions, and the
[registry reference](../repository-credentials.md#canonical-platform-registry)
for policy fields. Keep repository scope when it is sufficient. To expose an
installation scope, set a distinct `installationAccess.repositoryRef`, allow the
Namespace with `accessMode: installation`, and select that reference with
`profile: github-installation` in the Agent's `repositoryBindings`.
No default profile or wildcard selects this scope. The installed sender must
positively confirm `github_installation` support.

OCE does not add a ref allowlist to installation scope. GitHub's membership,
permissions and branch rules set its limit. See
[operator verification and withdrawal](../../guides/credential-proxy.md#verify-use-loss-and-withdrawal)
for profile-specific allowed/denied requests and the required model-source choice.

## Use the admitted repository

[OCC access rules](../../flows/agent-repository-credentials.md) own grant lifetime
and standing approval. Access is finite unless separately approved as standing;
each token and session still expires. Remove standing approval with its current
approval generation **before** clearing the repository binding. An already
authorized request can finish after withdrawal.

A repository-scoped one-draft grant spends its allowance at authorization, before
OCE knows whether GitHub created a draft. On an uncertain push or draft outcome,
inspect the original remote ref or PR and retained operation; do not replay it.
See [Credential Proxy uncertainty](../drivers/credential-proxy.md#cancellation-retries-and-uncertainty).

## Diagnose a refused request

Git does not print the body of a JSON error response. When OpenShell refuses the
first request of a clone, fetch, `ls-remote` or push, Git shows only
`The requested URL returned error: 403` (exit 128). When it refuses only the
push's upload, usually `request_not_allowed` for another branch or tag, Git
shows `error: RPC failed; HTTP 403`, then
`fatal: the remote end hung up unexpectedly`, and may end with
`Everything up-to-date` (exit 1). That last line does not mean there was nothing
to push: the push never reached GitHub.

Only after a known pre-send refusal, diagnose with a fresh read using Git's HTTP
trace, which redacts the authorization header. Never rerun an uncertain write. The trace splits the body across lines, so join them first:

```bash
GIT_TRACE_CURL=1 git ls-remote origin 2>&1 | sed -n 's/.*<= Recv data: //p' \
  | tr -d '\n' | grep -o '"reason_code":"[a-z_]*"'
```

The draft helper prints the code and the matching advice itself, for example
`Draft not created: the repository route refused it (access_withdrawn); GitHub did not receive it.`

### Reason codes

| Code                          | Meaning                                                                                                                      | What to do                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `request_not_allowed`         | The selected profile does not admit the request; repository-scoped limits include ref, repository and draft constraints      | Do not retry. Change the request or ask an operator                                |
| `draft_already_opened`        | The grant's one-draft allowance was consumed; creation may be uncertain                                                      | Inspect GitHub without replay; see the [draft limit](#use-the-admitted-repository) |
| `access_withdrawn`            | This version's repository access ended: the binding was removed, the version was replaced or stopped, or its session expired | Do not retry. An operator binds and deploys                                        |
| `credential_unavailable`      | The route lost its credential, for example because GitHub rejected the App key or a renewal failed                           | An operator checks the worker log; a rejected key needs a new deploy               |
| `route_blocked`               | The worker closed this version's route for good, for example after the Sandbox was replaced                                  | An operator deploys a new version                                                  |
| `route_not_ready`             | The route is starting, verifying or briefly unavailable                                                                      | Retry in a minute                                                                  |
| `online_authorization_denied` | The worker did not answer in time, or could not match the request to one of its routes                                       | Retry once, then ask an operator                                                   |

Retry advice above applies only to a known pre-send refusal, never an uncertain send.

A version that is still deploying has no credential yet, so its requests answer
`route_not_ready` until it is active.

### Worker log

Each refused request logs one `worker.openshell-git-denied` line. Its `reasonCode`
is the code above, and its `reason` is the worker's detailed cause, such as
`ref_not_allowed`, `draft_rejected`, `session_closed`, `material_unavailable`,
`installation_changed` or `route_blocked`. The line also carries the Sandbox ID and
the request ID that the supervisor's own log shows. The
`worker.openshell-git-route-warning` line for a lost credential carries the same
`reasonCode`, so an alert can tell a removed binding (`access_withdrawn`) from a
rejected App key (`credential_unavailable`).

## Route state, restarts and recovery

`REPOSITORY_GIT_ROUTE_PENDING` means the worker has not verified the current
Sandbox, supervisor and provider generation, or material is unavailable.
`REPOSITORY_GIT_ROUTE_BLOCKED` closes Git until a new revision; continued chat
requires independent model access and verified Git-only removal. Unsafe identity
changes, overlapping GitHub access from retained providers or failed observation
can require runtime retirement instead. An empty OpenShell profile workspace
selects the platform profile, not a same-named Workspace profile.

A failed read closes the route until the same installation verifies, with retry
backoff from 1 s to 10 s. After restart, the worker reads durable delivery facts,
re-observes the installation and reads eligible prepared material. It does not
replay an uncertain provider write. Generic fences and pending-write rules are
in [Credential Proxy lifecycle](../drivers/credential-proxy.md#cancellation-retries-and-uncertainty).
Prepared-material expiry, quarantine and retirement belong to
[Token Service lifecycle](../repository-credentials.md#token-service-lifecycle) and
its [source flow](../../flows/credential-source-refresh.md#6-oce-prepared-github-core).

Inspect `OPENSHELL_GIT_RECONCILIATION_REQUIRED` and its `reason`:
`execution_replaced`, `supervisor_replaced`, `write_unknown`, `worker_restarted`
or `gateway_unauthorized`. `worker.openshell-git-route-warning` distinguishes
`unobserved` reads, `closed` worker replacement and `pending` material.
`worker.openshell-git-route` reports adoption and restoration, with `durationMs`.
Correlate the revision and request ID with `worker.openshell-git-denied`.

### Qualification history

OpenShell 0.1.4 (`5a7728c3`) reported supervisor process and network identities
without Gateway attestation; the Gateway authenticated only the Sandbox
principal. Reconnect continuity therefore relied on the supervisor's claims.
This observation does not qualify a newer candidate's identity.

That version also reset all Sandbox connections on provider material changes,
including the workspace WebSocket and model streams. Activation passed through
`REPOSITORY_GIT_MATERIAL_PENDING`, `WORKSPACE_NODE_RECONNECT_PENDING`, and
`WORKSPACE_NODE_PENDING`. Later renewals repeated the reset (observed chat outages
of about 1–7 s). Qualify connection continuity on the selected release; inspect
uncertain request outcomes before retrying.

## GitHub App key rotated or revoked

See [replace a rejected App key](../../guides/repository-credentials/team-runbook.md#replace-a-rejected-app-key).
A ready Agent is not evidence of usable Git material. A rejected key can leave
already issued material usable until expiry, then close requests.

## Move from the earlier trial

Use [stop and settle](../../guides/deploy/credential-proxy-upgrade.md#stop-and-settle-before-upgrading)
before changing the old owner. New startup rejects the broker trial. Keep
[explicit native Git](prepared-native-git.md) separate from protected delivery.

Earlier documentation URLs remain as anchor bridges:
[setup](openshell-git.md), [refusals](openshell-git-refusals.md), and
[restarts](openshell-git-restarts.md).
