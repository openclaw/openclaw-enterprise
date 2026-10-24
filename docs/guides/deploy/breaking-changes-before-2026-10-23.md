# Breaking-change notices before 2026-10-23

These [breaking-change notices](breaking-changes.md) are dated 2026-10-16 to
2026-10-22; newer ones are on that page, and older ones are in the
[notices before 2026-10-15](breaking-changes-before-2026-10-15.md). They still
apply when you upgrade from a source commit older than their date. Entries are
newest first. Steps marked _untested_ have not been run against a real
Installation.

## 2026-10-22: Credential Proxy retires the repository broker selections

**What breaks.** The Credential Proxy release (#2487) refuses these at Helm
render, or at API and worker startup and in the upgrade check:

- Helm `repositoryCredentials` with the GitHub App signing broker:
  `authority` must be `prepared-git` with `preparedCustodySecretName`; another
  value fails with `GitHub App signing gateway retired: ...`. The broker's
  service config refuses `backend.kind` `github-app` and `github-app-registry`.
- Installation `drivers.repo`: configure `repository.nativeSender` with
  `repository.preparedGitHub`, or protected Git through `repository.openShell`.
  A Backend's own `drivers.repo` member stays.
- Installation or Backend `drivers.conduit`: select
  `drivers.credential_proxy` instead.
- Helm `openshellGit.mode: broker-trial`: only `protected` remains.

The migrator also refuses a database from an earlier Credential Proxy preview.

**Who is affected.** Installations that used the native repository broker
(Installation `drivers.repo`, Helm `repositoryCredentials.enabled`).
`drivers.conduit`, `broker-trial` and the preview database refusal affect only
Credential Proxy preview builds.

**How to tell.** Helm render fails for `broker-trial` and the broker settings
above. The upgrade check prints the startup refusals, for example
`drivers.repo native admission is retired. ...`, but the `startup-error` and
`worker.startup-error` logs show only `STARTUP_FAILED` or
`WORKER_STARTUP_FAILED`. The migrator (`db:migrate --check`) names a preview
history as unsupported.

**Steps.** Before upgrading, drain accepted repository work on the original
release, which alone can settle it, then follow the
[Credential Proxy upgrade](credential-proxy-upgrade.md). Do not replay uncertain
work.

## 2026-10-16: stored model provider settings are checked at deploy

**What breaks.** On every Compute, deploying or redeploying an Agent runs the
Configuration save's model provider rules on the stored Configuration. A
Configuration an older build stored with a provider or model `baseUrl` that is
not an absolute `http` or `https` URL (`ftp://models.example/v1`, `/v1`,
`https:/v1`), an `api` the runtime does not support, or a header name that is
not a valid HTTP field name used to deploy, and then failed at the model probe
or not at all. Deployment now answers `400` and creates no version, even for a
provider the Agent does not use. A provisioning attempt queued before the
upgrade is rejected without retry.

**Who is affected.** Agents whose stored Configuration holds such a value.
Header names were already checked at deploy on Kubernetes Compute.

**How to tell.** The deploy `400` carries the save's message, such as
`Configuration field /models/providers/<provider>/baseUrl must be an absolute http or https URL.`
or `... must name a model API the runtime supports, ...`. A rejected queued
attempt records `PROVISIONING_REJECTED` with the same message.

**Steps.** Edit the Configuration: fix or remove the field the message names,
save, and deploy again.
