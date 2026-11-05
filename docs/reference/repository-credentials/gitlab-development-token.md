---
created: 2026-11-04
updated: 2026-11-05
---

# GitLab development token authority

The installed GitLab authority is development-only. It serves a fixed
`https://gitlab.com` origin with an operator-supplied project access token. The
token is projected only into the repository credential service; the worker,
API, and Agent Pods do not receive it. Registry entries bind one numeric
GitLab project and canonical path to exact OCC Namespace IDs, profiles, and
push-ref allowlists.

Select `repositoryCredentials.authority: "gitlab-token-development"` in Helm.
The chart mounts `config.json`, the serving TLS pair, and the token from
operator-owned Secrets. The immutable registry remains a ConfigMap. Installation
composition selects the GitLab Repo Backend with `repository.nativeSender` and
does not require `repository.preparedGitHub`.

The service configuration must use `backend.kind: "gitlab-token"` with
`developmentOnly: true`, the Backend ID, numeric `projectId`, canonical `project`,
exact `namespaceId`, protected `tokenFile`, mounted `registryFile`, and a push-ref
allowlist. An empty allowlist denies every push. The fixed origin cannot be changed
by configuration. Startup reports only the nonsecret authority and token class.

Before each upstream send, the service rereads the mounted registry and compares
it with the grant admitted for the open session. If the Namespace, project,
profile, or ref policy no longer admits that grant, the exchange fails closed
with `503 unavailable` before upstream I/O.
Startup reports only the nonsecret authority and token class.

This milestone does not provide OpenShell protected delivery, durable
provider-operation receipts, or a production token authority. Reassigning or
withdrawing registry access blocks new admission and the next send from an open
session. Verify the supported lifecycle with the
[installed GitLab lane](../../testing/repository-credentials.md#installed-gitlab-agent-lane).
