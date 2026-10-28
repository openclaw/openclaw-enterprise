# Breaking-change notices before 2026-10-26

These [breaking-change notices](breaking-changes.md) are dated 2026-10-25;
newer ones are on that page, and older ones are in the
[later notices from 2026-10-24](breaking-changes-later-2026-10-24.md). They still
apply when you upgrade from a source commit older than their date. Entries are
newest first. Steps marked _untested_ have not been run against a real
Installation.

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
