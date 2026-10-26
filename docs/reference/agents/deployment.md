# Agent identity and deployment

Use this reference to select an [Agent](../agents.md) execution mode and understand its stable identity, immutable version, and asynchronous deployment. Creating or editing an Agent alone does not start a workload.

## Agent service principal and workload credentials

Every Agent owns exactly one stable, platform-owned service principal.
Separate Agents receive separate service principals, even when they share a
Namespace. The service principal is immutable, belongs to its exact Agent and
Namespace, and remains the same across every version of that Agent.

Inheriting the creator's identity, permissions, session cookie, or provider
credentials is not yet supported. An Agent service principal cannot assume
another Agent's identity. It has the same
role-granted capabilities as a human Principal: an appropriately scoped Role
and AccessBinding can grant any platform action, including administrative
actions and access to another Agent in the same Namespace. Its Namespace scope,
exact resource grants, and matching Restrictions still apply. Authorized Agent
responses expose this internal `servicePrincipalId` as a read-only identifier
so administrators can bind exact IAM policy to the Agent-owned principal.
Create and update requests cannot set or replace it.

Workload identity is execution credential evidence, not a third platform
principal. For a `dedicated` Agent, the
[Kubernetes Compute Driver](../drivers/kubernetes-compute.md) uses separate
gateway and Codex ServiceAccounts. Only Codex receives the short-lived,
audience-scoped projected token for its exact Agent's existing
`servicePrincipalId`; production requires this projection. An `embedded`
gateway necessarily shares its exact Agent's projected workload identity and
Agent-specific model credential because that same process runs the built-in
Harness. Both modes are supported in production. OCC token verification,
identity exchange, and ServicePrincipal
authentication through the controller API remain deferred.

An Agent may also reference one same-Namespace, OCC-owned
[service account](../service-accounts.md) through
`harnessAuth: { method: "codex_pat", source: { kind: "service_account", namespaceId, id: serviceAccountId } }`; setting
`harnessAuth` to `null` clears it. This credential binding does not
replace its ServicePrincipal or Kubernetes ServiceAccount.

## Execution mode

Each Agent explicitly records how its selected Harness runs:

- `embedded` starts one OpenClaw gateway with its built-in Harness. It is the
  default when creation omits `executionMode` and is supported in development
  and production; the combined workload receives its own Agent identity and
  model key.
- `dedicated` starts an Agent-owned gateway and a separate Codex app-server.
  Production uses separate workload identities, authenticated gateway-to-Codex
  transport, and either an operator-owned model API key or an associated
  account's directly projected access token mounted only into Codex.

The Agent's native Configuration selects a Harness through model/provider
`agentRuntime.id` policy. The [Harness execution reference](../harness-execution.md)
owns supported runtime selections, model catalogs, transport, and credential
boundaries. OCC rejects conflicting, unknown, missing, or mode-incompatible
selections before admitting a version: deploy returns `400 INVALID_REQUEST`
with the specific reason, such as "The configured Agent model requires an
explicit supported Harness runtime." A selected SandboxDriver currently requires
`dedicated` Codex execution; it does not support embedded OpenClaw.

An Agent update may include `executionMode`, `harnessAuth`, and `backendId`
alongside its required `configurationId`. Omission preserves the current value;
`harnessAuth: null` clears authentication and `backendId: null` clears the
Backend. Existing versions retain their immutable placement, auth binding, and
Backend association. For the current `harnessAuth` source, an update checks only
the caller's grant (Secret or credential source `operate`, account `read`) and
reads no record. After the Installation selects another Secret Driver or
Credential Gateway, an update can still omit, clear, or replace the old binding;
naming it again fails with `503`, and so does deploying with it. For a Secret,
that `503`, like creating an Agent with one, says to bind a Secret stored
through the selected driver. The named Configuration's Secret bindings get the
full check on every update, even when `configurationId` is unchanged: until
that Configuration's `secretBindings` name Secrets stored through the selected
driver, updates and deploys fail with `503` and a message that says so.
Updating that Configuration, or naming another one, resolves it. See the
[Harness execution topology flow](../../flows/harness-execution-topology.md) for
runtime selection, identity boundaries, and activation.

<a id="revisions-and-deployment" class="anchor-alias"></a>

## Versions and deployment

An Agent revision (`AgentRevision`) records one Agent deployment's saved
configuration and execution settings. It cannot change. The Agent keeps an
ordered version history and at most one selected version, identified by
`activeRevisionId`. Saving a version does not select it or prove workload
readiness. See [Agent revisions](../../guides/topics/agent-revisions.md).

The Agent revision records the source `configurationId`, `configurationKind`, and
`configurationGeneration`, [`gatewayManagedMode`](../agent-native-admin.md#gateway-managed-mode), its complete saved native `configuration`
document, the approved Harness identity/version/mode, selected Compute identity,
nullable `backendId`, and `harnessAuth` with its resolved internal source snapshot.
The auth snapshot contains no credential bytes; public Agent revisions omit private
backend locators and Backend/workspace metadata. Native Configuration values must use
unresolved inline SecretRefs because the saved document is persisted and
returned through the API; see [secret boundaries](../configuration/secrets.md#secret-boundaries).
Nested objects and arrays are immutable.

When a SandboxDriver is selected, its `configureAgent` hook can transform a
copy of the source document before OCC checks and saves it; it does not
update the reusable Configuration or its generation. The saved version
therefore records the source generation and the effective document after that
transformation. Its SandboxDriver selection and the Agent's stable service
principal remain internal; the current HTTP Agent revision schema omits them.
See [SandboxDriver](../drivers/sandbox.md).

The bodyless `POST /namespaces/:namespaceId/agents/:agentId/deploy` requires a
`ready` Namespace, exact-Agent `deploy`, exact
Configuration `read`, and, for managed credentials, the selected
[harness source permissions](../agents.md#harness-authentication). If the selected
Compute Driver requires generated transport credentials and they are missing
before any Agent revision, deployment also requires exact-Agent `read` and
`operate` to create them. Missing credentials after any Agent revision
block deployment and require operator investigation. A
`202` confirms OCC saved the version and queued deployment work;
it does not mean the workload is ready. Later Configuration edits or changes to
an account's selected credential reference affect only future deployments. A
snapshot freezes a Secret reference, not its stored value.

The PostgreSQL worker prepares the Agent gateway and the
workload for that version, sets `activeRevisionId`, activates its route, and retires its
predecessor; see [activation order](#the-selected-version-after-a-failed-deployment).
Each Agent owns its gateway across versions; sibling Agents never share one. Kubernetes Compute supports managed authentication; SSH Compute supports
embedded OpenClaw with [operator-managed runtime credentials](../drivers/ssh-compute.md#credentials-and-supported-boundaries).
Docker rejects authentication bindings. Each Driver rejects unsupported bindings
and topologies before deployment. On Kubernetes without a SandboxDriver, Compute owns the Codex Deployment;
with one selected, that Driver provisions the dedicated Harness workload.
Unless Compute requests
[exclusive replacement](../drivers/compute.md#production-revision-stages), as
Kubernetes does for dedicated Agents and Docker for all Agents, a replacement must preserve its
predecessor's Service selector until activation succeeds. Without an
eligible worker, version work remains queued.

When creation included [initial workspace files](../agents.md#initial-contents-at-creation),
the worker passes private setup state to Compute before starting execution.
Compute must support initialization in the exact Agent's durable workspace;
unsupported Drivers or storage layouts fail deployment. Native setup, file
application, and the durable completion marker must succeed before the gateway
or Harness runs. After activation, OCC clears staged contents and retains setup
identity and completion metadata. Later versions check completion without
reapplying the original text, preserving edits made in the live workspace.

Admission checks what the Installation supports before the Agent service
principal's grants: an unsupported topology, such as dedicated native OpenClaw
without [native worker support](../harness-execution.md#native-worker-support),
gets its capability error even when the Agent principal lacks a grant.
When only the Agent principal's grant is missing, the `403` names the Agent's
missing grant and asks an Installation administrator to give it. It names the
Secret or credential source only when you sent its ID or can read both it and
the Agent. Its audit
event records your request with reason code `AGENT_PRINCIPAL_NOT_AUTHORIZED`
and names that principal, its grant and IAM evidence.
Admission then asks Compute to check the Configuration's gateway settings. On
Kubernetes, a gateway setting it refuses answers `409 RESOURCE_CONFLICT` naming
the setting and what is accepted, never its value, before any version is created
(see [gateway authentication](../drivers/kubernetes-compute/networking-and-isolation.md#gateway-authentication)).

### Pending deployment progress

While a version is not ready, deployment `progress.lastAttempt.code` says why
when Compute knows. Kubernetes reports `REVISION_UNSCHEDULABLE` when a live
Pod is `Unschedulable`, `REVISION_IMAGE_PULL_FAILED` when a container waits on
`ErrImagePull` or `ImagePullBackOff`, `NAMESPACE_POD_QUOTA_EXCEEDED` when a
Deployment for that version reports a full Pod quota in `ReplicaFailure`,
`WORKSPACE_SETUP_RETRYING` while restarting a failed workspace setup, and
`WORKSPACE_NODE_PENDING` when only the workspace node's gateway connection is
outstanding. Activation of a dedicated version reports
`WORKSPACE_NODE_BINDING_PENDING` until the gateway applies the workspace node it
was handed, then `WORKSPACE_NODE_PENDING` until that node connects. Otherwise
the code is `REVISION_INCOMPLETE`. The version stays pending until it is ready,
a held failure (such as `WORKSPACE_SETUP_REFUSED`) ends it, or the convergence
deadline passes. The worker rechecks an unready
version after 500 ms, growing with the deployment's age to 5 s at 200 s.

A dedicated gateway that refuses its own in-Pod CLI as unauthorized can never
apply its workspace node, so activation fails at once with
`AGENT_GATEWAY_UNAUTHORIZED`. Check that the Agent's Configuration sets
`gateway.auth.password` to `OPENCLAW_GATEWAY_PASSWORD` (**Enable gateway password
access**) and deploy again; the gateway log's `runtime.workspace_node` line names
OpenClaw's refusal `reason`. A rate-limited or pairing refusal still waits.

A dependency that fails while it converges is pending too.
`AGENT_GATEWAY_UNAVAILABLE` means the worker could not reach the new gateway
through its route yet (for example, the route answers 404 until the gateway
proxy has the new route, or 503 until it has the ready Pod), and
`KUBERNETES_API_UNAVAILABLE` means a Kubernetes API request timed out, could not
connect, or got 429 or 5xx. Both apply in preparation and
activation. `SANDBOX_ADMISSION_LIMIT_REACHED` means the OpenShell gateway holds
its limit of durable request admissions and refuses requests (see
[OpenShell troubleshooting](../drivers/openshell-sandbox.md#troubleshooting));
`SANDBOX_GATEWAY_UNAVAILABLE`, that it did not answer.
The worker retries on the same cadence without spending
`OCC_WORKER_MAX_ATTEMPTS`. A dependency still failing at the convergence
deadline fails the deployment with its own code.

`REFUSED_CANDIDATE_STOP_PENDING` means the worker refused the candidate but could
not yet stop its workload, such as Pods stuck terminating. The
message names the refusal, such as `AUTHORIZATION_DENIED`, which `error` carries
once the stop succeeds. The wait has no deadline or attempt limit, since the
refused version could still serve. Each failed stop doubles the recheck, from the
cadence above up to 5 minutes, and waits at least four times the stop's duration;
every try moves `lastAttempt.at`, and the worker log's `worker.completed` `cause`
says why the stop fails. If an
authorization or backend refusal lifts (`deploy` granted again), the deployment
continues, or past its convergence deadline stops the candidate and fails
`CONVERGENCE_DEADLINE_EXCEEDED`; other refusals stand. A deployment that a
newer version supersedes still finishes the stop, even of a lifted refusal,
then ends superseded.

`AGENT_STOP_YIELDED` means the Agent was stopped and its gateway is
still draining; `PREDECESSOR_STOP_YIELDED` means a dedicated replacement waits for
the previous version's gateway to drain. Meanwhile the worker runs other due work,
then repeats the stop without spending attempts.

### Model check failure cause

A `RUNTIME_MODEL_PROBE_FAILED` deployment error's `data.runtimeFailure` names
the runtime component, check, time and, when classified, a `cause`: a `kind` and
an optional `detail` token from this closed vocabulary. A Codex `detail` ending
`-attempt2` comes from a check retried once.

| `kind`           | Meaning                                                    | `detail`                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROCESS_EXIT`   | The check process exited nonzero, was killed, or never ran | `exit-<status>`, `signal-<SIGNAL>`, or `error-<ERRNO>`, such as `error-ENOBUFS` (oversized output); others are dropped                                                           |
| `PROBE_STATUS`   | The check ran and reported the model unusable              | OpenClaw `format`, `rate_limit`, `billing`, `unknown`, `no_model`, or `other`; Codex `rate_limit`, `turn-failed`, `error-event`, `tool-event`, `unexpected-event`, or `no-reply` |
| `INVALID_OUTPUT` | The check's output was not what the runtime expects        | `json` (unparseable) or `shape` (an unexpected result, such as another provider's)                                                                                               |
| `WRAPPER_ERROR`  | The runtime wrapper could not prepare or read the check    | none                                                                                                                                                                             |

OpenClaw's `format` covers an unknown model or a request the provider rejected
as malformed, such as invalid provider settings. A 429 or usage limit is
`rate_limit`. A rejected credential is
`RUNTIME_AUTHENTICATION_FAILED` and a timeout `RUNTIME_MODEL_PROBE_TIMEOUT`;
neither has a cause. Compute drops any other cause but keeps the
code, so a cause never carries native output, provider text, or credentials. The
console shows it as **Cause**, and `occ agent deployment-status` prints it.

<a id="the-active-revision-after-a-failed-deployment" class="anchor-alias"></a>

### The selected version after a failed deployment

`activeRevisionId` names the version the worker last committed to run. Stop
shuts it down first, coordinated runtime upgrades require it, and runtime
inspection reads its containers. It is not a health result; each version's [deployment status](../agents.md#deployment-status)
is. Unless Compute activates before commit, the worker sets the pointer before
activation finishes.

If a version fails before the worker sets the pointer, the pointer is
unchanged. After a failed first deployment, the Agent has no selected version.
With [exclusive replacement](../drivers/compute.md#production-revision-stages),
the unchanged pointer names a predecessor that was already stopped, so nothing
serves until a new version activates. When the worker refuses such a candidate
or any first deployment, for example because its deploying actor lost `deploy`
or a credential source was revoked, it stops the candidate's workload and
records the refusal only after the stop succeeds (until then it waits as
[`REFUSED_CANDIDATE_STOP_PENDING`](#pending-deployment-progress)). Other refused
candidates stay until a later successful deployment, stop or delete. A candidate
whose runtime failed by itself, such as `RUNTIME_MODEL_PROBE_FAILED` or
`CONVERGENCE_DEADLINE_EXCEEDED`, keeps its Pods so its version's Logs tab can
show the cause; the next deployment stops them.
Kubernetes embedded replacement reports ready while the predecessor still
serves, so the worker sets the pointer first. Activation then replaces the
shared gateway, and the new gateway runs the startup model probe. If that
probe rejects the credential, the deployment fails with
`RUNTIME_AUTHENTICATION_FAILED` (or, for a probe that timed out after its retries,
`RUNTIME_MODEL_PROBE_TIMEOUT`). The failed version stays selected because its
workload is the only one left; the predecessor has already been replaced. OCC
never rolls back to an earlier version. To recover, correct the cause and
deploy a new version, or stop the Agent.

Agent revision list and read operations are scoped beneath the exact Namespace and
Agent. Each returned Agent revision requires its own authorized read; substituting a
parent does not grant access to another Agent's history. Public response shapes
are defined by the [API reference](../api.md).

## Stop and resume

In the console, use **Stop Agent**, and resume with **Deploy new version**; see the
[console controls](../console.md#stop-and-resume-an-agent).

`POST /namespaces/:namespaceId/agents/:agentId/stop` is bodyless and requires
exact-Agent `operate`. A `202` response means OCC committed `desiredRuntimeState:
"stopped"` and queued Agent-scoped work; it does not claim Compute has already
finished. The worker reauthorizes the original actor, invokes the selected
Compute Driver's idempotent `stopRevision`, and clears the exact
`activeRevisionId` only after shutdown succeeds.

Stop terminates inbound routing and execution while retaining the immutable
Agent revision, Agent credentials, gateway state, and workspace. It neither creates an
Agent revision nor calls destructive version retirement. Repeated stop requests
converge safely, and one Agent's stop does not affect siblings.

Deployment is the resume operation. It saves the next version in a new Agent revision and
sets desired state to `running`; OCC never restarts an old version by mutating
it. Version preparation and maintenance recheck desired state before publication,
so work that overlaps a stop shuts down its candidate instead of resurrecting the
Agent.
