# Breaking-change notices

OpenClaw Enterprise (OCE) is pre-alpha and has no stable release, so a newer
main can refuse or break an Installation that an older build created. Each
change like that gets an entry here: what breaks, who is affected, how to tell,
and the steps. Before an upgrade, read every entry dated on or after the date of the
source commit you run now (an entry from that day can be newer than your
commit), here, in the
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

## 2026-10-25: Configuration save refuses a Slack token SecretRef the Slack Driver cannot read

**What breaks.** On the bundled Kubernetes Compute, Configuration create and
update, provisioning, and `POST .../agents/validate` with
`configuration.secretBindings` answer `400 INVALID_REQUEST` when a Slack
`appToken` or `botToken` is a `file` or `exec` SecretRef, an env SecretRef
with a provider other than `default`, or another object. Earlier builds saved it, and the Slack
credential check then refused provisioning and deployment with
`binding_required`. A stored Configuration in this state still reads; an update
that keeps the token is refused, and its deployment can now fail with this
message instead. App tokens in HTTP mode and disabled accounts are not checked.

**Who is affected.** Agents whose stored Configuration has such a Slack token.
They could not deploy before either.

**How to tell.** The message names the setting, for example
`channels.slack.botToken holds a SecretRef the Slack Channel Driver cannot
read`, or `holds an object` for an object that is not a SecretRef. Before you upgrade, read each Agent's Configuration as the next entry
describes and check `appToken` and `botToken` under `channels.slack` and under
each entry of `channels.slack.accounts`.

**Steps.** Write the token as an env SecretRef with provider `default`, or as
one whole `${NAME}`, and send its `secretBindings` entry for `NAME` in the same
request.

## 2026-10-25: Configuration save refuses an unbound channel credential reference

**What breaks.** On the bundled Kubernetes Compute, Configuration create and update,
provisioning, and `POST .../agents/validate` with `configuration.secretBindings`
answer `400 INVALID_REQUEST` when an enabled channel has a `${NAME}` reference
or environment SecretRef without a binding of that name. Builds from later that
day also refuse, at save and at deployment, one inside other text and, in a
channel secret-input field, one with a `:-fallback`, an unbound `$NAME` and a
`${` that OpenClaw does not substitute, such as `${slack_bot}`. Earlier builds
refused only at deployment. An update of a stored
Configuration in this state is refused until it adds the bindings.

**Who is affected.** Clients that save channel values before their bindings,
and Agents whose stored Configuration has an unbound channel reference.

**How to tell.** The message names the setting and the binding, for example
`channels.slack.botToken references SLACK_BOT_TOKEN`, or the text, for example
`channels.slack.botToken contains ${slack_bot}`. Before you upgrade, list each
Namespace's Agents (`GET /namespaces/{namespaceId}/agents`), read the Configuration
each names in `configurationId`
(`GET /namespaces/{namespaceId}/configurations/{configurationId}`), and look for
`${` or a whole `$NAME` in its `channels` values. A plain `${NAME}` is affected only
when the response's `secretBindings` has no `NAME`.

**Steps.** Send the values and their `secretBindings` in one request. For a
stored Configuration, save both Slack Secrets on the Agent's **Credentials**
tab; fix named Slack accounts and `msteams` through the API, sending the
values with every binding they reference. Replace a refused `${` with an
uppercase `${NAME}` bound to a Secret.

## 2026-10-25: provisioning refuses a taken Agent name with 409

**What breaks.** `POST /namespaces/{namespaceId}/agents/provision` with a name
that another Agent in the Namespace has answers `409 RESOURCE_CONFLICT` with
`An Agent with this name already exists in this Namespace. Choose a different
name.` and stores no job. Earlier builds answered `202` and the job failed
with `PROVISIONING_REJECTED` and the same message. Two new requests for one
free name are still both admitted, and the later job fails as before.
`POST /namespaces/{namespaceId}/agents/validate` accepts an optional `name` and
refuses a taken one with the same `409`.

**Who is affected.** API clients and alerts that expect `202` for a taken name
or match the failed job.

**How to tell.** The provisioning request answers `409` with that message.

**Steps.** Choose another name and send the request again.

## 2026-10-25: provisioning refuses an unplaceable dedicated Agent with 400

**What breaks.** `POST /namespaces/{namespaceId}/agents/provision` with a Secret
binding answers `400 INVALID_REQUEST` and `Dedicated Agents need <setting> in
this Installation's Kubernetes Compute configuration`, as Agent save does, when
the Kubernetes Compute configuration sets `runtime` without `gatewayRouting` or
`runtime.gatewayNodeSelector`. Earlier builds answered `409 RESOURCE_CONFLICT`
with fixed text. Create Agent now runs its preflight before it saves the model
Secret or registers a Credential Source for provisioning, so neither is left.

**Who is affected.** API clients and alerts that match that `409`.

**How to tell.** The provisioning request answers `400` with that message.

**Steps.** Configure the named setting as the
[Kubernetes Compute reference](../../reference/drivers/kubernetes-compute.md)
describes, or create an Embedded OpenClaw Agent.

## 2026-10-25: repository options without repository settings answer 200

**What breaks.** On an Installation without a `repository` block, both
`repository-options` routes (`GET /namespaces/{namespaceId}/agents/repository-options`
and the per-Agent one) answer `200` with an empty `data` array and
`meta.notConfigured: true` instead of `503 REPOSITORY_OPTIONS_UNAVAILABLE`. An
unsupported Compute or Sandbox Driver, or an unavailable repository Driver,
still answers `503`. The console no longer logs an error for it.

**Who is affected.** API clients and alerts that match this `503`, or that read
an empty `data` array as "no approved repositories".

**How to tell.** The answer carries `meta.notConfigured: true`.

**Steps.** Treat `meta.notConfigured` as "repository access is not set up";
Agent save still refuses repository bindings there with `409`.
