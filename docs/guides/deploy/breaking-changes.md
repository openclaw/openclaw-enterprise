# Breaking-change notices

OpenClaw Enterprise (OCE) is pre-alpha and has no stable release, so a newer
main can refuse or break an Installation that an older build created. Each
change like that gets an entry here: what breaks, who is affected, how to tell,
and the steps. Before an upgrade, read every entry dated on or after the date of the
source commit you run now (an entry from that day can be newer than your
commit), here, in the
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

## 2026-10-24: SSH deployment checks Gateway authentication and Secret bindings

**What breaks.** On SSH Compute, deployment refuses a
Configuration whose `gateway` or `gateway.auth` is not an object, whose
`gateway.auth.mode` is not `trusted-proxy` or `password`, which sets another
`gateway.auth` field such as `token`, or whose `gateway.auth.password` is not
the `OPENCLAW_GATEWAY_PASSWORD` reference, with `409 RESOURCE_CONFLICT`.
Deployment and provisioning refuse non-empty Configuration `secretBindings` with `400`. Earlier builds
answered `202`, and every preparation failed. Agent save is unchanged.

**Who is affected.** SSH Installations with such a Configuration; none of them
could deploy.

**How to tell.** The deploy answers with a message such as `Configuration
setting gateway.auth.mode must be trusted-proxy or password`, or
`Configuration secretBindings must be empty on SSH Compute`, and creates no
version.

**Steps.** Fix the named setting, or provision credentials in the
operator-owned `<agentDir>/env` file instead of `secretBindings`; then deploy
again.

## 2026-10-24: OpenShell refuses OpenClaw Agents with several Sandbox ServiceAccounts

**What breaks.** With the OpenShell Sandbox Driver, Agent save, deployment and
provisioning refuse a dedicated OpenClaw Agent with `400` when
`gateway.operatorWorkspaceResources` lists more than one ServiceAccount.
Earlier builds admitted it and failed every new revision in workspace
preparation, after its predecessors had stopped. The Installation's
`openclaw.executionModes` now omits `dedicated` whenever these checks, or the
`kubernetes.userNamespaces` check, refuse it. Codex Agents are unaffected.

**Who is affected.** OpenShell Installations with several such ServiceAccounts
and OpenClaw Agents; none of those Agents could deploy.

**How to tell.** The refusal reads `Dedicated OpenClaw needs at most one
ServiceAccount in gateway.operatorWorkspaceResources`, and Create Agent no
longer offers Dedicated for OpenClaw.

**Steps.** Keep one ServiceAccount in `gateway.operatorWorkspaceResources` and
restart the controller, or switch the Agent to Codex.

## 2026-10-24: chart container resources are checked at render

**What breaks.** `helm install` and `helm upgrade` refuse a `resources`,
`slackProxy.resources` or `logging.collector.resources` entry with a negative
quantity or a resource name other than `cpu`, `memory`,
`ephemeral-storage`, `hugepages-<size>` or a domain-prefixed extended resource
such as `example.com/gpu`. They also refuse a negative
`logging.collector.state.sizeLimit` or `tmp.sizeLimit`. Earlier builds rendered
these and Kubernetes refused the Deployment or Pod when Helm applied it, after
other objects of the release had changed. With `gatewayRouting.enabled`, a
release name whose first 34 characters end in `.` now renders a valid Envoy
NetworkPolicy name; earlier builds failed to create it.

**Who is affected.** Releases that set one of these values by hand.

**How to tell.** Helm fails before applying anything, naming the value, for
example `resources.limits.cpu must not be negative`. A request above its limit
is still left to Kubernetes, which refuses it when Helm applies the release.

**Steps.** Remove the negative or unknown entry, and run the upgrade again.

## 2026-10-24: SSH Compute refuses runtime paths under /tmp

**What breaks.** Controller startup refuses an SSH Compute `runtime.root` that
is `/`, has a `.` or `..` segment, or lies under `/tmp` or `/var/tmp`, as the
[SSH Compute reference](../../reference/drivers/ssh-compute.md) already said,
and a `nodePath` or `openclawPath` under `/tmp` or `/var/tmp`. Earlier builds
started, but each Agent unit runs with `PrivateTmp`, so it could not reach paths
under those and every deployment timed out. A root such as `/var/lib/./oce`
worked and is now refused too.

**Who is affected.** SSH Installations with such a path.

**How to tell.** Startup fails with `INVALID_VALUE` at `/runtime/root`,
`/runtime/nodePath`, `/runtime/openclawPath` or `/hosts`.

**Steps.** Write a root with `.` or `..` segments in its resolved form (the same
directory, so state is kept). Move a path under `/tmp` or `/var/tmp`, for example
the state root to `/var/lib/openclaw-enterprise`. Then restart the controller
and deploy again.

## 2026-10-24: Kubernetes Compute checks dedicated placement and selector labels

**What breaks.** Deployment admission refuses a dedicated Agent (Codex or
OpenClaw) when the Kubernetes Compute configuration sets `runtime` without
`runtime.gatewayNodeSelector` or `gatewayRouting`. Agent create and update
refuse it too when the Configuration selects a model and the Agent binds a
Secret or `runtime` authentication; a stored such Agent still reads, but each
update is refused until the setting is fixed. Controller startup refuses
`runtime.nodeSelector` or `runtime.gatewayNodeSelector` label keys or values
that Kubernetes refuses, and `resources.namespace.quota` entries whose name is
not a Kubernetes quota resource name or whose value is not a non-negative
quantity. Earlier builds accepted all of these; each dedicated deployment then
stopped the running revision and failed in preparation, or the API server
refused the Deployment or ResourceQuota.

**Who is affected.** Installations with such a setting. Embedded and
channel-runtime Installations without dedicated Agents are not affected by the
placement check.

**How to tell.** Saving or deploying the Agent fails with 400 and `Dedicated Agents need
runtime.gatewayNodeSelector` (or `gatewayRouting`) `in this Installation's
Kubernetes Compute configuration`. Or startup fails at
`/runtime/nodeSelector`, `/runtime/gatewayNodeSelector` or
`/resources/namespace/quota`.

**Steps.** Set `runtime.gatewayNodeSelector` to the trusted node pool's labels
and configure `gatewayRouting`, as the
[Kubernetes Compute reference](../../reference/drivers/kubernetes-compute.md)
describes; fix the selector labels or quota entries; then restart the
controller.

## 2026-10-24: Preset saves check literal Agent launch fields

**What breaks.** Preset create and update, and seeding a missing `presets.files`
copy at startup, bootstrap or Namespace creation, refuse a template whose `agent.name`, `agent.executionMode`,
`agent.backendId` or `agent.pluginApprovers` is written without a variable token
and breaks the rule Agent create applies (for example `executionMode: turbo`,
a Backend the Installation does not configure, or a non-Slack approver while a
Plugin Driver is selected).
Earlier builds saved it, and every Agent created from it was refused.

**Who is affected.** Installations whose `presets.files` hold such a field, and
API clients that save one. Existing copies and other stored Presets still read
and render.

**How to tell.** The write answers `400`, or startup or Namespace creation
fails, with a message such as
`Preset agent.executionMode: must be "embedded" or "dedicated".`

**Steps.** Fix the named field, or replace it with a variable token; then
restart the controller or repeat the write. _Untested_ on a real Installation.

## 2026-10-24: OpenShell refuses a quoted userNamespaces and endpoints without ports

**What breaks.** Controller startup refuses an OpenShell Sandbox Driver
configuration whose `kubernetes.userNamespaces` is not a YAML boolean (for
example the quoted string `"false"`, or a key left empty, which is null), or whose
`policy.networkPolicies[].endpoints[].ports` list is empty. Earlier builds
started: a quoted `"false"` reached the Gateway as user namespaces on, so
OpenClaw Agents were refused while Codex Sandboxes kept user namespaces, and an
endpoint without ports failed every Sandbox creation.

**Who is affected.** OpenShell Installations with either setting. Those with a
quoted or empty `userNamespaces` could still run Codex Agents; an endpoint
without ports blocked every Agent.

**How to tell.** Startup fails with `INVALID_TYPE` at
`/kubernetes/userNamespaces`, or a `minItems` refusal at a path such as
`/policy/networkPolicies/0/endpoints/0/ports`.

**Steps.** Write `userNamespaces: false` (or `true`) without quotes, or remove
an empty key, and give each endpoint at least one port; then restart the
controller. Unquoting `false`
turns user namespaces off for Codex Sandboxes too, as the setting says.

## 2026-10-24: chart NetworkPolicy peers are checked at render

**What breaks.** `helm install` and `helm upgrade` refuse a
`gatewayRouting.sandbox.ingressPeers` or `openshellGit.clients` entry that the
Kubernetes API would refuse or that has fields a NetworkPolicy peer lacks: an
invalid `ipBlock.cidr` or `except` CIDR (including leading-zero octets such as
`010.0.0.0/8`), `ipBlock` together with selectors, a
`matchExpressions` entry with an invalid key, an operator other than `In`,
`NotIn`, `Exists` or `DoesNotExist`, or values that do not fit the operator,
invalid `openshellGit.clients` label keys or values, and unknown keys such as
`podSelectors`. Earlier builds rendered these and failed when Helm applied the
NetworkPolicy, after other objects of the release had changed.

**Who is affected.** Releases that set one of these peers by hand with such a
value.

**How to tell.** Helm fails before applying anything, naming the entry, for
example `gatewayRouting.sandbox.ingressPeers[0].ipBlock.cidr requires an IPv4 or
IPv6 CIDR`.

**Steps.** Correct or remove the named field, then run the upgrade again.

## 2026-10-24: OpenShell refuses OpenClaw Agents without user namespaces off

**What breaks.** With the OpenShell Sandbox Driver, Agent save and deployment
refuse a dedicated OpenClaw Agent with a 400 unless the Driver sets
`kubernetes.userNamespaces: false`. Earlier builds saved and admitted it, then
failed every new revision in workspace preparation, after its predecessors had
stopped.

**Who is affected.** OpenShell Installations that leave
`kubernetes.userNamespaces` unset or `true` and run OpenClaw Agents; none of
those Agents could deploy. Codex Agents are unaffected.

**How to tell.** The refusal names `kubernetes.userNamespaces: false`; Create
Agent and the Installation's `openclaw.settingRefusals` show it too.
Provisioning status reads still report earlier requests.

**Steps.** Set `kubernetes.userNamespaces: false` in the OpenShell Sandbox
Driver configuration and restart the controller, or switch the Agent to Codex.

## 2026-10-24: OpenShell Sandbox policy settings are checked at startup

**What breaks.** Controller startup refuses OpenShell Sandbox settings that the
Gateway refuses when it creates a Sandbox: a `policy.process.runAsUser` or
`runAsGroup` other than `sandbox` or a number from 1 to 4294967294, a
`policy.filesystem` path that is relative, only slashes or has a `..` segment, a
read-only `kubernetes.sandboxDataMount` listed in `policy.filesystem.readWrite`,
an unknown key under `policy.filesystem`, and `kubernetes.agentResources`
`requests` or `limits` that are not objects. Earlier builds started, then
failed each dedicated deploy after its predecessors had stopped.

**Who is affected.** Only Installations whose OpenShell Sandbox settings use
one of these values. Apart from a slash-only path such as `//` in
`policy.filesystem.readOnly` (earlier builds refused only `/` there) and an
unknown `policy.filesystem` key such as a `readwrite` typo (earlier builds
ignored it), none of them could deploy an Agent.

**How to tell.** Startup fails with `STARTUP_FAILED`, and the Installation
loader names the setting, for example `/policy/process/runAsUser`.

**Steps.** Correct the named setting, then start the controller again.
