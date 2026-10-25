# Earlier breaking-change notices from 2026-10-24

These [breaking-change notices](breaking-changes.md) are dated 2026-10-24 and
are older than the ones on that page; older ones are in the
[notices before 2026-10-24](breaking-changes-before-2026-10-24.md). They still
apply when you upgrade from a source commit older than their date. Entries are
newest first. Steps marked _untested_ have not been run against a real
Installation.

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

## 2026-10-24: OpenShell refuses unknown settings, invalid Agent resources and protocols

**What breaks.** Controller startup refuses an OpenShell Sandbox Driver
configuration with an unknown key in `kubernetes`, `kubernetes.serviceAccount`,
`kubernetes.sandboxDataMount`, `kubernetes.agentResources`, `policy`,
`policy.process` or `gateway.readiness` (for example `policy.filesytem` or
`kubernetes.userNamespace`), an `agentResources.requests` or `limits` value
that is not a quoted, non-negative Kubernetes quantity or a request above its
limit, or a `policy.networkPolicies[].endpoints[].protocol` that OpenShell
refuses: a name other than `tcp`, `rest`, `websocket`, `graphql` or `sql`, an L7
protocol without `access`, `access` or `enforcement` on `tcp`, or `enforcement:
enforce` on `sql`. Earlier builds started: they ignored a misspelled key, so its
default applied (OpenShell refused one under `agentResources` at Sandbox
creation), and every Sandbox creation failed on the other values. OCE now sends
protocol names lowercase.

**Who is affected.** OpenShell Installations with such a setting. Endpoints
with `json-rpc` or `mcp` never worked, because OpenShell needs rules this
setting cannot express.

**How to tell.** Startup fails with `UNKNOWN_FIELD` at the object that holds
the key, `INVALID_VALUE` or `INVALID_RANGE` at
`/kubernetes/agentResources/requests` (or `limits`), or `INVALID_VALUE` at the
endpoint's `protocol`.

**Steps.** Fix or remove the key, quote each quantity (`cpu: "500m"`) and keep
requests within limits, give each L7 endpoint an `access` preset or remove its
protocol, and use `enforcement: audit` for `sql`; then restart the controller.

## 2026-10-24: OpenShell readiness poll interval is capped at 2147483647 ms

**What breaks.** Controller startup refuses an OpenShell Sandbox
`gateway.readiness.pollIntervalMs` above `2147483647`. Earlier builds accepted
values up to `9007199254740991`, but Node.js fires a longer timer after 1 ms,
so the readiness wait polled Kubernetes back to back until `timeoutMs`.

**Who is affected.** Only Installations that set the poll interval above
`2147483647` (about 24.8 days).

**How to tell.** Startup fails with `STARTUP_FAILED`, and the Installation
loader reports `/gateway/readiness/pollIntervalMs` as not satisfying `maximum`.

**Steps.** Set the value to `2147483647` or less (or remove it for the
1-second default), then start the controller again.

## 2026-10-24: worker timer settings are capped at 2147483647 ms

**What breaks.** `helm install` and `helm upgrade` refuse `worker.pollIntervalMs`
or `worker.leaseDurationMs` above `2147483647`, and the worker refuses to start
when `OCC_WORKER_POLL_INTERVAL_MS`, `OCC_WORKER_LEASE_DURATION_MS` or
`OCC_WORKER_DATABASE_TIMEOUT_MS` is above it. Earlier builds accepted values up
to `9007199254740991`, but Node.js fires a longer timer after 1 ms: the worker
aborted every claim and polled without pause.

**Who is affected.** Only Installations that set one of these above
`2147483647` (about 24.8 days); such a worker could not complete work.

**How to tell.** The render fails with `worker.leaseDurationMs must be at most
2147483647 milliseconds` (or the poll interval), or the worker exits with
`WORKER_STARTUP_FAILED`.

**Steps.** Set the value to `2147483647` or less, then run the upgrade again.

## 2026-10-24: chart refuses unquoted numeric or boolean names

**What breaks.** `helm install` and `helm upgrade` refuse a Secret,
ConfigMap, Secret-key or PersistentVolumeClaim name, a Gateway or
GatewayClass name, or a `dns.namespace`, `api.clients[].namespace` or
`gatewayRouting.envoyNamespace` value, that YAML or `--set` reads as a number or
boolean. The `openclaw-execution` chart refuses the same for its `routing`
names, `routing.envoyNamespace` and `dns.namespace`. Earlier charts rendered
`secretName: 2024` as `"2024"` and `secretName: yes` as `"true"`.

**Who is affected.** Values files with an unquoted name that YAML reads as a
number or boolean, for example `2024`, `1e3`, `yes` or `on`. Most optional
names that read as `false` or `0`, such as `database.caSecretName: false`, still
count as unset, as before. The execution chart's `routing.gatewayName`,
`routing.envoyNamespace` and `dns.namespace` have defaults, so it refuses
`false` there.

**How to tell.** The render fails with `<field> must be a string: quote a value
YAML reads as a number or boolean, or pass it with --set-string`. A required
name set to `false` or `0` fails as missing instead.

**Steps.** Quote the value in the values file, or pass it with
`--set-string`, then run the upgrade again.

## 2026-10-24: deployment checks a completed workspace setup

**What breaks.** Deploying an Agent whose initial workspace setup already
completed is refused when its Configuration breaks the workspace rule that
Agent save applies to a pending setup, for example a roster that no longer
holds only `main`. On SSH Compute this includes any `workspace` on
`agents.defaults` or `main`, also a path under the Agent's own directory that
the host accepted. Each deployment delivers the completed setup, and
preparation refused it again; that failed after its retries with
`DEPENDENCY_UNAVAILABLE`.

**Who is affected.** Agents created with initial workspace files whose
Configuration changed after the first deployment, on any Compute Driver.

**How to tell.** The deploy request answers `400` with the Configuration
setting's message, as Agent save does (or `409` when the selected Sandbox
cannot receive the files), and no version is created.

**Steps.** Restore the setting, or select a Configuration that meets the rule,
then deploy again. _untested_

## 2026-10-24: SSH initial workspace files refuse an explicit workspace at save

**What breaks.** On SSH Compute, Agent create and update refuse initial
workspace files when `agents.defaults.workspace` or the `main` entry's
`workspace` is set, and deploying an Agent whose setup is still pending is
refused the same way. Such a deployment already failed after its retries with
`DEPENDENCY_UNAVAILABLE`: the host accepts only the workspace it derives.

**Who is affected.** SSH Installations with initial workspace files on a
Configuration that sets either `workspace`, for example one written for
Kubernetes.

**How to tell.** The request answers `400` with `Configuration setting
agents.defaults.workspace must be unset for initial workspace files on SSH
Compute` (or names the `main` entry's `workspace`).

**Steps.** Remove that `workspace` setting, or use a Configuration without it,
then save or deploy again. _untested_
