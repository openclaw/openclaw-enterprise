# Breaking-change notices

OpenClaw Enterprise (OCE) is pre-alpha and has no stable release, so a newer
main can refuse or break an Installation that an older build created. Each
change like that gets an entry here: what breaks, who is affected, how to tell,
and the steps. Before an upgrade, read every entry dated after the source commit
you run now, then follow the [upgrade checklist](upgrade-checklist.md) and
[production image upgrades](production-upgrade.md).

Entries are newest first. Steps marked _untested_ have not been run against a
real Installation.

## 2026-10-10: Gateway listener settings are checked before deployment

**What breaks.** Provisioning and deployment answer `409` for a `gateway.bind`
other than `auto`, `lan` or `custom`, `custom` unless `customBindHost` is
`0.0.0.0`, or Tailscale exposure. These never served routed traffic.

**Who is affected.** Such Configurations on Kubernetes or Docker Compute.
Kubernetes renders an omitted or `auto` bind as `lan` from the next deployment.

**How to tell.** The `409` names the setting.

**Steps.** Fix the named setting and deploy again. On containerd with cgroup v2,
also redeploy Agents whose bind is omitted or `auto`.

## 2026-10-10: Agent saves check the automatic plugin reviewer

**What breaks.** Creating or updating an Agent answers `400` when an enabled
plugin selection sets `toolDefaults.reviewer` to `auto` and the named
Configuration's `plugins.entries.codex.config.appServer.approvalPolicy` is
omitted or `never`. Before, the save succeeded and only deployment refused it.

**Who is affected.** Clients that save such an Agent before fixing its
Configuration, and any update (even of credentials only) to an Agent already
saved that way.

**How to tell.** The `400` names the setting, as at deployment.

**Steps.** Set the policy to `on-request` (or `on-failure`) first, or choose the
human reviewer.

## 2026-10-10: controller-only releases can restart Agent Pods once

**What breaks.** After a controller-only release, the first time the new worker
prepares an existing Kubernetes revision again, it applies the Gateway and
Harness Pod templates the new controller renders. When they changed (since #1758,
for example, readiness uses an HTTP probe), both Deployments roll once on the
same runtime image, and chat is unavailable until the new Pods are ready (about
17 seconds in one test).

**Who is affected.** Running Agents with repository credentials, within about a
minute of the controller rollout, while their repository session lasts. Other
Agents only if their deployment was still finishing when the new worker took
over.

**How to tell.** The Agent's Gateway and Harness Pods restart after the
controller rollout under a new ReplicaSet of the same revision.

**Steps.** Before a controller-only release, confirm the new controller supports
the deployed runtime ([checklist](upgrade-checklist.md)): affected Pods restart
with its rendering on the existing image. Plan for one short chat interruption
per affected Agent.

## 2026-10-10: Codex approval policy is checked before deployment

**What breaks.** Provisioning and deployment answer `409` when
`plugins.entries.codex.config.appServer.approvalPolicy` is `untrusted` (Compute
Drivers also refuse to prepare it), and `400` when an enabled plugin selection
sets `toolDefaults.reviewer` to `auto` and that policy is omitted or `never`.
Native startup checks the automatic reviewer against the policy Compute renders,
but with the policy omitted the Gateway picks its own, which can be `never`.

**Who is affected.** Custom Codex Configurations with `untrusted` (the Gateway
already refused them at load, with a `doctor --fix` hint that cannot work), and
Agents with an automatic plugin reviewer whose Configuration omits the policy.
With `never`, deployment now refuses what readiness refused before. Every
bundled Preset sets the policy.

**How to tell.** The `409` or `400` names the setting.

**Steps.** Set the policy to `on-request`, or choose the human reviewer, then
deploy the Agent again. `on-failure` still works; native startup now gets
`on-request`, which the Gateway runs for it. An Agent already deployed with the
policy omitted keeps its current session policy until it is deployed again.

## 2026-10-09: refresh-token source updates need a new Secret

**What breaks.** Since #2016, `PATCH` on an `oauth2-refresh-token` credential
source answers `409` when it keeps the recorded `refresh_token` Secret. That
includes `{}` and `occ credential-source update ID` without `--file`, which the
docs used to suggest after a failed update. The issuer may have rotated the
token, and re-sending a stale one can revoke the sign-in.

**Who is affected.** Operators and scripts that change such a source's Secret
value in place and re-send it. Other source types,
including `oauth2-client-credentials`, still accept `{}`.

**How to tell.** The `409` says the gateway may already hold a newer
`refresh_token`.

**Steps.** Complete a new sign-in, store its refresh token in a new Secret, and
send `{ "secrets": { "refresh_token": <the new Secret's ref> } }`, or
`occ credential-source update ID --file` with that document. Redeploy Agents
that use the source.

## 2026-10-09: released Gateways need an agent database migration

**What breaks.** Gateways deployed by the 2026-09-28 release keep their chat
state in an OpenClaw agent database at schema 23. Runtimes since #587
(2026-09-29) use schema 24, and OpenClaw refuses the older database until
`openclaw doctor --fix` migrates it. Deployed again on such a runtime, the
Gateway exits and restarts into the same refusal. Since #1986 the Gateway runs
that migration itself before OpenClaw starts; see
[Gateway storage](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage).

**Who is affected.** Installations upgraded from the 2026-09-28 release whose
Agents are deployed again by a controller before #1986 (#2009 for the Docker
development Driver). Gateways without chat state are not affected.

**How to tell.** The Gateway log shows
`uses schema version 23; stop active agents and run openclaw doctor --fix`.

**Steps.** Upgrade the controller to #1986 or later (#2009 for Docker
development), then deploy the Agent again (`occ agent deploy <id>`). With an
older controller, scale the Gateway Deployment to zero, run
`OPENCLAW_CONFIG_READONLY=1 openclaw doctor --fix --non-interactive` once in a
Pod with the Gateway's template and `sleep` as its command, delete that Pod,
and scale the Deployment back. Doctor logs `v23 -> v24`. Without
`OPENCLAW_CONFIG_READONLY=1` it may end with a read-only file system error and
exit code `1`; the migration still applies.

## 2026-10-09: Dedicated Codex deployment requires the main Agent

**What breaks.** Since #1972, Kubernetes Compute applies dedicated OpenClaw's
`main` Agent rules to dedicated Codex. Deployment answers `400` naming the
setting when the Configuration has:

- `agents.entries` without a `main` entry, for example
  `Dedicated Codex serves the main Agent: add agents.entries.main, or rename an entry to main.`
- `agents.defaults.sessionStore.agentId` or `agents.defaults.systemAgent.agentId`
  set to another Agent.
- an `agents.entries` key that is not canonical, such as `_helper`.

The Gateway serves the Harness workspace only to `main`. Without a `main` entry,
workspace file reads and writes answered `503`; with another default Agent,
chats ran as an Agent other than the one the files page edits.

**Who is affected.** Dedicated Codex Agents whose Configuration matches one of
these. No bundled Preset does. Running workloads are not changed, but until the
Agent is deployed again with a fixed Configuration, re-preparing its active
revision reports the same refusal and skips repair. Embedded OpenClaw and SSH
Compute are unchanged.

**How to tell.** Check the Agent's Configuration for the settings above.

**Steps.** Rename the entry to `main` (or add `agents.entries.main`), set or
remove the named `agentId`, rename a non-canonical key, save the Configuration,
and deploy the Agent again. _untested_

## 2026-10-09: Configuration save refuses Agent rosters every deployment refuses

**What breaks.** Since #1959, Configuration create and update
(`POST /namespaces/<id>/configurations`, `PATCH .../configurations/<id>`,
`occ configuration create` and `update`) answer `400 INVALID_REQUEST` for an
`agents` roster that Kubernetes Compute deployment already refused on every
topology, such as an `agents.list`, an entry's `default`, or more than one
`agents.entries` entry without `agents.ownership: "explicit"`. The
[Configuration reference](../../reference/configuration.md#create-read-update-and-delete)
lists every rule. Such a write used to save and fail only at deploy, with the
same message.

**Who is affected.** Clients and scripts that save such a roster, including the
split-layout `import` below, which re-creates each exported Configuration.
Stored Configurations do not change: they still read, Kubernetes deployment still
refuses them with the same message, and an update that fixes the roster saves.
SSH Compute deployment does not check rosters, so there the save is the first
refusal. Rules that depend on the topology, such as dedicated OpenClaw serving
the `main` Agent, still apply only at deployment.

**How to tell.** A save, like a Kubernetes deployment, fails with a `400`
naming an `agents` setting.

**Steps.** Fix the roster as the message says and save again. For a split-layout
bundle, fix that Configuration's `values` in the bundle file and run `import`
again; it resumes from its ID map.

## 2026-10-09: Driver package entries are checked as Node resolves them

**What breaks.** Since #1923 and #1944, the controller picks an external Driver
package's root export, and decides whether the entry is ESM, the way Node's
`import()` does. It refuses to start, with a `drivers.<capability>.package`
message, on shapes the older loader accepted:

- A `.js` entry whose nearest `package.json` lacks `"type": "module"`, even when
  the package root has it, such as `dist/index.js` beside a `dist/package.json`
  without `type`. Node can still import that file by detecting ESM syntax; the
  controller does not. Its refusal now names the `package.json` that decided the
  format.
- A nested `package.json` that is not valid JSON or not an object
  (`has invalid package scope metadata`); the older loader ignored it.
- An export target that is extensionless (`./dist/index`), a directory, or has
  an encoded `/` or `\`; a file name with a literal `%`, which is now
  percent-decoded; and mixed subpath and condition keys, or numeric condition
  keys.

Some shapes load a different file instead of refusing: a `"."` nested inside an
array entry or condition no longer selects a file, so a later entry may load, and
the `module-sync` and `node-addons` conditions now match as in Node.

**Who is affected.** Installations that select a Driver package
(`drivers.<capability>.package`) built with one of these shapes. Built-in
Drivers and the [documented manifest](../../reference/drivers/selection.md) are
not affected.

**How to tell.** The controller exits at startup with a
`drivers.<capability>.package` message naming the problem. For a package that
uses nested `"."` keys or those conditions, check which compiled file its root
export now selects.

**Steps.** Fix the package and publish a new version: add `"type": "module"` to
the `package.json` the message names, or rename the entry to `.mjs`, and point
`exports` at the exact compiled file. Pin that version in the controller image's
dependencies, rebuild the image and upgrade.

## 2026-10-09: peer namespaces must be Kubernetes namespace names

**What breaks.** Since #1914, the controller refuses to start with
`DNS peer namespace must be a Kubernetes namespace name: a DNS label of at most
63 characters.` (or the same message for a gateway client, the repository
credential gateway, the provider Harness gateway or the managed channel proxy)
when that peer's namespace is not a DNS label (lowercase letters, digits and
inner hyphens). The observability demo chart refuses such
an `occ.namespace`, `dns.namespace` or `grafana.clients[N].namespace`.

**Who is affected.** Only a hand-written `installation.yaml` or demo chart
values with such a value. Such a peer was already unreachable: no Namespace can
have that name. The profile renderer and product charts refuse these values
already.

**How to tell.** The controller logs the message above at startup; `helm
upgrade` of the demo chart fails with the field name.

**Steps.** Set the peer's real Namespace name (`kubectl get namespaces`), then
upgrade.

## 2026-10-09: sandbox domains longer than 214 characters are refused

**What breaks.** Since #1823, Helm refuses a `gatewayRouting.sandbox.domain`
over 214 characters (`must not exceed 214 characters, leaving room for the
agent-<32 hex>. prefix`), and the controller refuses to start with
`Sandbox domain must not exceed 214 characters`. Each dedicated Agent hostname,
`agent-<32 hex>.<domain>`, must fit the 253-character Gateway API limit.

**Who is affected.** Installations with sandbox routing and a 215-253 character
domain. Their dedicated Agent preview routes were already refused at deploy.

**How to tell.**
`helm get values <release> -o json | jq '.gatewayRouting.sandbox.domain // "" | length'`
prints more than 214.

**Steps.** Pick a shorter preview domain, issue its wildcard certificate and
DNS, set the new domain, then upgrade.

## 2026-10-07: migration 0049 refuses managed ChatGPT service-account Agents

**What breaks.** Since #1648 (`94957cedc`), migration
`0049_codex_pat_sources` stops the upgrade with SQLSTATE `23514`
(`Unsupported legacy managed PAT authentication`) when any Agent, Agent
revision or queued provisioning request still uses the retired
`chatgpt_service_account` Harness auth. The method is now `codex_pat` with a
service-account source. The old release keeps running; nothing is changed.

**Who is affected.** Installations that ever deployed an Agent with
`harnessAuth.method` `chatgpt_service_account`, including Agents since changed
to another method, because their old revisions keep it.

**How to tell.** Before upgrading, on the old release:

```bash
occ agent list -o json | jq -r '.[] | select(.harnessAuth.method == "chatgpt_service_account") | .id'
```

Run it in every Namespace (`--namespace`). An Agent changed away from the method
still has old revisions; check them with
`GET /namespaces/<id>/agents/<agent>/revisions`.

**Steps.** Deleting an Agent removes its revisions and provisioning requests,
which clears the refusal.

1. Record each affected Agent's settings (`occ agent get <id> -o json`) and
   workspace files.
2. Delete it on the old release (`occ agent delete <id>`) and wait until
   `occ agent list` no longer shows it.
3. Upgrade.
4. Re-create the Agent with
   `"harnessAuth": {"method": "codex_pat", "source": {"kind": "service_account", "namespaceId": "<ns>", "id": "<sa>"}}`,
   then deploy it.

_Untested_ on a real Installation. The split-layout script below does steps 1, 2
and 4 for every Agent it moves.

## 2026-10-05: split-layout tenants block the controller upgrade

**What breaks.** Since #925 (`dd344a97c`), a single-cluster Installation keeps
each Namespace's Gateways and Harnesses in one tenant namespace. Releases before
it kept Gateways, their state and the canonical Secrets in a separate
`oce-gateways-<hash>` namespace. The current API and worker refuse to start
while such a namespace lacks the tenant label, and the
[image upgrade helper](production-upgrade.md) stops at its startup preflight
(`Existing split-layout Gateway storage prevents this single-cluster upgrade`)
before it changes anything. See
[split-layout installations](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations).

**Who is affected.** Single-cluster Installations created by the 2026-09-28
release, or by any main before `dd344a97c`, with at least one Namespace.
Bootstrap creates `default`, so nearly all are. The experimental
two-cluster profile is not affected.

**How to tell.**

```bash
kubectl get namespaces -l openclaw.dev/gateway-namespace -L openclaw.dev/namespace
```

A row with an empty `NAMESPACE` column is a split-layout tenant.

**Steps.** Adopt each tenant in place with the
[split-layout upgrade](split-layout-upgrade.md): each `oce-gateways-<hash>`
namespace becomes its tenant's namespace, and IDs, Namespace names, revisions,
Secrets, service-account credentials, chat history and Harness workspaces all
stay. Tenants that can't be adopted use the export fallback on the same page,
which re-creates them under new IDs.

## 2026-10-01: released dedicated Agents fail to redeploy

**What breaks.** Since `7e831ba37`, the dedicated Harness init container makes
its `workspace` and `generated-images` directories private (`0700`). Agents
deployed by the 2026-09-28 release have those directories owned by root, so on
the first redeploy the init container fails with `EPERM` and the Harness stays
in `Init:Error`. The upgrade helper's runtime step redeploys every running Agent.

**Who is affected.** Installations whose dedicated Agents were deployed by the
2026-09-28 release and are redeployed by a controller from `7e831ba37` up to,
but not including, #1652 (`42c43fcd0`, 2026-10-09).

**How to tell.** The Harness Pod's `prepare-private-state` container exits with
`EPERM: operation not permitted, chmod '/harness-workspace-state/workspace'`.

**Steps.** Upgrade the controller to `42c43fcd0` or later, then deploy the
Agent again (`occ agent deploy <id>`). The init container moves each old
directory aside, recreates it as uid 1000 with mode `0700` and moves the files
back. Entries it cannot move back are left in `.workspace.kubelet-created` or
`.generated-images.kubelet-created` beside it and named in the init log.
