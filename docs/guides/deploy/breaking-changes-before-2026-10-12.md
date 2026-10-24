# Breaking-change notices before 2026-10-12

These [breaking-change notices](breaking-changes.md) are dated 2026-10-11;
newer ones are on that page, in the
[notices before 2026-10-24](breaking-changes-before-2026-10-24.md), in the
[notices before 2026-10-23](breaking-changes-before-2026-10-23.md), in the
[notices before 2026-10-15](breaking-changes-before-2026-10-15.md), in the
[notices from 2026-10-13](breaking-changes-archive.md) and in the
[notices before 2026-10-13](breaking-changes-before-2026-10-13.md), and older ones are in the
[notices before 2026-10-11](breaking-changes-before-2026-10-11.md). They still
apply when you upgrade from a source commit older than their date. Entries are
newest first. Steps marked _untested_ have not been run against a real
Installation.

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
provisioning refuse, before the running version stops, what preparation or the
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
Earlier builds treated most of these as omitted and used the default version,
Pod, level or key path.

**Who is affected.** Scripts that pass one of these flags a variable that can be
empty, such as `--revision="$REV"`.

**How to tell.** `occ` reports `--<flag> must name ...`.

**Steps.** Omit the flag when its value is empty. `--ca-bundle=` still clears
`OCC_CA_BUNDLE`.
