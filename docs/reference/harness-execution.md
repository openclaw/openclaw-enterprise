# Harness execution

A Harness calls models and runs Agent tools. Bundled deployments run OpenClaw
inside the gateway or OpenClaw or Codex in a separate runtime. Select the Agent's
execution mode and a compatible model and Harness in its Configuration.

For an overview of the Gateway/Harness boundary and file flows, see
[Remote Harness execution and split storage](../guides/topics/remote-harness.md).

## Supported topology

| Harness  | Agent execution mode | Workloads and support                                                                                                                                                    |
| -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenClaw | `embedded`           | One gateway executes the built-in Harness; available on Kubernetes and SSH.                                                                                              |
| Codex    | `dedicated`          | A gateway connects to a separate Codex Harness; available on Kubernetes.                                                                                                 |
| OpenClaw | `dedicated`          | Experimental native worker enabled by the pinned runtime; requires full-facet Sandbox provisioning and supported [workload projections](#optional-sandbox-provisioning). |

Creation defaults to `embedded`; updates omitting the mode preserve it.
Deployment rejects incompatible Harnesses with `400 INVALID_REQUEST` before
admitting work. A Harness is not a separate resource or Driver. Availability and
isolation depend on Compute and the optional Sandbox. In one Kubernetes cluster,
a dedicated gateway and Harness run as separate Pods in the Agent's
[tenant namespace](drivers/kubernetes-compute.md), each with its own
ServiceAccount and storage. Embedded OpenClaw and its built-in Harness remain
one untrusted workload.

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

Native models use `provider/model`: the first slash separates the provider,
and the remaining ID may contain slashes, as in `openai/vendor/model`.
Catalog IDs accept the complete ID with or without its provider prefix.
Supported `agentRuntime.id` values are `openclaw` and `codex`. OCC checks model,
Agent-entry, and provider policies, rejecting explicit conflicts. All Agent
entries must resolve to one primary model and Harness.

For a custom endpoint, private Gateway configuration compiles
`codex/vendor/organization/model` to `codex/openai-compatible/vendor/organization/model`.
OpenClaw selects `openai-compatible` and ID `vendor/organization/model`, preserving
fallback order, metadata and policies. Stored Configuration, version and probe
model remain unchanged.

The resolver selects OpenClaw without a model candidate, or for an unambiguous
built-in provider with no runtime policy, custom provider, or plugin routing.
`openai`, `codex`, explicitly configured providers, and plugin-routed providers
require an explicit supported runtime policy.

Dedicated Codex accepts only the native `codex` provider, or `openai` when the
Codex plugin is explicitly enabled with `websocket` app-server transport.
Its Gateway renders the main workspace as `/home/node/workspace`; Codex executes
in the separate Harness workspace.

Selectable model catalogs and fallbacks under Agent defaults or entries
must retain the selected provider. Additional catalog models need an
explicit matching Harness runtime; fallbacks must resolve through the same
policy checks to the same Harness. A provider's `models` array is limited
to the resolved primary and fallback models; each entry's `id` is the full
reference or the ID after its first slash, and IDs may contain slashes.
Configuration save and Kubernetes deployment refuse a nonempty `agents.list` and
the other rosters OpenClaw rejects ([Configuration](configuration.md#create-read-update-and-delete));
dedicated execution's `main` Agent rules apply only at deployment. Admission
preserves fallback order in the immutable version but does not implement fallback
execution or allow changing topology.

## Admission and immutable execution

Deployment authorizes the exact Agent, Configuration, and selected managed
harness credential source. A SandboxDriver may transform native configuration
before validation and admission without changing its stored source. The version
freezes the admitted document, source identity and generation, approved Harness
identity/version, execution mode, Compute identity, and sandbox or account binding.

With default Compute logging ownership, admission stamps platform-owned native
logging after any SandboxDriver transformation and before validation: the
frozen AgentRevision contains `logging.level`, matching `logging.consoleLevel`,
JSON console style, and disabled native OTLP log export. The gateway and Codex
runtime keep console and tool redaction enabled; the admitted Configuration
omits the retired `logging.redactSensitive` key.

Later edits require another deployment. The worker checks the admitted
combination and ownership before runtime effects. Unsupported combinations,
revoked authority, or a missing required Driver fail closed; see
[controller reconciliation](controller.md).

## Harness authentication

The Agent's [harnessAuth binding](agents.md#harness-authentication) is the sole
model-auth selector. Kubernetes supports these combinations:

| Binding                                     | Topology           | Credential consumer                                                                                               |
| ------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `api_key` with an OCC Secret                | Embedded OpenClaw  | Combined gateway/Harness receives `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, selected by its native model provider. |
| `api_key` with an OCC Secret                | Dedicated OpenClaw | Only the native Harness receives `OPENAI_API_KEY`.                                                                |
| `api_key` with an OCC Secret                | Dedicated Codex    | Only Codex receives `OPENAI_API_KEY` and logs in through stdin.                                                   |
| `codex_pat` with a Secret or ServiceAccount | Dedicated Codex    | Only Codex receives `CODEX_ACCESS_TOKEN`; native login validates its account identity.                            |
| `credential_source`                         | Dedicated Harness  | The Harness receives only a placeholder; the Sandbox egress proxy inserts the key from the Credential Gateway.    |

A selected Sandbox uses only Compute's
[rendered login mode and Secret projections](drivers/sandbox.md#provisioning-inputs).

The `codex_pat` binding accepts a Secret or managed ServiceAccount source and
renders `CODEX_LOGIN_MODE=codex_pat` for both. Source ownership and authorization
remain distinct; native Codex derives account identity from the access token.

A [`credential_source`](credential-sources.md) binding requires a selected
Credential Gateway, the paired OpenShell Sandbox, a dedicated Codex or native
OpenClaw Harness, and a compatible source type. The bundled catalog exposes
OpenAI `api_key` authentication. Dedicated Codex also accepts the
[external ChatGPT authentication contract](drivers/credential-gateway.md#external-chatgpt-authentication)
through the bundled experimental `codex-oauth` source, with paired Refresh
and operator-TLS setup described in the [OpenShell reference](drivers/openshell-credential-gateway.md#experimental-codex-oauth-poc). Compute projects no model Secret and
passes the gateway's attachments to the Sandbox. The version activates only
after every attachment is `ready`.
While a Credential Gateway is selected, deployment rejects the Secret-backed and
account methods with `409`. Other Compute
implementations reject unsupported bindings. SSH embedded OpenClaw accepts
only `{ "method": "runtime" }`: systemd loads operator-provided host credentials,
outside version immutability, and OCC checks gateway readiness without
validating model authentication; see [SSH Compute](drivers/ssh-compute.md).
Kubernetes deployment rejects `runtime` with `409`.

Codex requires a successful native model probe before serving.
API-key/PAT/external-token state stays ephemeral; `chatgptAuthTokens` delegates
refresh externally with no refresh token or native fallback. Dedicated Gateways
do not receive the selected Harness inference credential. Configuration
`secretBindings` supply channel and Gateway feature credentials, including Memory
embeddings; the initial runtime credential API supplies transport authentication.

For initial and replacement deployments, Kubernetes OpenClaw runs one native
model probe (20 seconds plus 45 CPU-seconds at its CPU limit, 256 output tokens)
in the process that owns model access, with temporary state under its
`TMPDIR`. Embedded activation uses the shared gateway's
`Recreate` strategy: cutover can stop the working gateway before the
replacement validates its credentials. Invalid credentials or a provider
failure leave the replacement unready and the Agent unavailable until repair
and restart or a new deployment. There is no automatic rollback.

Both startup checks call the configured primary model. OpenClaw disables tools
and model fallback. Codex ignores user configuration and rules, disables execution
and external tools, and uses read-only filesystem policy without approval grants;
a tool event cannot satisfy its success check. The Codex probe's minimal
environment keeps only the runtime's TLS trust variables (`SSL_CERT_FILE`,
`SSL_CERT_DIR`), so a TLS-inspecting egress proxy can serve it. Dedicated Codex
reaches its model over Responses WebSocket by default (embedded OpenClaw uses
HTTP streaming), so an egress proxy or firewall before that model host must
allow the WebSocket upgrade. Compatible endpoints use HTTPS Responses streaming, including the probe.
Secret-backed Codex uses [Compute configuration](drivers/kubernetes-compute.md#configuration);
OpenShell sources supply their own endpoint. Dedicated Codex retries once, after
1-1.5 seconds, a timeout, transient failure (provider 5xx or overload, dropped
connection, kill) or `network`/`http_5xx` exit naming no credential, TLS error
or limit; nothing else retries, except TLS or DNS failures Codex prints only as
a failed connection. Attempts cap at 30 seconds within one 61-second budget,
delay included. Under `tini`, termination always exits at once. Exhausted
or nonretryable failure holds the process unready until restart or Pod stop;
readiness polling never starts another model call.

Codex logs each attempt as a structured `codex.model_probe` record with its
number, elapsed milliseconds, exit code, recognized termination signal, and
final code (`READY`, `MODEL_PROBE_TIMEOUT`, `MODEL_PROBE_FAILED`,
`AUTHENTICATION_FAILED`, or `UNAVAILABLE`). Both probe logs add a
`MODEL_PROBE_FAILED` [cause](agents/deployment.md#model-check-failure-cause)
(`causeKind` and `causeDetail` in `occ agent logs` and the console Logs tab) and
omit credentials and raw provider output; a failed Codex probe or login logs only
its closed `failureClass`, such as `network`. The runtime failure status is
published only after retries end.

`AUTHENTICATION_FAILED` means the provider rejected the credential: OpenClaw
probe status `auth` (401/403 or invalid key), 401 to OpenClaw's first, empty
request to a default OpenAI or Anthropic endpoint, or a Codex `turn.failed`
event or access-token login error reporting 401 or 403. The upfront 401 adds closed-set
`providerCode`, `responseHeaderMarker` (header names), `bodyShape`
(`json-error-code`, `json-error-no-code`, `json-no-error`, `non-json`, `empty`),
`providerErrorCode` and `providerErrorType` (`error.code`, `error.type`: `other` off-set,
omitted when missing). A CPU-starved OpenClaw
probe reports `MODEL_PROBE_CPU_STARVED`. Timeouts, provider server errors,
and transport failures report `MODEL_PROBE_TIMEOUT`, `MODEL_PROBE_FAILED`, or
`LOGIN_FAILED`. The worker fails deployment at once on each held
[code](drivers/compute.md#startup-failure-evidence); after a timeout, redeploy.

Startup wrappers emit `runtime.startup_phase` for login, model probe, peer status,
plugin install, state migration, workspace setup and process spawn, recording container, phase,
outcome, duration and elapsed startup time. Gateways log `peer-status-changed` on
Harness replacement and `gateway-respawn` when the restarted process serves again.
These logs omit provider, model, credential and path values.

On a first dedicated Codex deploy the controller creates the gateway alongside
its Harness, which the Agent Service selects from the start but lists only once
ready. The gateway waits for the Harness plugin status without its own deadline, staying unready
and logging `Waiting for Harness plugin runtime status` at most every 30
seconds. The deployment's convergence deadline governs a Harness that never
reports. A redeploy keeps the Service on the serving version until activation.

Startup checks may incur model charges and verify neither other configured models nor validity after upstream revocation.
Embedded probe transport configuration must use literal metadata rather than
additional environment or Secret references; the selected provider's
`OPENAI_API_KEY` or `ANTHROPIC_API_KEY` alias remains supported.

The version freezes the admitted source reference, not historical Secret bytes.
A managed account snapshot also retains its exact credential and verified private
Backend/workspace ownership. Later reconciliation cannot substitute a newly
issued account credential. Source updates take effect only through a new deployment
whose real model turn succeeds; metadata alone does not establish readiness.
See [renewal and revocation](../guides/deploy/credential-lifecycle.md).

## Runtime logging

Use the [observability guide](../guides/observability.md) for level changes,
collection, and backend verification.

A trusted ComputeDriver can instead declare
[driver-managed runtime logging](drivers/compute.md#runtime-logging-ownership)
for new or adopted runtimes; admission then preserves its native configuration without requiring the Driver to collect logs.
The following rendering policy applies only to the default platform-owned path.

Compute renders logging from the saved version. Kubernetes mounts the
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
Agent, and Agent revision IDs from protected container labels or Pod metadata,
not payload fields.

## Isolation and activation

Each Agent owns its gateway. Its SandboxDriver-provisioned dedicated OpenClaw
Harness enrolls as a paired node through the routed gateway, supervises workers, and executes
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
Dedicated replacement stops every earlier version, even a healthy gateway,
before preparation, leaving the Agent unavailable until the replacement is
ready. Guarded activation publishes the replacement before retiring the prior
version; an older retry never overwrites a newer selected version, and OCC
routes to one selected version. Kubernetes cannot guarantee a process singleton
during node partitions or manual replacement; see [execution
modes](drivers/kubernetes-compute.md#execution-modes). The worker records one
activation audit when durable completion succeeds; recovery repeats safe effects
under the current claim. The [worker flow](../flows/controller-worker.md)
explains exact ordering and failure handling.

Ordinary thread resume permits an OpenClaw-owned remote connection after
ownership and non-running-thread checks. Manual adoption requires local stdio
and an OpenClaw-owned Codex home
([runtime checks](https://github.com/openclaw/openclaw/blob/9cc4450e9d79a993a51dc6fa362468f46c6f1819/extensions/codex/src/app-server/thread-lifecycle-adoption.ts#L187-L300)).

Retained Gateway state and Harness rollouts do not guarantee session recovery
or continuation of interrupted turns. OCE's end-to-end dedicated restart
acceptance remains incomplete.

## Optional sandbox provisioning

A [SandboxDriver](drivers/sandbox.md#overview) requires bundled Kubernetes
Compute, which retains ownership, identity, gateway, and routing while the Driver
provisions the dedicated Harness. Dedicated native OpenClaw requires this and
all three [facets](drivers/sandbox.md#containment-facets) (`networking`,
`filesystem`, `process`). Without a qualifying SandboxDriver, `GET /installation`
omits `capabilities.nativeWorkers`, and deploy and new provisioning requests answer
`409 RESOURCE_CONFLICT` naming the missing Driver. `GET /installation` always
reports `capabilities.openclaw.executionModes`, the OpenClaw modes an Agent can
deploy in, plus `sandboxDriverUnavailable: true` during a Driver outage. The Console
refuses an unlisted mode before any write. Queued provisioning work waits for the
Driver as for an outage.
There is no command-level `exec` facet or per-tool sandbox admission.

The bundled [OpenShell implementation](drivers/openshell-sandbox.md) supports
externally contained dedicated Codex and native OpenClaw with its admitted
configuration. Its paired Credential Gateway supplies the model key. OpenShell must
support the app-server token Secret reference and projected workload identity
the admitted workload requires; stock OpenShell incompatibilities fail
explicitly, and test bridges do not establish turnkey production support. See its
[qualification contract](drivers/openshell-sandbox.md#qualification-contract).

### Native worker support

Dedicated native OpenClaw needs enforced worker placement
(`cloudWorkers.requiredProfile`) and node-local inference. Compute renders the
models and environment SecretRefs in canonical node `models.providers`
configuration; there is no separate node inference-config setting.
The pinned [runtime image](../../deploy/runtime/README.md) includes these
features, and OCC reports `capabilities.nativeWorkers.support: "pinned-runtime"`
from `GET /installation`. In the Console, select OpenClaw, expand Runtime
details, and choose Dedicated. Create Agent then starts the same provisioning
workflow used by dedicated Codex; no startup override is required.

A custom image can declare
[`runtime.nativeWorkerSupport`](configuration.md#installation-startup-configuration). Without native-worker support, deploy and provisioning answer
`400 INVALID_REQUEST`, the Console withholds Dedicated OpenClaw, and retry
rechecks support.

## Related

- [Deploy your first Agent](../guides/first-agent.md)
- [Agent compute](../guides/topics/agent-compute.md)
- [ComputeDriver contract](drivers/compute.md)
- [ServiceAccount credentials](service-accounts.md)
- [Harness execution and shared storage flow](../flows/harness-execution-topology.md)
- [Implementation history](../../specs/README.md)
