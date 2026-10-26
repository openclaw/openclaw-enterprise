# Later breaking-change notices from 2026-10-24

These [breaking-change notices](breaking-changes.md) are dated 2026-10-24 and
are older than the ones on that page; older ones are in the
[earlier notices from 2026-10-24](breaking-changes-earlier-2026-10-24.md). They
still apply when you upgrade from a source commit older than their date.
Entries are newest first. Steps marked _untested_ have not been run against a
real Installation.

## 2026-10-24: repository bindings without repository settings answer 409

**What breaks.** On an Installation without a `repository` block, Agent create
and update with `repositoryBindings` answer `409 RESOURCE_CONFLICT` instead of
`503 DEPENDENCY_UNAVAILABLE`. A selected Driver that is unavailable still
answers `503`. The `REPOSITORY_GIT_SENDER_UNQUALIFIED` message and the startup refusal
of the retired `drivers.repo` now name paths that work with a Sandbox; they
used to point every Installation at native Git, which startup refuses beside a
Sandbox.

**Who is affected.** API clients and alerts that retry or match these `503`
answers or the old messages.

**How to tell.** The `409` reads `This Installation has no repository
settings, so no repository credential Driver is selected and an Agent cannot
bind repositories.`

**Steps.** Remove the bindings, or configure `repository`, then save again.

## 2026-10-24: Credential Proxy with repository.openShell refuses non-Git use with 409

**What breaks.** With `repository.openShell` and `drivers.credential_proxy`,
creating a Proxy-owned credential source, or deploying an Agent without a
repository binding, answers `409 RESOURCE_CONFLICT` instead of `503
DEPENDENCY_UNAVAILABLE` or `404 NOT_FOUND`. With any Credential Proxy, deploying
a binding to a source not created or adopted under the Proxy answers `409`
instead of `404`. What is admitted does not change.

**Who is affected.** Installations with these selections, and clients that
match the earlier status codes.

**How to tell.** The `409` reads `With repository.openShell the Credential
Proxy serves only repository Git` or `With drivers.credential_proxy selected, a
revision can use only credential sources created or adopted under the Proxy`.

**Steps.** Give a Git Agent's model an existing Gateway Harness source, as
[protected OpenShell Git](../../reference/repository-credentials/protected-openshell-git.md)
describes, or replace the binding with a Proxy source; then deploy again.

## 2026-10-24: installation-wide repository access must be the only binding at save

**What breaks.** Agent create, update, provisioning and deployment refuse
`repositoryBindings` or `repositoryAccess.repositories` that select the
`github-installation` profile next to another entry, with `400
INVALID_REQUEST`. Earlier builds saved it and refused the deploy with `404
NOT_FOUND`. A stored such Agent still reads, but each update is refused.

**Who is affected.** Agents that combine installation-wide access with another
repository selection; none of them could deploy.

**How to tell.** The `400` reads `Installation-wide repository access (profile
github-installation) must be the Agent's only repository selection.`

**Steps.** Remove the other entries, or select each repository with its own
profile, then save and deploy again.

## 2026-10-24: Plugin Drivers are checked against the Agent's Harness at save

**What breaks.** Agent create and update, Create Agent's preflight,
provisioning and deployment refuse an Agent with plugins whose Harness the
Installation's Plugin Driver cannot run, with `400 INVALID_REQUEST`: the
OpenClaw Plugin Driver needs an OpenClaw Harness, and the Codex Plugin Driver
needs dedicated Codex or embedded OpenClaw. Earlier builds saved and admitted
it, and every preparation failed; a dedicated deploy had stopped the running
revision first. A stored
such Agent still reads, but each update or deploy is refused.

**Who is affected.** Agents with plugins on a Harness that their Plugin Driver
does not support.

**How to tell.** The `400` reads `The Installation's Plugin Driver runs plugins
only in an OpenClaw Harness` (or `a dedicated Codex Harness or embedded
OpenClaw Harness`).

**Steps.** Remove the Agent's plugins, or change its Configuration or execution
mode to a supported Harness, then save again.
