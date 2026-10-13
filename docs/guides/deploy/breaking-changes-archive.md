# Earlier breaking-change notices

These [breaking-change notices](breaking-changes.md) are older than the ones
on that page and newer than the
[notices before 2026-10-10](breaking-changes-before-2026-10-10.md). They still
apply when you upgrade from a source commit older than their date. Entries are
newest first. Steps marked _untested_ have not been run against a real
Installation. When this page nears the word limit, its oldest notices move to a
new page named for the date they precede.

## 2026-10-12: cluster and execution API ports must be canonical decimals

**What breaks.** Helm now refuses `cluster.port` and `executionCluster.apiPort`
values that are not a canonical decimal from 1 to 65535 with at most five
digits. `010` and integers Sprig cannot convert, such as
`9223372036854775808`, no longer render.

**Who is affected.** Installations that set either port with a leading zero.

**How to tell.** Helm names `cluster.port` or `executionCluster.apiPort` and
says it must be an integer TCP port from 1 to 65535.

**Steps.** Replace a leading-zero value with its effective decimal port (`010`
becomes `8`) before the next Helm upgrade. _untested_ against a live release.

## 2026-10-12: Sandbox workspace files and provisioning repository refusals

**What breaks.**

- With a Sandbox Driver selected (OpenShell), Agent create and provisioning with
  `initialWorkspaceFiles`, and Agent update and deployment while those files
  are pending, answer `409` naming the Sandbox. Before, dedicated Codex saved
  and its first deployment failed, and dedicated OpenClaw got a `400` naming
  `agents.defaults.workspace` or `agents.entries.main.workspace`, which the
  Sandbox had set.
- The Agent provisioning request, and its retry, answer `409` for
  `repositoryBindings` that the Compute topology cannot deliver, with Agent
  create's message. Before, the request answered `202` and the work failed.
- Newly accepted on Kubernetes and Docker Compute: an `agents.entries` roster
  key of `Main` (any letter case) with initial workspace files.

**Who is affected.** OpenShell Installations that create Agents with initial
workspace files, and provisioning clients that send repository bindings on a
topology without repository credential delivery.

**How to tell.** The `409` message names the Sandbox or repository credentials.

**Steps.** Create the Agent without `initialWorkspaceFiles`, or without
`repositoryBindings`.

## 2026-10-11: named Harness authentication and Docker workspace refusals

**What breaks.**

- On Kubernetes Compute, an Agent whose `harnessAuth.method` its topology
  cannot use (for example `runtime` or `codex_pat` on embedded OpenClaw, or
  `oauth` on dedicated OpenClaw) gets `400` naming `harnessAuth.method`, where
  it got a fixed `409`: at provisioning and deployment, and at Agent create and
  update for `runtime` and Secret bindings. Nothing new is refused.
- On Docker Compute, Agent create, and update while initial workspace files
  are pending, answer `400` for an `agents.entries` roster other than `main`
  alone, a workspace other than `/home/node/.openclaw/workspace` or
  `/home/node/workspace`, or a true `skipBootstrap` or
  `skipOptionalBootstrapFiles`. Before, the first deployment's preparation
  failed. The messages match Kubernetes Compute's.

**Who is affected.** Clients that branch on the `409`, and Docker Compute
users who saved such an Agent. Stored Agents still read.

**How to tell.** The `400` names the setting.

**Steps.** Change the named setting, `harnessAuth` or `executionMode`, then save
again.

## 2026-10-11: Agent and Configuration saves refuse what deployment refuses

**What breaks.** On Kubernetes Compute, Configuration create and update,
provisioning and Preset saves answer `400` for an enabled unsupported
`channels.<provider>`, a non-empty `auth`, an `env` or `env.vars` name starting
`OPENAI_` or `ANTHROPIC_` in any case (or a Codex login variable), and an
authorization header on a selected model provider. Agent create and update
answer `503` when the Configuration Driver cannot be read, and refuse what
deployment refused for the same Agent and Configuration: an Agent that is not
`dedicated` (including an omitted `executionMode`) when a Sandbox Driver is
selected (`400`; deployment answered `404`), a Harness the Configuration
selects for the other execution mode (`400`), a Harness authentication,
repository or initial workspace file setup the Compute Driver cannot deliver
(`400` naming the setting, or `409`). Deployment names those Kubernetes
settings too, instead of answering with fixed Harness authentication text:

- Deployment answers `400` naming the setting, where it answered `409`, for
  the dedicated OpenClaw model catalog, a provider `apiKey`, channel Secret
  bindings and `cloudWorkers.requiredProfile`.
- Deployment refuses a pending initial workspace setup the Configuration
  cannot deliver with `400`, where the first deployment's preparation failed.
- Creating a dedicated OpenClaw Agent, or switching an embedded one to
  `dedicated`, needs the Configuration to carry the dedicated model catalog
  first: save the Configuration, then the Agent.

**Who is affected.** Clients that saved such values and fixed them before
deploying. Stored Configurations and Agents still read.

**How to tell.** The `400` names the setting or the execution mode.

**Steps.** Fix the named setting or the Agent's `executionMode`, then save
again.

## 2026-10-11: the chart refuses malformed Secret, ConfigMap and GatewayClass names

**What breaks.** `helm template`, `install` and `upgrade` fail when a Secret
name the chart reads, `repositoryCredentials.registryConfigMapName`,
`gatewayRouting.gatewayClassName` or `gatewayRouting.issuerRef.name` is not a
Kubernetes resource name: lowercase
letters, digits, `-` and `.`, starting and ending with a letter or digit, at
most 253 characters. Examples are `database.caSecretName`,
`gatewayRouting.apiKeySecretName`, `auth.*.secretName` and
`executionCluster.*KubeconfigSecretName`. Kubernetes either refused such a Pod
or left it waiting for a Secret that cannot exist. Profile preflight already
refused the names it writes.

**Who is affected.** Hand-written values files with such a name. No working
Installation is affected, since Kubernetes cannot create a Secret, ConfigMap or
GatewayClass with that name. Settings of disabled features are not checked.

**How to tell.** Rendering fails with
`<setting> must be a Kubernetes resource name of at most 253 characters`.

**Steps.** Create the Secret or ConfigMap under a valid name, set it in your
values, and run the upgrade again. _untested_

## 2026-10-11: status proxy sources that cover every address are refused

**What breaks.** Controller startup refuses a
`network.pluginStatusProxySourceCidrs` entry that covers every address:
`0.0.0.0/0`, `::/0`, or an IPv6 range containing all of `::ffff:0:0/96`.
Such a source let every Pod reach each Agent's status port.
`gatewayTrustedProxyCidrs` already refused these. The two-cluster
`executionCluster.network` lists refused `/0` and now also such IPv6 ranges.

**Who is affected.** Hand-written `installation.yaml` files with such an
entry. Profiles already refused a `/0`.

**How to tell.** Startup fails with `... CIDRs cannot cover every address.`
A narrower status source wider than one address, such as the Pod CIDR, still
starts; the worker logs `KUBERNETES_STATUS_PROXY_SOURCE_BROAD`, and the profile
renderer warns.

**Steps.** List the API server's `/32` or `/128` Pod proxy source addresses
instead, then restart the controller. _untested_

## 2026-10-11: settings that took dedicated Agents down are refused earlier

**What breaks.** Configuration create and update answer `400` for
a `plugins.entries.codex.config.appServer.approvalPolicy` other than `never`,
`on-request` or `on-failure`, and for a literal `gateway.auth.password` (one
that is not a `${NAME}` or `{source, id}` reference). Kubernetes deployment and
provisioning refuse, before the running revision stops, what preparation or the
Gateway refused only after it: those policies and a `gateway.auth.password`
other than the `OPENCLAW_GATEWAY_PASSWORD` reference (`409`); an enabled channel
on an embedded Agent or on an Installation without `runtime.channels`, and,
when the Gateway hosts a workspace node, `file-transfer` in `plugins.deny` or
`plugins.entries.file-transfer.enabled: false` (`400`). Docker and SSH Compute
refuse the same policies.

**Who is affected.** Configurations with such values. A dedicated redeploy of
one stopped the working Agent and then failed. Docker Agents that ran a literal
gateway password can no longer save it. Stored Configurations still read.

**How to tell.** The `400` or `409` names the setting.

**Steps.** Fix the named setting (for the password, use **Enable gateway
password access**), then deploy again.

## 2026-10-11: Gateway StorageClass names are checked before startup

**What breaks.** Profile preflight and controller startup refuse a
`runtime.gatewayStorageClassName` that is not a Kubernetes DNS-subdomain resource
name. Such a value could never create a Gateway PVC.

**Who is affected.** Hand-written `installation.yaml` files with an invalid value;
profiles now refuse the same value before writing deployable files.

**How to tell.** Preflight names `runtime.gatewayStorageClassName`; controller
startup logs `GATEWAY_STORAGE_CLASS_INVALID`.

**Steps.** Run `kubectl get storageclass`, copy the intended StorageClass name into
the Installation input, rerender when using a profile, and restart the controller.

## 2026-10-11: `occ` refuses explicitly empty flag values

**What breaks.** `occ` refuses an empty `--revision=`, `--pod=`, `--level=`,
`--source=`, `--file=`, `--out=`, `--service-principal=`, `--url=`,
`--service-key-file=` or `dev up --key-output=` before it does any work.
Earlier builds treated most of these as omitted and used the default revision,
Pod, level or key path.

**Who is affected.** Scripts that pass one of these flags a variable that can be
empty, such as `--revision="$REV"`.

**How to tell.** `occ` reports `--<flag> must name ...`.

**Steps.** Omit the flag when its value is empty. `--ca-bundle=` still clears
`OCC_CA_BUNDLE`.

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
the Codex app server settings it freezes when it admits a revision, which keeps
each turn at `danger-full-access`. A revision admitted earlier keeps its frozen
settings, so the Gateway still turns Codex's own sandbox on, and that sandbox
cannot start inside OpenShell.

**Who is affected.** Dedicated Codex Agents on the
[OpenShell Sandbox Driver](../../reference/drivers/openshell-sandbox.md) whose
active revision was admitted before #2079 (`66ea9bed5`, 2026-10-10). Other
Harnesses are not affected by the `bwrap` failure.

**How to tell.** Every shell command in the Agent's chats fails with that
`bwrap` message.

**Steps.** Upgrade the controller to `66ea9bed5` or later, then deploy the Agent
again (`occ agent deploy <id>`). A
[runtime upgrade](production-upgrade.md#upgrade-agent-runtimes) does this for
every running Agent. The new revision uses the Agent's current Configuration
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
