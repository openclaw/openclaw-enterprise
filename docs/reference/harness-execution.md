# Harness execution

A Harness calls the model and runs tools for an Agent. The bundled deployment
paths run OpenClaw inside the Agent's gateway or Codex as a dedicated runtime.
Choose an execution mode on the Agent and a compatible model and Harness in its
Configuration.

## Supported topology

| Harness  | Agent execution mode | Workloads and support                                                                                                                                                                      |
| -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenClaw | `embedded`           | One gateway executes the built-in Harness; available on Kubernetes and SSH.                                                                                                                |
| Codex    | `dedicated`          | A gateway connects to a separate Codex Harness; available on Kubernetes.                                                                                                                   |
| OpenClaw | `dedicated`          | Experimental native worker; requires full-facet Sandbox provisioning. Stock OpenShell has [upstream blockers](#optional-sandbox-provisioning), so this is not a supported production path. |

Agent creation defaults to `embedded`; an update that omits the mode preserves
it. Deployment rejects a Harness that the Agent's execution mode cannot run with
`400 INVALID_REQUEST` before work is admitted. A Harness is not a separately
created resource or Driver. Availability and isolation also depend on the
installation's Compute and optional Sandbox. In a single Kubernetes cluster, a
dedicated gateway and its Harness run as separate Pods in the Agent's
[tenant namespace](drivers/kubernetes-compute.md), each with its own
ServiceAccount and storage. Embedded OpenClaw remains one untrusted workload
that cannot move apart from its built-in Harness.

Each dedicated AgentRevision owns one Harness that all its sessions share: the
Codex app server or the native OpenClaw node host. OpenShell contains the whole
AgentRevision, not each session; see
[Agent runtime isolation](security/runtime-isolation.md#agent-runtime-isolation)
for the trust boundary. The node host admits a configurable number of
session-owned worker processes with separate managed workspaces; Kubernetes
defaults to eight retained workers. Additional sessions are refused until a
hosted session stops, and active workers are not displaced.

Dedicated Codex has no separate OCE session-count limit. Active top-level turns
use OpenClaw's `agents.defaults.maxConcurrent`, which defaults, absent an
explicit Agent setting, to the greater of eight or four times OpenClaw's
quota-aware available parallelism. It bounds active turns, not saved session
history.

## Native runtime selection

The selected native model uses a `provider/model` name. Its supported
`agentRuntime.id` is `openclaw` or `codex`; OCC considers model-specific,
Agent-entry, and provider policy, and rejects conflicting explicit policies
rather than choosing one. All configured Agent entries must resolve to the same
primary model and Harness.

The resolver selects OpenClaw when there is no model candidate, or when an
unambiguous built-in provider without custom provider or plugin routing has no
runtime policy. The `openai` and `codex` providers,
explicitly configured providers, and plugin-routed providers require an explicit
supported runtime policy.

Dedicated Codex accepts only the native `codex` provider, or `openai` when the
Codex plugin is explicitly enabled with `websocket` app-server transport.

Selectable model catalogs and model fallbacks under Agent defaults or entries
must retain the selected provider. Additional catalog models also need an
explicit matching Harness runtime; fallbacks must resolve through the same
policy checks to the same Harness. A provider's native `models` array is limited
to the resolved primary and fallback models; each entry's `id` is the full
reference or the ID after its first slash, and IDs may contain slashes. Nonempty
native `agents.list` configurations remain unsupported. Admission preserves the
fallback order in the immutable revision but does not implement fallback
execution or allow changing topology.

## Admission and immutable execution

Deployment authorizes the exact Agent, its Configuration, and its selected
managed harness credential source, when present. A selected SandboxDriver may transform a copy of the native
configuration before validation and admission, leaving the stored source
Configuration unchanged. The revision freezes the admitted document, source Configuration
identity and generation, approved Harness identity/version, execution mode,
Compute identity, and any selected sandbox or account binding.

With default Compute logging ownership, admission stamps platform-owned native
logging after any SandboxDriver transformation and before validation: the
frozen AgentRevision contains `logging.level`, matching `logging.consoleLevel`,
JSON console style, and disabled native OTLP log export. The gateway and Codex
runtime keep console and tool redaction enabled; the admitted Configuration
omits the retired `logging.redactSensitive` key.

Later edits, including the log level, affect only a future explicit deployment. The worker checks the admitted
combination and exact ownership before runtime effects. Unsupported combinations,
revoked authority, or a missing required Driver fail closed; see
[controller reconciliation](controller.md).

## Harness authentication

The Agent's [harnessAuth binding](agents.md#harness-authentication) is the sole
model-auth selector. Kubernetes supports these combinations:

| Binding                           | Topology                           | Credential consumer                                                                                               |
| --------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `api_key` with an OCC Secret      | Embedded OpenClaw                  | Combined gateway/Harness receives `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, selected by its native model provider. |
| `api_key` with an OCC Secret      | Dedicated OpenClaw                 | Only the native Harness receives `OPENAI_API_KEY`.                                                                |
| `api_key` with an OCC Secret      | Dedicated Codex                    | Only Codex receives `OPENAI_API_KEY` and logs in through stdin.                                                   |
| `codex_pat` with an OCC Secret    | Dedicated Codex                    | Only Codex receives `CODEX_ACCESS_TOKEN`; native login validates its account identity.                            |
| `oauth` (**Experimental**)        | Dedicated Codex, no Sandbox Driver | Codex owns its credential bundle on [private storage](drivers/kubernetes-compute/codex-oauth-storage.md).         |
| `codex_pat` with a ServiceAccount | Dedicated Codex                    | Only Codex receives the account token; Backend and workspace ownership stay in control-plane checks.              |
| `credential_source`               | Dedicated Harness                  | The Harness receives only a placeholder; the Sandbox egress proxy inserts the key from the Credential Gateway.    |

A selected Sandbox uses only Compute's
[rendered login mode and Secret projections](drivers/sandbox.md#provisioning-inputs).

A [`credential_source`](credential-sources.md) binding requires a selected
Credential Gateway, the paired OpenShell Sandbox, a dedicated Codex or native
OpenClaw Harness, and a source type whose Harness authentication is OpenAI
`api_key`. Compute projects no model Secret, passes the gateway's attachments
to the Sandbox, and for Codex sets `CODEX_LOGIN_MODE=api_key`. The revision
activates only after every attachment is `ready`.
While a Credential Gateway is selected, deployment rejects the Secret-backed and
account methods with `409`. Other Compute
implementations reject bindings they do not support. SSH embedded OpenClaw accepts
only `{ "method": "runtime" }`: systemd loads operator-provided host credentials,
outside revision immutability, and OCC checks gateway readiness without
validating model authentication; see [SSH Compute](drivers/ssh-compute.md).
Kubernetes deployment rejects `runtime` with `409`.

Before its app server starts, Codex rejects missing or conflicting runtime
inputs and, after login, requires a bounded native model turn to succeed; local
credential storage alone does not prove provider acceptance.
API-key and PAT login state stays in its bounded ephemeral home. Gateway
transport and workload identity credentials remain separate; a dedicated
gateway receives no model credential. Model auth
cannot be supplied through Configuration `secretBindings` or the initial runtime
credential API; those own gateway credentials and transport/channel setup.

For initial and replacement deployments, Kubernetes OpenClaw runs one native
model probe (20 seconds plus 45 CPU-seconds at its CPU limit, 256 output tokens)
in the process that owns model access, with temporary state beneath the
runtime's selected `TMPDIR`. Embedded activation uses the shared gateway's
`Recreate` strategy: cutover can stop the working gateway before the
replacement validates its credentials. Invalid credentials or a provider
failure leave the replacement unready and the Agent unavailable until repair
and restart or a new deployment. There is no automatic rollback.

Both startup checks call the configured primary model. OpenClaw disables tools
and model fallback. Codex ignores user configuration and rules, disables execution
and external tools, and uses read-only filesystem policy without approval grants;
a tool event cannot satisfy its success check. The Codex probe runs with a minimal
environment that keeps only the runtime's TLS trust variables (`SSL_CERT_FILE`,
`SSL_CERT_DIR`), so a TLS-inspecting egress proxy can serve it. Dedicated Codex
reaches its model over Responses WebSocket by default (embedded OpenClaw uses
HTTP streaming), so an egress proxy or firewall in front of the model host must
allow the WebSocket upgrade. Dedicated Codex retries a confirmed
subprocess timeout once after one second, capping each attempt at 30 seconds
within one 61-second budget that includes the delay. Authentication rejection, malformed
output, tool events, and external signals without timeout evidence do not retry.
Wrappers run under `tini`, so termination during a probe, its delay, or a held
failure exits at once without another probe. Exhausted or nonretryable failure
holds the process unready until restart or Pod stop; readiness polling never
starts another model call.

Codex logs each attempt as a structured `codex.model_probe` record with its
number, elapsed milliseconds, exit code, recognized termination signal, and
final code (`READY`, `MODEL_PROBE_TIMEOUT`, `MODEL_PROBE_FAILED`,
`AUTHENTICATION_FAILED`, or `UNAVAILABLE`). Both probe logs add a
`MODEL_PROBE_FAILED` [cause](agents/deployment.md#model-check-failure-cause) and
omit credentials and raw provider output. `occ agent logs` and the console Logs
tab show it as `causeKind` and `causeDetail`. The runtime failure status is
published only after retries end.

`AUTHENTICATION_FAILED` means the provider rejected the credential: OpenClaw
probe status `auth` (401/403 or invalid key), 401 to OpenClaw's first, empty
request to a default OpenAI or Anthropic endpoint, or a Codex `turn.failed`
event or access-token login error reporting 401 or 403. A CPU-starved OpenClaw
probe reports `MODEL_PROBE_CPU_STARVED`. Timeouts, provider server errors,
and transport failures report `MODEL_PROBE_TIMEOUT`, `MODEL_PROBE_FAILED`, or
`LOGIN_FAILED`. The worker fails deployment at once on each held
[code](drivers/compute.md#startup-failure-evidence); after a timeout, redeploy.

Gateway and Harness startup wrappers also emit one `runtime.startup_phase` log
per phase (login, model probe, peer plugin status, plugin install, workspace
setup, process spawn) with its container, phase, outcome (`ok` or `failed`),
duration, and time since wrapper start. A gateway also logs
`peer-status-changed` when its Harness is replaced, then `gateway-respawn` once
the OpenClaw process it restarts in place serves again. These
logs carry no provider, model, credential, or path values.

On a first dedicated Codex deploy the controller creates the gateway alongside
its Harness, which the Agent Service selects from the start but lists only once
ready. The gateway waits for the Harness plugin status without its own deadline, staying unready
and logging `Waiting for Harness plugin runtime status` at most every 30
seconds. The deployment's convergence deadline governs a Harness that never
reports. A redeploy keeps the Service on the serving revision until activation.

Startup checks may incur model usage charges. They verify neither other configured models nor validity after upstream revocation.
Embedded probe transport configuration must use literal metadata rather than
additional environment or Secret references; the selected provider's
`OPENAI_API_KEY` or `ANTHROPIC_API_KEY` alias remains supported.

The revision freezes the admitted source reference, not historical Secret bytes.
A managed account snapshot also retains its exact credential and verified private
Backend/workspace ownership. Later reconciliation cannot substitute a newly
issued account credential. Source updates take effect only through a new deployment
whose real model turn succeeds; metadata alone does not establish readiness.
See [renewal and revocation](../guides/deploy/credential-lifecycle.md).

## Runtime logging

For level changes, collection, and backend verification, use the
[observability guide](../guides/observability.md).

A trusted ComputeDriver can instead declare
[driver-managed runtime logging](drivers/compute.md#runtime-logging-ownership)
for new or adopted runtimes; admission then preserves its native configuration without requiring the Driver to collect logs.
The following rendering policy applies only to the default platform-owned path.

Compute renders logging from the admitted revision. Kubernetes mounts the
admitted native Configuration read-only under `/etc/openclaw`, with
`OPENCLAW_CONFIG_PATH` pointing at that document. Gateway containers receive
native JSON console logging at the admitted level and keep their own OTLP log
export disabled. Dedicated Codex app-servers receive `LOG_FORMAT=json`,
`RUST_LOG=<level>,codex_otel=off`, and host-owned `codex` configuration that
sets `otel.exporter="none"` and `otel.log_user_prompt=false`. Collector-based
export reads Codex stderr only; stdout remains protocol output.

Worker log attributes such as `work.id`, `work.operation`, `work.attempt`, and
`work.outcome` describe controller reconciliation, not runtime resource
identity. The Collector derives `service.name`, version, container, Namespace,
Agent, and revision identity from protected container labels or Pod metadata,
not payload fields.

## Isolation and activation

Each deployed Agent owns its gateway; [Supported topology](#supported-topology)
shows where its Harness runs. The dedicated OpenClaw Harness, provisioned by a
SandboxDriver, enrolls as a paired node through the routed gateway, supervises the worker, and executes
inference plus `exec`, `process`, `read`, `write`, `edit`, and `apply_patch` in
its own environment. Its provider-managed node process uses OpenClaw's
ephemeral connection mode and consumes its one-use enrollment target from a
private file. The gateway retains session admission, effective tool policy,
authoritative transcripts, and streamed event collection. The gateway container
cannot read the model credential or mount the node state; the worker receives
no gateway service-principal token. Provider failure, like a
[missing or disconnected worker](drivers/kubernetes-compute.md#execution-modes),
fails the turn without gateway inference fallback. Credentials, workload identity, storage, and permitted transport
depend on the selected Driver and admitted topology; the
[Kubernetes security reference](security.md) defines its concrete credential
exceptions and enforcement limitations, and Docker has narrower boundaries.

Embedded preparation runs while its predecessor serves; activation can
interrupt service (see [Harness authentication](#harness-authentication)).
Dedicated replacement stops every earlier revision, even a healthy gateway,
before preparation, leaving the Agent unavailable until the replacement is
ready. Guarded activation publishes the replacement before retiring the prior
revision; an older retry never overwrites a newer active revision, and OCC
routes to one active revision. Kubernetes cannot guarantee a process singleton
during node partitions or manual replacement; see [execution
modes](drivers/kubernetes-compute.md#execution-modes). The worker records one
activation audit when durable completion succeeds; recovery repeats safe effects
under the current claim. The [worker flow](../flows/controller-worker.md)
explains exact ordering and failure handling.

The pinned OpenClaw Codex plugin permits fresh remote work when OCC owns the
native process configuration, but it lacks a supported managed-remote resume path
for an existing ordinary session after gateway restart. Retained gateway session
state and persistent volume data prove storage continuity, not continued native
execution. Dedicated restart acceptance remains incomplete; the ownership and
persistence requirements still apply. See the upstream restriction in
[openclaw/openclaw@759e127](https://github.com/openclaw/openclaw/commit/759e127777b54426c922e8ab4c228523ddac04e9).

## Optional sandbox provisioning

A selected [SandboxDriver](drivers/sandbox.md#overview) requires bundled
Kubernetes Compute and can provision the dedicated Harness while Compute keeps
ownership, identity, gateway, and routing. Dedicated native OpenClaw requires that provisioning and
all three [facets](drivers/sandbox.md#containment-facets) (`networking`,
`filesystem`, `process`), and fails admission when no qualifying SandboxDriver
is selected. There is no command-level `exec` facet or per-tool sandbox
admission.

The bundled [OpenShell implementation](drivers/openshell-sandbox.md) supports
dedicated Codex, configured for external rather than nested containment, and
native OpenClaw, which retains its admitted configuration. Its paired Credential
Gateway supplies the model key. The upstream OpenShell Gateway must still
support the app-server token Secret reference and projected workload identity
the admitted workload requires; stock OpenShell incompatibilities fail
explicitly, and test bridges do not establish turnkey production support. See its
[qualification contract](drivers/openshell-sandbox.md#qualification-contract).

### Native worker support

The pinned OpenClaw [runtime image](../../deploy/runtime/README.md) lacks required
worker placement (`cloudWorkers.requiredProfile`) and native worker inference.
Deploy and provisioning therefore refuse dedicated native OpenClaw with
`400 INVALID_REQUEST`, and the console withholds that choice. Provisioning
status reads do not recheck this support, so work accepted before it was
removed still reports its status; retry refuses it. An operator whose
runtime image is built from an OpenClaw source with both features can declare
[`runtime.nativeWorkerSupport`](configuration.md#installation-startup-configuration).

## Related

- [Deploy your first Agent](../guides/first-agent.md)
- [Agent compute](../guides/topics/agent-compute.md)
- [ComputeDriver contract](drivers/compute.md)
- [ServiceAccount credentials](service-accounts.md)
- [Harness execution and shared storage flow](../flows/harness-execution-topology.md)
- [Implementation history](../../specs/README.md)
