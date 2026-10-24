# Breaking-change notices before 2026-10-11

These [breaking-change notices](breaking-changes.md) are dated 2026-10-10;
newer ones are on that page, in the
[notices before 2026-10-24](breaking-changes-before-2026-10-24.md), in the
[notices before 2026-10-23](breaking-changes-before-2026-10-23.md), in the
[notices before 2026-10-15](breaking-changes-before-2026-10-15.md), in the
[notices from 2026-10-13](breaking-changes-archive.md), in the
[notices before 2026-10-13](breaking-changes-before-2026-10-13.md) and in the
[notices before 2026-10-12](breaking-changes-before-2026-10-12.md), and older ones are in the
[notices before 2026-10-10](breaking-changes-before-2026-10-10.md). They still
apply when you upgrade from a source commit older than their date. Entries are
newest first. Steps marked _untested_ have not been run against a real
Installation.

## 2026-10-10: Credential Secrets must be dedicated; profile Collectors need an exporter

**What breaks.** Helm refuses a Secret name shared by two Secret settings
(installation, auth, database, database CA, sign-in, ChatGPT, kubeconfig,
repository, sandbox, Gateway or Collector) or a generated Gateway Secret. The
public CA settings (database, external Gateway and repository) may share one
with each other.
Envoy Gateway accepts every entry of the gateway API key Secret as a client
key, so sharing it made the ChatGPT admin key, a CA certificate or a TLS key a
valid `x-api-key` on the Agent Gateway listener: such an Installation was never
safe to run. Profiles with `controlPlane.loggingCollector.enabled` need an
`exporter`.

**Who is affected.** Installations sharing those names; the defaults differ.

**How to tell.** `helm upgrade` or the profile renderer reports
`<setting> must name a dedicated Secret` or the missing `exporter`.

**Steps.** Move the credential to a new Secret, point the setting at it, and
upgrade. For `gatewayRouting.apiKeySecretName` (profile:
`controlPlane.gatewayApiKeySecretName`), the new Secret holds only the `occ`
entry; then delete `occ` from the old Secret. Rotate a key that shared the
gateway API key Secret or a generated Gateway Secret, such as the ChatGPT admin
key or a TLS key. Copy your
`exporter` values into the profile input. _untested_

## 2026-10-10: OpenShell Codex Agents need a new deployment

**What breaks.** A controller-only upgrade does not repair OpenShell dedicated
Codex Agents whose shell commands fail with
`bwrap: No permissions to create a new namespace`.
Since #2079, the OpenShell Sandbox Driver adds `"approvalsReviewer": "user"` to
the Codex app server settings it saves during deployment, which keeps
each turn at `danger-full-access`. A version saved earlier keeps its saved
settings, so the Gateway still turns Codex's own sandbox on, and that sandbox
cannot start inside OpenShell.

**Who is affected.** Dedicated Codex Agents on the
[OpenShell Sandbox Driver](../../reference/drivers/openshell-sandbox.md) whose
selected version was saved before #2079 (`66ea9bed5`, 2026-10-10). Other
Harnesses are not affected by the `bwrap` failure.

**How to tell.** Every shell command in the Agent's chats fails with that
`bwrap` message.

**Steps.** Upgrade the controller to `66ea9bed5` or later, then deploy the Agent
again (`occ agent deploy <id>`). A
[runtime upgrade](production-upgrade.md#upgrade-agent-runtimes) does this for
every running Agent. The new version uses the Agent's current Configuration
draft. If commands still fail, check `tools.exec`
([OpenShell credential sources](openshell-credential-sources.md)). _untested_

**Restart policy.** A controller at `db3c97bae` (#2084) or later also has
OpenShell restart any Harness whose process exits. A Sandbox created before
#2084 keeps restart policy `NEVER`, which OpenShell cannot change in place, so
deploy every OpenShell Agent whose Sandbox predates #2084 again too
([An OpenShell Agent stops answering](../topics/agent-troubleshoot.md#an-openshell-agent-stops-answering)).

## 2026-10-10: Gateway listener settings are checked before deployment

**What breaks.** Provisioning and deployment answer `409` for a `gateway.bind`
other than `auto`, `lan` or `custom`, `custom` unless `customBindHost` is
`0.0.0.0`, or Tailscale exposure. These never served routed traffic.

**Who is affected.** Such Configurations on Kubernetes or Docker Compute.
Kubernetes renders an omitted or `auto` bind as `lan` from the next deployment.

**How to tell.** The `409` names the setting.

**Steps.** Fix the named setting and deploy again. On containerd with cgroup v2,
also redeploy Agents whose bind is omitted or `auto`.

## 2026-10-10: controller-only releases can restart Agent Pods once

**What breaks.** After a controller-only release, the first time the new worker
prepares an existing Kubernetes version again, it applies the Gateway and
Harness Pod templates the new controller renders. When they changed (since #1758,
for example, readiness uses an HTTP probe), both Deployments roll once on the
same runtime image, and chat is unavailable until the new Pods are ready (about
17 seconds in one test).

**Who is affected.** Running Agents with repository credentials, within about a
minute of the controller rollout, while their repository session lasts. Other
Agents only if their deployment was still finishing when the new worker took
over.

**How to tell.** The Agent's Gateway and Harness Pods restart after the
controller rollout under a new ReplicaSet of the same version.

**Steps.** Before a controller-only release, confirm the new controller supports
the deployed runtime ([checklist](upgrade-checklist.md)): affected Pods restart
with its rendering on the existing image. Plan for one short chat interruption
per affected Agent.

## 2026-10-10: Codex approval policy is checked at save and before deployment

**What breaks.** Provisioning and deployment answer `409` when
`plugins.entries.codex.config.appServer.approvalPolicy` is `untrusted` (Compute
Drivers also refuse to prepare it). Creating or updating an Agent, provisioning
and deployment answer `400` when an enabled plugin selection sets
`toolDefaults.reviewer` to `auto` and that policy is omitted or `never`.
Native startup checks the automatic reviewer against the policy Compute renders,
but with the policy omitted the Gateway picks its own, which can be `never`.

**Who is affected.** Custom Codex Configurations with `untrusted` (the Gateway
already refused them at load, with a `doctor --fix` hint that cannot work), and
Agents with an automatic plugin reviewer whose Configuration omits the policy
or sets `never` (readiness already refused `never`). Before, saves succeeded;
now any other update of an Agent with such a reviewer, even of credentials only,
is refused. Every bundled Preset sets the policy.

**How to tell.** The `409` or `400` names the setting.

**Steps.** Set the policy to `on-request` before saving the Agent, or choose the
human reviewer, then deploy the Agent again. `on-failure` still works; native
startup now gets `on-request`, which the Gateway runs for it. An Agent already
deployed with the policy omitted keeps its current session policy until it is
deployed again.
