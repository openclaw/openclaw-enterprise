---
kind: reference/driver/impl
---

# Kubernetes Compute Driver

**Contents**

- [Overview](#overview)
- [Lifecycle](#lifecycle)
- [Configuration](#configuration)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)

## Overview

Implements the [ComputeDriver contract](compute.md).

Kubernetes Compute provisions or adopts one namespace per tenant and creates each
Agent’s gateway. Dedicated Gateways and Harnesses use separate Pods, identities
and volumes; embedded OpenClaw shares one Pod. Experimental `executionCluster`
places dedicated Harnesses in a second cluster;
[cloud and complete runtime acceptance remain pending](../../testing/kubernetes.md#two-cluster-validation).

Managed namespace names use `oce-` plus 15 hexadecimal characters from the Namespace
ID’s SHA-256 digest. The Driver can adopt, but never creates, legacy
`oce-<slug>-<hash12>` names with exact tenant and OpenClaw manager labels and the
`namespace-id` annotation. Adoption retains names. Wrong names or duplicate claims fail closed. OpenShell
rejects names over its Workspace limit.

OpenShell integrations ([operator](openshell-sandbox.md) or experimental
[managed](kubernetes-openshell-compute.md)) own dedicated Codex and native OpenClaw
Harness Pods. Internal execution classes share `occ/kubernetes`; Compute owns other
resources. Dedicated native OpenClaw requires a selected SandboxDriver with Harness
provisioning and networking, filesystem, and process containment. OpenShell rejects
Kubernetes Secret environment projection and projected Agent identity. Use supported
credential delivery and disable ServicePrincipal credential projection; see
[OpenShell qualification](openshell-sandbox.md#workload-identity).

HTTP chat defaults on for new single-cluster runtime revisions and uses a
private exact-POST route with trusted-proxy chat authority. Explicit opt-out
requires a new revision. See [HTTP chat configuration](../agent-http-chat.md#kubernetes-configuration-and-audit).

Operator contracts:

- [Storage and credentials](kubernetes-compute/storage-and-credentials.md): separate gateway state, Harness workspaces, and runtime Secrets.
- [Networking and isolation](kubernetes-compute/networking-and-isolation.md): DNS, private gateway routes, and tenant namespace ownership.
- [Managed channel egress](kubernetes-compute/channel-egress.md): per-Agent Envoy listeners, provider destinations and revocation.

## Lifecycle

### Execution modes

Each Agent gateway Deployment uses one desired replica and `Recreate`: Kubernetes
stops the previous Pod before starting its replacement, which can cause downtime.
Kubernetes Deployment and OCC routing do not fence node processes during partitions
or manual replacement.

Harness configuration selects the Agent's execution topology:

- **Embedded:** OpenClaw runs the gateway and Harness in one Pod. It accepts
  an Agent-scoped model API key, uses `openai/` models, and does not require
  shared storage. For custom OpenAI-compatible HTTPS endpoints, see
  [model provider configuration](kubernetes-compute/model-provider.md).
- **Dedicated:** The gateway and Codex Harness run in separate Pods in the same
  tenant namespace, with separate ServiceAccounts and storage. They communicate through
  authenticated app-server transport. The Gateway uses fully qualified Harness
  Service DNS and the paired node for workspace operations. Codex accepts an
  Agent-scoped API key, a managed ChatGPT account credential, or a supported
  Credential Source, and permits `openai/` or `codex/` models.
- **Dedicated native OpenClaw:** The gateway and paired OpenClaw Harness run in
  separate Pods with separate ServiceAccounts. Compute issues a node-only setup
  credential through the gateway and stores the resulting device identity on the
  Harness workspace claim. The node host supervises the remote worker, which owns
  the agent loop, model inference, and coding tools. With direct Secret delivery,
  only the Harness receives the model API key. With managed delivery, it receives a
  placeholder and the paired Proxy injects the credential. Compute makes its generated `dedicated-native` worker-inference
  profile mandatory, so sessions use the enrolled Harness without a Cloud Worker
  selection. A missing or disconnected Harness fails the turn without gateway
  inference fallback. Explicit `openai/` models require complete API,
  token-limit, input, reasoning, and cost metadata. Custom endpoints require
  the [shared provider](kubernetes-compute/model-provider.md), endpoint-bound
  `credential_source` authentication and HTTPS on port 443 ending
  in `/v1`. Secret-backed keys require `https://api.openai.com/v1`. Model URLs
  reject credentials, queries, fragments and wildcards.

For dedicated replacement, the worker follows the [exclusive preparation contract](compute.md#production-revision-stages)
and stops predecessors before starting the new Harness. This supports RWO workspace
storage with downtime. Restore configuration in a new version, not by restarting
the old snapshot.

Enabled external channels require dedicated execution; unsupported Harness and
execution-mode combinations fail deployment. Embedded OpenClaw is never delegated to OpenShell.

Stop removes the Agent's exact gateway route and runtime, then its dedicated Harness
Deployment or delegates provider-owned removal. Sandbox cleanup follows the
[provisioning lifecycle](#sandbox-provisioning). Stop retains Agent-owned
PersistentVolumeClaims, runtime credential Secrets, and the Credential Source;
retirement removes revision resources. Repeated stop checks exact ownership and
converges for absent runtime objects. Compute stops the Harness before removing its
revision's Credential Proxy deployment and retains the target record until removal
succeeds. The [OpenShell Proxy](credential-proxy.md) retires its delivery copy after
the last binding is removed.

### Plugin startup status

After attempting plugins and verifying configuration, Compute-owned OpenClaw and Codex
runtimes privately report the Agent revision ID, runtime instance, successful selection
IDs, and [warnings](../agent-plugins.md#lifecycle) (`PLUGIN_INSTALL_FAILED` or
`PLUGIN_AUTH_REQUIRED`) for disabled selections. Compute reads the exact workload
through the authenticated Pod proxy under tenant-local RBAC; workloads receive no
Kubernetes write credentials. The endpoint is private. Ownership, startup identity, selection keys, and warning
codes must match. Missing, malformed, or foreign status cannot establish readiness.

Embedded OpenClaw disables failed plugins and their managed tool allowances before
Gateway startup. Dedicated Codex applies current results before serving and
refreshes them after changed restart results. Failed-only app bindings are disabled;
successful selections retain admitted policy and required shared bindings.

The Codex app-server credential derives from the Agent transport Secret, revision ID,
and startup identity. A gateway from the previous startup cannot authenticate to a
restarted Agent. Before its next status poll, the supervisor obtains new status,
applies matching exclusions, and respawns the gateway with the new credential.

The worker commits warnings with successful deployment under its live claim;
restarts recompute status. No receipt ConfigMaps, finalizers, failure latches, or
post-commit acknowledgments are used. Requested selections and account-wide
installations remain unchanged; rollback is not promised.

### Current runtime diagnostics

For optional deployment diagnostics, OCC authorizes the exact Agent and revision. Compute reads
owned runtime Pods through the Kubernetes apiserver Pod proxy. The private endpoint
returns checks for that revision; Compute rejects responses over 65,536 bytes or 32
checks. The API needs Pod `get`/`list` and `pods/proxy` `get` in each runtime
namespace. Single-cluster reads use the tenant namespace; the two-cluster profile reads
dedicated Gateways in the control-cluster Gateway namespace. The chart adds these
permissions to unbound tenant API and Gateway observer roles; operators control their
namespace-local bindings.
Missing Pods or unavailable private endpoints report unknown diagnostic checks
instead of mutating deployment status. The Agent container currently returns no
channel checks.

The bundled gateway maps Slack channel status into configuration,
authentication, and connectivity checks. They exclude raw Slack responses,
credential values, logs, and message text, and never post a message or run a
model turn.

### Sandbox provisioning

Composition adapts OpenShell `SandboxDriver.ensureNamespace` to OCC Namespace lifecycle
hooks. Compute resolves the exact backing namespace and selected Kubernetes client without
calling Sandbox. The hook applies approved namespace-scoped labels and NetworkPolicies,
checks OpenShell gateway readiness, and creates or adopts the Namespace Workspace.
The [SandboxDriver lifecycle](sandbox.md#admission-and-lifecycle) requires Agent revision
cleanup even without Compute's ordinary Harness Deployment. Failed provider Namespace
cleanup keeps the Kubernetes namespace. The provider removes its Harness; Compute
needs no Sandbox custom-resource permissions.
OpenShell workloads use restricted tenant Pod Security Admission without an OCE
exemption. Kubernetes and the independent provider select the runtime; see
[admission requirements](openshell-sandbox.md#kubernetes-and-admission-requirements).

A provider-owned dedicated Harness is ready only with exactly one live Pod in the
resolved namespace. It must match the active Service selector's Agent ID, revision
ID, and `agent` role, all supplied Harness requirement labels, and `Ready=True`.
Zero or multiple live candidates, or one unready candidate, return `ready: false`.
Pods with a valid deletion timestamp, another namespace, Agent ID, revision ID, or
role do not count.

For managed credential delivery, Compute prepares an idle Sandbox and reports
`preparedForCredentialActivation` only when the network policy matches, the
Credential Proxy is ready, and the Sandbox has fresh launch inputs. The worker
selects the revision and authorizes the Credential Source before activation starts
the Harness. The authenticated Gateway operator route supports node enrollment.
Compute publishes user chat and delegated browser routes only after verifying the
runtime and workspace node. See [Credential Source implementation status](../credential-sources.md#implementation-status)
for current limits. Other unready revisions cannot activate.

Malformed or incomplete Pod lists, invalid identities or conditions, duplicate
condition types, contradictory Harness labels, and additional pages are errors.
Missing optional status or conditions means not ready. Preparation errors run cleanup
hooks; activation errors precede routing changes. Cancelled observations cannot report
ready. Checks prove readiness and label uniqueness, not Sandbox IDs, Pod UIDs, guest
authentication, or runtime generation fencing.

### Selected-driver lifecycle hooks

The Driver invokes selected non-Compute hooks around Namespace preparation and
workload startup or teardown. Hooks receive the operation's cancellation signal;
failed revocation blocks teardown. See the [ComputeDriver contract](compute.md#optional-selected-driver-hooks)
for ordering and environment restrictions, and the [lifecycle-hook flow](../../flows/compute-driver-lifecycle-hooks.md)
for implementation.

## Configuration

Set `drivers.compute.id: compute-kubernetes` in the Installation YAML loaded
by both API and worker through `OCC_CONFIG_PATH`. Restart both after changes.
The [field tables and example](kubernetes-compute/configuration.md) define the
settings inside `drivers.compute.configuration`:

| Setting                       | Type   | Requirement | Value, default, and constraints                                    |
| ----------------------------- | ------ | ----------- | ------------------------------------------------------------------ |
| `authentication`              | object | Required    | Explicit in-cluster identity or named kubeconfig context.          |
| `images`                      | object | Required    | Gateway/Agent images and immutable-digest policy.                  |
| `resources`                   | object | Required    | Workload requests/limits and namespace quotas/defaults.            |
| `network`                     | object | Required    | DNS, gateway port, proxy trust, and permitted peers.               |
| `servicePrincipalCredentials` | object | Required    | Explicit workload-identity projection policy.                      |
| `runtime`                     | object | Optional    | Required in production; omission selects the verification runtime. |
| `automations`                 | object | Optional    | [MCP endpoint attestation](#automation-mcp-endpoints).             |
| `gatewayRouting`              | object | Conditional | Dedicated Harnesses with `runtime` need this and node enrollment.  |
| `executionCluster`            | object | Optional    | Experimental second cluster; omitted by default.                   |

<a id="authentication"></a>
<a id="images-and-resources"></a>

See [authentication](kubernetes-compute/configuration.md#authentication) and
[images and resources](kubernetes-compute/configuration.md#images-and-resources).

### Automation MCP endpoints

`drivers.compute.configuration.automations.trustedAnonymousMcpEndpoints` attests
anonymous Agent-shared HTTPS authority for [MCP automations](../agent-automations.md)
on qualified embedded OpenClaw and ordinary deployment-backed dedicated Codex. Stdio, credentialed MCP and unattested
endpoints are unqualified.

```yaml
automations:
  trustedAnonymousMcpEndpoints:
    - url: https://mcp.example.com/mcp
      egressCidrs: [192.0.2.10/32]
```

Supply at most 64 records with unique normalized HTTPS `url` values and no
credentials, query, fragment, or wildcard. `egressCidrs` must contain 1–64 unique
translated IPv4 `/32` or IPv6 `/128` destinations; subnets are not permitted.
Compute permits Gateway TCP and, for dedicated Codex, Agent TCP to those
destinations on the URL port (default 443).
Replace the example IP.

Optional `caBundle` supplies public PEM CA trust; all bundles together must fit
65,536 bytes. Never include private keys. Compute projects trust and verifies deployed endpoint
assets before admission. Bindings capture endpoint, egress and CA identity.

Revision-owned Services/operator HTTPRoutes retain Envoy authentication and require
[tenant-local observation grants](../../guides/deploy/production-agents.md#grant-automation-observation). Before
cron requests, Compute and the broker verify Pod/container,
EndpointSlice targets and same-socket Gateway identity; no Agent-wide fallback.
Revision cleanup removes them. [Qualification and retirement](../agent-automations.md#execution-qualification)
remain required. Attestation removal does not stop running cron; disable/delete
jobs or deny service-side calls. MCP qualification remains pending.

## Limits

### Requirements

- Kubernetes 1.35 or later. On older, unsupported versions the API and worker
  log `compute.preflight-warning` and start.
- A Kubernetes cluster dedicated to one OpenClaw Enterprise Installation; shared
  clusters are not supported.
- Enforced Kubernetes NetworkPolicies, verified Kubernetes API TLS, and
  restricted Pod security.
- Separate controller API and worker ServiceAccounts with operator-managed,
  tenant-local permissions.
- API and worker permission to `GET` the Kubernetes `/version` non-resource URL,
  granted by the production chart's narrowly scoped startup Namespace ClusterRoles.
- Approved, digest-pinned gateway and Agent images.
- Explicit container resource limits, namespace quotas, DNS settings, approved
  proxy clients, and `network.gatewayTrustedProxyCidrs` for gateway trust.
  Native workspace initialization uses `resources.gateway`, including in dedicated
  Harness Pods, because it loads the OpenClaw CLI.
- For real gateways in either topology, an explicitly selected
  `runtime.gatewayStorageClassName` for a private disk supporting the configured Gateway capacity
  `ReadWriteOnce` filesystem claims (`local-path` in the disposable k3d suite).
  Check the [gateway disk requirements](kubernetes-compute/storage-and-credentials.md#gateway-storage)
  before selecting a production StorageClass.
- For dedicated Agents, a default StorageClass that supports `40Gi`
  `ReadWriteOnce` PersistentVolumeClaims.
- If `runtime.codexSeccompProfile` is configured, install that relative
  localhost seccomp profile on every eligible node before Agent startup;
  Kubernetes fails the Codex Pod when it is missing.

The worker manages PersistentVolumeClaims and, when private gateway routing is
enabled, HTTPRoutes through tenant-local RoleBindings. Only the controller API
issues provider credentials. The worker reads admitted transport/channel material
and maintains Harness Secret projections for each Agent revision in the tenant namespace.
The API does not need gateway Pod reads, exec, route writes, or certificate
management for workspace-file access. Do not grant wildcard permissions,
cluster-wide access to tenant resources, workload access to controller
credentials, or permission to create or escalate RoleBindings.

### Existing split-layout installations

Releases before #925 kept each Namespace's Gateways, Gateway state and canonical
Secrets in a separate `oce-gateways-<hash>` namespace. Check for and adopt these
tenants with [Existing split-layout installations](kubernetes-compute/split-layout-installations.md)
before replacing the controller images.

## Troubleshooting

<a id="failure-conditions"></a>

- **Namespace provisioning or deletion fails:** `worker.completed` for `namespace.ensure`
  or `namespace.delete` with `hintCode: KUBERNETES_TENANT_ACCESS_DENIED` means
  Kubernetes returned HTTP 403 during tenant reconciliation or cleanup. Check the
  worker's [tenant-local RoleBinding](../../guides/deploy/production-agents.md#grant-tenant-rolebindings),
  namespace ownership and restricted Pod Security labels, and enforced NetworkPolicies
  in the affected target. Existing namespaces also require external lifecycle ownership,
  exclusive tenant use, and no foreign NetworkPolicies.
- **Gateway or Harness remains pending:** Check image digests and pull permissions,
  CPU and memory limits, quotas, Secrets, workload readiness, and the
  [network profile](kubernetes-compute/networking-and-isolation.md#explicit-network-profiles)
  label. Private HTTP readiness returns `503` until native, plugin, authentication,
  and identity gates pass. Dedicated Codex clears its plugin marker at process start
  to reject stale readiness. For Compute-owned Harnesses, resident `GET /readyz`
  requires successful loopback app-server `initialize`; it creates no thread or model
  turn. The RPC deadline is two seconds; Kubernetes' default HTTP-probe timeout is
  one second. This does not verify the Gateway-to-Harness network path. Access-token
  login retries timeouts, `network`, and `http_5xx` failures: five attempts, 90
  seconds. Exhaustion remains unready until explicit restart; see the
  [authentication probe contract](../harness-execution.md#harness-authentication)
  for model-probe retries and sanitized attempt logs. Native plugin startup, authentication,
  transport, and installation failures remain generic unless the Compute-owned
  runtime reports a verified current-startup warning for an admitted selected plugin.
- **Check `gateway-config` fails:** See
  [configuration OpenClaw refuses](kubernetes-compute/managed-native-configuration.md#configuration-openclaw-refuses-at-startup).
- **`RUNTIME_STARTUP_FAILED` with `CrashLoopBackOff`:** A live Pod's `gateway`
  or Deployment-run `agent` container exited three consecutive times without a
  deliberate restart (check `crash-loop`). For deliberate restarts, the Gateway
  wrapper exits 75 and logs phase `container-restart`; these do not count. Readiness
  resets the count. Without a wrapper count (Harness or older Pod), restart count
  2 in backoff means the third exit. Use `occ agent runtime` for restart count and
  last exit code, and `occ agent logs --previous` for crashed-container output.
- **Gateway storage is pending or rejected:** Check the configured
  `runtime.gatewayStorageClassName`, available space for the configured Gateway
  capacity, filesystem support, worker PVC permissions, and the PVC's exact ownership. Preserve
  data when resolving an incompatible or foreign claim; the driver does not
  adopt or convert it.
- **Dedicated Harness cannot start:** Verify the default StorageClass supports
  a `40Gi` `ReadWriteOnce` claim and the worker can manage
  PersistentVolumeClaims in the tenant namespace.
- **Agent configuration is rejected:** Confirm the selected Harness supports
  its execution mode; external channels and provider-issued access tokens
  require dedicated execution.
- **An Agent with repository bindings is refused for its Codex proxy:** Agent
  save, provisioning and deployment answer `400` when
  `plugins.entries.codex.config.appServer.networkProxy` has `enabled: false`, a
  `mode` other than `limited` or `full`, a non-boolean `allowLocalBinding`, or
  `domains` that is not an object mapping each host to `allow` or `deny`.
  Preparation also refuses a deny of the broker hostname, which only session
  material names. Fix or delete the named setting, or remove the bindings; see
  [repository broker policy](kubernetes-compute/networking-and-isolation.md#networking).
- **Approved traffic fails or denied traffic succeeds:** Verify NetworkPolicy
  enforcement, configured DNS selectors, gateway-client selectors, and any
  assigned Envoy channel listener.
- **Production startup fails:** Confirm the controller API and worker share the
  same `OCC_CONFIG_PATH`, image digests are immutable, Kubernetes credentials
  are valid, and required runtime Secret prefixes are configured.

### Related documentation

- [Production Kubernetes deployment](../../guides/deploy.md)
- [Installation startup configuration](../configuration.md#installation-startup-configuration)
- [Configuration reference](../settings/programmatic.md#kubernetes-compute-driver)
- [Service accounts](../service-accounts.md)
- [ComputeDriver contract](compute.md)
- [SandboxDriver contract](sandbox.md)
- [OpenShell SandboxDriver](openshell-sandbox.md)
- [Controller worker](../controller.md)
- [Harness execution topology](../../flows/harness-execution-topology.md)
- [Kubernetes testing](../../testing/kubernetes.md)
