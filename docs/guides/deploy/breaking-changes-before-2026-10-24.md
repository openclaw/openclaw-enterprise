# Breaking-change notices before 2026-10-24

These [breaking-change notices](breaking-changes.md) are dated 2026-10-23;
newer ones are on that page, in the
[later notices from 2026-10-24](breaking-changes-later-2026-10-24.md) and in the
[earlier notices from 2026-10-24](breaking-changes-earlier-2026-10-24.md), and older ones are in the
[notices before 2026-10-23](breaking-changes-before-2026-10-23.md). They still
apply when you upgrade from a source commit older than their date. Entries are
newest first. Steps marked _untested_ have not been run against a real
Installation.

## 2026-10-23: existing-namespace deletion lists ConfigMaps and ServiceAccounts

**What breaks.** Deleting a Namespace placed in an existing Kubernetes
namespace now lists and deletes the ConfigMaps and ServiceAccounts (and, with
repository credentials, Secrets) that still carry that Namespace's ownership.
A worker RoleBinding to a custom role without `list` and `delete` on those
resources used to finish teardown; now the Namespace stays `deleting`.

**Who is affected.** Existing-namespace Installations whose tenant worker role
is not the chart's `tenant-worker` role. The chart's roles already grant both.

**How to tell.** The Namespace stays `deleting`, and its `namespace.delete`
work fails in the worker log.

**Steps.** Grant the worker `list` and `delete` on `configmaps` and
`serviceaccounts` in the namespace, then repeat the `DELETE`.

## 2026-10-23: SSH initial workspace files need a main-only roster at save

**What breaks.** On SSH Compute, Agent create and update refuse initial
workspace files unless `agents.entries` is omitted or holds only `main` (in any
letter case), and `agents.list` is unset, as Kubernetes and Docker Compute do.
Deploying an Agent whose setup is still pending is refused the same way. An
empty `agents.entries` used to deploy; since #3371 every such deployment failed
after its retries. Other entries and `agents.list` already failed every SSH
deployment and are now refused earlier; a `Main` key now works.

**Who is affected.** SSH Installations with initial workspace files on such a
Configuration.

**How to tell.** The request answers `400` with `Configuration setting
agents.entries must hold only main, or be omitted, for initial workspace files`.
An Agent whose setup already completed is not checked at save; its deployment
still fails after its retries with `DEPENDENCY_UNAVAILABLE`.

**Steps.** Remove `agents.entries` or leave only `main` in it, then save or
deploy again. _untested_

## 2026-10-23: saves refuse a model without its provider

**What breaks.** Configuration create and update, Agent provisioning, Agent
create preflight and Preset save refuse an `agents.defaults.model` or `agents.entries.<id>.model` primary
or fallback that is not `<provider>/<model>`, such as `fast` or OpenClaw's
`openrouter:auto`, and fallbacks that are not a list. Every deployment already
refused them. A stored Configuration still reads; an edit must fix the model.

**Who is affected.** Configurations and Presets that hold such a model. They
never deployed.

**How to tell.** A `400` names the setting: `... must name each model as
<provider>/<model>, ...` or `... fallbacks must be an array.` Deployment
now gives the same text.

**Steps.** Write each model as `<provider>/<model>`, for example
`openai/gpt-5.1`, then save.

## 2026-10-23: chart ports refuse leading zeros

**What breaks.** Helm rendering refuses `egressAuthority.port`,
`openshellGit.port`, `repositoryCredentials.upstreamPort` or
`preparedGitHub.issuerPort` given as text with a leading zero, such as
`--set preparedGitHub.issuerPort=0443`. Earlier builds rendered issuer `0443`
as 443, other ports wrongly.

**Who is affected.** Helm installs that set such a port.

**How to tell.** Helm fails with `<setting> must be a TCP port without leading
zeros`.

**Steps.** Write the port without leading zeros, for example `443`.

## 2026-10-23: the worker refuses an App key that cannot sign

**What breaks.** With prepared repository Git, worker startup reads and parses
`repository.preparedGitHub.privateKeyPath` and stops when the key cannot sign.
Earlier builds started, logged `PREPARED_GITHUB_MAINTENANCE_FAILED` on every
pass, and left revisions waiting for Git material. The worker now restarts
until the key is fixed, so it also stops other work. The upgrade check mounts
no private key and cannot catch this.

**Who is affected.** Helm installs with `repositoryCredentials.authority:
prepared-git` whose App-key Secret holds a missing, public, passphrase-protected
or non-RSA key.

**How to tell.** `worker.startup-error` shows
`PREPARED_GITHUB_APP_KEY_INVALID` with `reason` `app_key_unreadable`,
`app_key_unparsable` or `app_key_unsupported`.

**Steps.** Before upgrading, put the App's RSA private key in the Secret named
by `repositoryCredentials.appKeySecretName`; see
[Replace a rejected App key](../repository-credentials/team-runbook.md#replace-a-rejected-app-key).

## 2026-10-23: Installation listeners must match the chart

**What breaks.** API and worker startup and the chart's upgrade check refuse an
Installation listener that the chart Service cannot reach. That is
`drivers.credential_proxy.configuration.authority` or
`repository.openShell.authority` on another port than Helm
`egressAuthority.port` or `openshellGit.port`, on a host other than `0.0.0.0`
or `::`, or with that chart listener disabled. Earlier builds started, or failed
to bind, and then refused every protected request or Git call at first use.
Since 2026-10-23 the check also refuses TLS or issuer file paths other than
where the chart mounts them; a Recreate upgrade with such a path left the API
or worker unable to start after the old Pod stopped.

**Who is affected.** Helm installs with a Credential Proxy authority or
protected OpenShell Git.

**How to tell.** The upgrade check or the `startup-error` log shows
`CHART_LISTENER_MISMATCH` with the Installation and Helm settings and values.

**Steps.** Set the authority `host` to `0.0.0.0` and its `port` to the Helm
value, or enable the chart listener. Set `certificatePath`, `privateKeyPath`
and `issuerPublicKeyPath` to the paths the refusal names. Then upgrade again.

## 2026-10-23: a repository broker peer needs the native sender

**What breaks.** Startup and the chart's upgrade check refuse an Installation
that sets `drivers.compute.configuration.network.repositoryCredentials` without
`repository.nativeSender`. Earlier builds accepted it. Then every stop, retire
and delete of an Agent with repository bindings listed Secrets that the worker
may not list, and retried the 403 without end.

**Who is affected.** Installations that switched from the native repository
broker to protected OpenShell Git or an installed sender, and kept the peer.

**How to tell.** The upgrade check and API and worker startup logs show
`DRIVER_CONFIGURATION_INVALID` for
`/drivers/compute/configuration/network/repositoryCredentials`.

**Steps.** Delete `network.repositoryCredentials` from the Compute
configuration, keep its other `network` settings, and upgrade again.
