# Breaking-change notices

OpenClaw Enterprise (OCE) is pre-alpha and has no stable release, so a newer
main can refuse or break an Installation that an older build created. Each
change like that gets an entry here: what breaks, who is affected, how to tell,
and the steps. Before an upgrade, read every entry dated on or after the date of the
source commit you run now (an entry from that day can be newer than your
commit), here, in the
[notices before 2026-10-26](breaking-changes-before-2026-10-26.md), in the
[later notices from 2026-10-24](breaking-changes-later-2026-10-24.md), in the
[earlier notices from 2026-10-24](breaking-changes-earlier-2026-10-24.md), in the
[notices before 2026-10-24](breaking-changes-before-2026-10-24.md), in the
[notices before 2026-10-23](breaking-changes-before-2026-10-23.md), in the
[notices before 2026-10-15](breaking-changes-before-2026-10-15.md), in the
[notices from 2026-10-13](breaking-changes-archive.md), in the
[notices before 2026-10-13](breaking-changes-before-2026-10-13.md), in the
[notices before 2026-10-12](breaking-changes-before-2026-10-12.md), in the
[notices before 2026-10-11](breaking-changes-before-2026-10-11.md) and in the
[notices before 2026-10-10](breaking-changes-before-2026-10-10.md),
then follow the [upgrade checklist](upgrade-checklist.md) and
[production image upgrades](production-upgrade.md).

Entries are newest first. Steps marked _untested_ have not been run against a
real Installation.

## 2026-10-28: deploy dedicated Codex Agents on OpenShell again

**What breaks.** The OpenClaw update of 2026-10-28 moves the agent database
schema to 38, which changes the program in a dedicated Codex Agent's OpenShell
Sandbox. The OpenShell Sandbox Driver adopts an existing Sandbox only when it
matches the Agent version exactly. When OCC provisions a version deployed
before the upgrade again, the Driver refuses its Sandbox, and retries do not
help.

**Who is affected.** Agents with a dedicated Codex Harness on the OpenShell
Sandbox Driver, deployed before the upgrade and not deployed since, for example
stopped Agents. The runtime upgrade deploys every running Agent again.

**How to tell.** Provisioning fails with `Refusing OpenShell Sandbox <name>
without exact AgentRevision ownership and content.`

**Steps.** _Untested._ Deploy a new version of the Agent. The new version gets
a new Sandbox.

## 2026-10-27: deploy Agents again to keep strict steering and apply_patch limits

**What breaks.** The OpenClaw update of 2026-10-27 adds `security.preset`, with
the default `personal`. When a Configuration does not set them, this preset lets
another participant's message steer a running turn under the first requester's
authority (`messages.queue.allowCollaborativeSteering`), and lets `apply_patch`
write outside the workspace (`tools.exec.applyPatch.workspaceOnly`). Deployment
now sets the earlier values, `false` and `true`, when they are not set. An Agent
version deployed before the upgrade keeps its document, so its Gateway uses the
new defaults until the next deployment. With steering off, a message from
another participant during a running turn now runs as a separate turn after it,
instead of a refusal.

**Who is affected.** Agents deployed before the upgrade whose Configuration does
not set these settings. The runtime upgrade deploys every running Agent again.

**How to tell.** The Agent version's `configuration` does not contain
`messages.queue.allowCollaborativeSteering`.

**Steps.** After the upgrade, deploy again each Agent the upgrade did not
deploy. To keep the refusal, set
`messages.queue.collaborativeSteeringFallback: "reject"` in the Configuration.

## 2026-10-27: chart listener ports start at 1024

**What breaks.** Helm rendering refuses `api.port`, `metrics.port`,
`slackProxy.port` or `egressAuthority.port` below `1024`. These Pods run as a
non-root user without capabilities, so such a port fails to bind where the
container runtime keeps ports below 1024 privileged. It also refuses number or
boolean `egressAuthority.clients` label values, which Kubernetes refused when
Helm applied the NetworkPolicy.

**Who is affected.** Helm installs that set one of these ports below `1024`.

**How to tell.** Helm fails before applying anything, naming the setting and
the range `1024 to 65535`.

**Steps.** Choose a port from `1024` through `65535` and update callers of that
Service port. Quote label values.

## 2026-10-27: OpenClaw retired its memory flush and cyber failover models

**What breaks.** The OpenClaw update of 2026-10-27 removed
`agents.defaults.compaction.memoryFlush.model`,
`agents.defaults.embeddedAgent.cyberFailover.model` and
`plugins.entries.codex.config.appServer.cyberFailover.model`. Memory flushes
now use the session model and its fallbacks; cyber-policy retries use the
active model. OpenClaw refuses a configuration that still sets one, and its
`doctor --fix` cannot rewrite the read-only Configuration OCE mounts, so the
Gateway does not start. Configuration and Preset save, Agent save and deploy
now refuse these settings with `400 INVALID_REQUEST`.

**Who is affected.** Configurations and Presets that set any of them.

**How to tell.** The message reads `Configuration setting <path> must be
removed: the OpenClaw runtime retired it`.

**Steps.** Before upgrading, remove these settings from each Configuration
and Preset; `mode` and `cooloffMs` under `cyberFailover` still apply. Then
deploy a new version of each Agent that used them.

## 2026-10-27: an OpenClaw Gateway needs a 4Gi memory limit

**What breaks.** Since the OpenClaw update of 2026-10-26, an embedded Gateway
holds 1.5 to 1.6 GiB when ready and peaks at about 2.8 GiB on its first turn,
when OpenClaw starts most of its worker threads. A `3Gi` limit leaves about 10%
headroom, so on a node without swap a larger first turn, or a command run in
the Gateway container, can get the Gateway OOM-killed. The production example,
the profile renderer and the local Kubernetes stack now set the Gateway to
`requests.memory: 2560Mi` and `limits.memory: 4Gi` (were `1792Mi` and `3Gi`).

**Who is affected.** Kubernetes Installations whose
`resources.gateway.limits.memory` is below `4Gi`, including copies of the
earlier example.

**How to tell.** `kubectl describe pod` for a Gateway Pod shows last state
`OOMKilled`, or the first chat turn after a deploy fails with a closed
connection.

**Steps.** _Untested._ Set `resources.gateway.requests.memory` to `2560Mi` and
`limits.memory` to `4Gi` in the Installation, then deploy a new version of
each Agent. Plan `2560Mi` of node memory per embedded Agent and `3328Mi` per
dedicated Codex Agent ([sizing](installation-profiles.md)).

## 2026-10-26: OpenShell Proxy and Gateway refusals name their fix

**What breaks.** More refusals name the fix instead of a generic answer:

- Deploy of an Agent with `github-installation` access when the OpenShell
  Credential Proxy has no `observedHookPreviewWorkspace`: `409
RESOURCE_CONFLICT` (was `503`). An Agent provisioning job for such an Agent
  now fails at once with the same message (it was retried).
- Credential source create whose `token_url` names the tenant's own OpenShell
  gateway: `400 INVALID_REQUEST` naming `/config/token_url` (was `404`).
- Update of a stored source whose `host` or `base_url` breaks a later
  OpenShell Gateway rule: `409 RESOURCE_CONFLICT` (was `404`).

**Who is affected.** Clients that branch on the old status. A missing
resource, or one you cannot read, still answers `403` or `404`.

**How to tell.** The message names the setting or field, for example `needs
the OpenShell Credential Proxy's observed-hook preview`.

**Steps.** Handle these statuses, show the message and do not retry the `409`.

## 2026-10-26: protected source create and credential withdrawal name their refusal

**What breaks.** More refusals name the rule instead of a generic answer:

- Credential source create with a Credential Proxy selected: a type the Proxy
  cannot protect answers `409 RESOURCE_CONFLICT` and lists the types it
  protects; a Secret reference to another Namespace answers `400
INVALID_REQUEST`, as without a Proxy (both were `404`).
- Create of a prepared or credential-free source whose `config.agent_id` names
  an Agent being deleted: `409 AGENT_DELETING`; an embedded Agent:
  `409 RESOURCE_CONFLICT` (both were `404`).
- Withdrawal of a source that the Agent's active version does not use:
  `409 RESOURCE_CONFLICT` (was `404`), for any source ID.
- Agent save or deploy that binds a Proxy-owned source after the Installation
  dropped `drivers.credential_proxy`: `409 RESOURCE_CONFLICT` (was `500`).

**Who is affected.** Clients that branch on the old status or text. A missing
resource, or one you cannot read, still answers `403` or `404`.

**How to tell.** The message names the rule, for example `the selected
Credential Proxy cannot protect codex-pat sources`.

**Steps.** Handle `409` for these requests, show the message and do not retry it.

## 2026-10-26: a Codex network proxy that blocks the repository broker is refused at save

**What breaks.** For an Agent with repository bindings on a dedicated Codex
Harness, or on embedded OpenClaw with the Codex Plugin Driver and plugins,
Agent create and update, provisioning and deployment answer `400
INVALID_REQUEST` when `plugins.entries.codex.config.appServer.networkProxy`
has `enabled: false`, a `mode` other than `limited` or `full`, a non-boolean
`allowLocalBinding`, `domains` that is not an object mapping each host to
`allow` or `deny`, or a `domains` entry with an empty host. Earlier builds saved
and admitted it, and Kubernetes preparation refused it; a dedicated deploy had
stopped the running version first. A deny of the broker host is still refused
only in preparation, which alone knows the host. Configuration save still
accepts these settings, because a Configuration does not know which Agents use
it. A stored such Agent still reads, but each update or deploy is refused.

**Who is affected.** Agents with repository bindings whose Configuration has
such a setting. They could not deploy before either.

**How to tell.** The `400` reads `Configuration setting
plugins.entries.codex.config.appServer.networkProxy.<setting> ..., so Codex
cannot reach the repository credential broker`.

**Steps.** Fix or delete the named setting in the Configuration, or remove the
Agent's repository bindings, then save or deploy again.

## 2026-10-26: saved repository selections, protected deploy and protected sources name their refusal

**What breaks.** More refusals name the rule and the fix instead of a generic
answer:

- Deploy, provisioning work and `GET …/repository-approval-scopes`, when the
  saved repository selections are no longer approved: `409 RESOURCE_CONFLICT`
  (was `400`, as in the next entry). Selections that the request sends keep `400`.
- Deploy that the Credential Proxy cannot start (Installation-wide access or
  Proxy sources without a selected Proxy, several sources without policy
  reduction, no Sandbox Driver, other sources beside repository Git):
  `409 RESOURCE_CONFLICT` (was `503` or `404`). Provisioning fails such work
  instead of retrying.
- Deploy of a live-adopted source without a `provider/model` in
  `agents.defaults.model`: `400 INVALID_REQUEST` (was `404`).
- Update or rotation of a prepared or credential-free credential source:
  `409 RESOURCE_CONFLICT` (was `404`).
- Deletion inside the registration fence and a failed device-login poll keep
  `503`, with text that names the wait or the next step.
- A failed provisioning status names these repository and Credential Proxy
  refusals instead of `Agent provisioning could not complete.`

**Who is affected.** Clients that branch on the old status or text. A missing
resource, or one you cannot read, still answers `403` or `404`.

**How to tell.** The message names the rule, for example
`The saved repository selections are no longer approved for this Namespace`.

**Steps.** Handle `409` for these requests, show the message and do not retry it.

## 2026-10-26: some refusals name their reason instead of 404, 409 or 503

**What breaks.** These refusals no longer answer the generic `404 NOT_FOUND`,
`409` "already exists" or `503 DEPENDENCY_UNAVAILABLE` text. They name the
rule and the fix:

- Credential source create and update with an unknown or missing `config` or
  `secrets` field: `400 INVALID_REQUEST`, detail `/config/<field>` or
  `/secrets/<field>` (was 404).
- Agent create, update, provisioning and deploy with repository selections the
  Namespace does not approve, or with both `repositoryAccess` and
  `repositoryBindings`: `400 INVALID_REQUEST` (was 404).
- Standing repository approval refusals at Agent update and deploy:
  `409 RESOURCE_CONFLICT` (a policy refusal was 404).
- A `harnessAuth.source` that names a ServiceAccount in another Namespace:
  `400 INVALID_REQUEST` (was 404).
- Deploy and provisioning with repository bindings on a Compute Driver without
  repository credentials (Docker, SSH): `409 RESOURCE_CONFLICT` (was 503). A
  queued provisioning job in this state now fails instead of retrying.

**Who is affected.** Clients that branch on the old status or match the
generic text for these requests. A missing resource, or one you cannot read,
still answers `403` or `404` as before.

**How to tell.** The message names the field or rule, for example
`Credential source type openai has no field secrets.extra`.

**Steps.** Handle `400` and `409` for these requests and show the message. Do
not retry the `409` that replaced the `503`.

## 2026-10-26: A denial of your own permission names the missing grant

**What breaks.** A `403 FORBIDDEN` for a grant the caller lacks no longer says
`The exact platform operation was not authorized.` It names the grant and who
grants it, for example `Not authorized: this needs Agent deploy on Agent <id>.
Ask an Installation administrator to grant it.` A create denial says only an
Installation administrator can create it. A denial about the caller's own
account, session or provisioning job now says so in one of six sentences, such
as `The acting account is disabled.`; the
[permissions cheat sheet](../../reference/cheatsheets/permissions.md#denial-messages)
lists them. Statuses and codes do not change. Denials that name no grant keep
the old sentence.

**Who is affected.** Clients that match the old sentence exactly. The console
and `occ` from this build accept both.

**How to tell.** The message starts with `Not authorized:`.

**Steps.** Match the `FORBIDDEN` code instead of the message.
