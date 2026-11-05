---
created: 2026-11-04
updated: 2026-11-04
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
`developmentOnly: true`, the numeric `projectId`, canonical `project`, exact
`namespaceId`, protected `tokenFile`, and a push-ref allowlist. An empty
allowlist denies every push. The fixed origin cannot be changed by configuration.
Startup reports only the nonsecret authority and token class.

This milestone does not provide OpenShell protected delivery, durable
provider-operation receipts, or a production token authority. Reassigning or
withdrawing registry access blocks new admission; an already-open session keeps
its original grant until the Agent stops or the session lease expires. Verify
the supported lifecycle with the
[installed GitLab lane](../../testing/repository-credentials.md#installed-gitlab-agent-lane).
