# Harness execution

A Harness calls the model and runs tools for an Agent. OpenClaw Enterprise supports
two: OpenClaw runs inside the Agent's gateway; Codex runs in a separate
workload connected to that gateway. You choose an execution mode on the Agent
and a compatible model and Harness in its Configuration.

This page explains supported combinations, model authentication, and what a
replacement can interrupt. For the infrastructure choices, see
[Agent compute](../guides/topics/agent-compute.md). To get a first model
response, follow [Deploy your first Agent](../guides/first-agent.md).

## Supported topology

| Harness  | Agent execution mode | Workloads                                                        |
| -------- | -------------------- | ---------------------------------------------------------------- |
| OpenClaw | `embedded`           | One Agent-owned gateway executes the built-in Harness.           |
| Codex    | `dedicated`          | An Agent-owned gateway connects to a separate dedicated Harness. |

Agent creation defaults to `embedded`; an update preserves the existing mode
when omitted. Unsupported Harness/mode pairs are rejected before work is admitted.
You cannot create a Harness or select it as a separate Driver. Availability
and isolation also depend on the installation's Compute and optional Sandbox.
Kubernetes places a dedicated Gateway in an OCC-managed control-plane runtime
namespace with its own private storage and ServiceAccount. Its Harness stays in
the data-plane namespace. Embedded OpenClaw remains one untrusted data-plane
workload; it cannot move independently of its built-in Harness.

## Native runtime selection

The selected native model uses a `provider/model` name. Its supported
`agentRuntime.id` is `openclaw` or `codex`; OCC considers model-specific,
Agent-entry, and provider policy. Conflicting explicit policies are rejected,
rather than silently selecting one. All configured Agent entries must resolve
to the same primary model and Harness.

Without any model candidate the current resolver selects OpenClaw. For an
unambiguous built-in provider without custom provider or plugin routing, absent
runtime policy also selects OpenClaw. The `openai` and `codex` providers,
explicitly configured providers, and plugin-routed providers require an explicit
supported runtime policy.

Dedicated Codex accepts the native `codex` provider. It also accepts `openai`
when the Codex plugin is explicitly enabled and its app-server transport is
`websocket`. Other Codex provider selections are rejected.

Selectable model catalogs under Agent defaults or entries may include additional
models only when they retain the selected provider and an explicit matching
Harness runtime. Model fallbacks under defaults or Agent entries must retain
the primary provider and resolve through the same policy checks to the same
Harness. A provider's native `models` array is limited to the resolved primary
and fallback models. Nonempty native `agents.list` configurations remain
unsupported. Admission preserves the fallback order in the immutable revision;
it does not implement fallback execution or allow changing topology.

## Admission and immutable execution

Deployment authorizes the exact Agent, its Configuration, and its selected
managed harness credential source, when present. A selected SandboxDriver may transform a copy of the native
configuration before validation and admission. The stored source Configuration
is unchanged; the revision freezes the admitted document, source Configuration
identity and generation, approved Harness identity/version, execution mode,
Compute identity, and any selected sandbox or account binding.

With the default Compute logging ownership, admission stamps the platform-owned
native logging settings after any
SandboxDriver transformation and before validation. The frozen AgentRevision
contains `logging.level`, matching `logging.consoleLevel`, JSON console style,
and disabled native OTLP log export. Runtime-owned console and tool redaction
remain enabled by the gateway and Codex runtime; the admitted native
Configuration does not carry the retired `logging.redactSensitive` key. Later
edits to the source Configuration or to OCC startup `logging.level` cannot mutate
that snapshot; deploy the Agent again to create a new revision with a changed
runtime level.

Later edits affect a future explicit deployment. The worker checks the admitted
combination and exact ownership before runtime effects. Unsupported combinations,
revoked authority, or a missing required Driver fail closed. See
[Agents](agents.md), [Configuration](configuration.md), and
[controller reconciliation](controller.md) for their respective ownership and
queue guarantees.

## Harness authentication

The Agent's [harnessAuth binding](agents.md#harness-authentication) is the sole
model-auth selector. Kubernetes supports these combinations:

| Binding                        | Topology          | Credential consumer                                                                                               |
| ------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `api_key` with an OCC Secret   | Embedded OpenClaw | Combined gateway/Harness receives `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, selected by its native model provider. |
| `api_key` with an OCC Secret   | Dedicated Codex   | Only Codex receives `OPENAI_API_KEY` and logs in through stdin.                                                   |
| `codex_pat` with an OCC Secret | Dedicated Codex   | Only Codex receives `CODEX_ACCESS_TOKEN`; native login validates its account identity.                            |
| `chatgpt_service_account`      | Dedicated Codex   | Only Codex receives the account token and forced workspace.                                                       |
| `credential_source`            | Dedicated Codex   | Codex receives only a placeholder; the Sandbox egress proxy inserts the key from the Credential Gateway.          |

Kubernetes workload rendering prepares one explicit login mode and exact Secret
projections. The selected Sandbox consumes the same already-rendered workload
requirements. It does not resolve a second credential source.

A [`credential_source`](credential-sources.md) binding requires a selected
Credential Gateway, the paired OpenShell Sandbox, dedicated Codex, and a source
type whose Harness authentication is OpenAI `api_key`. Compute projects no model
Secret; it sets `CODEX_LOGIN_MODE=api_key` and passes the gateway's attachments
to the Sandbox. The revision activates only after every attachment is `ready`.
While a Credential Gateway is selected, deployment rejects the Secret-backed and
account methods with `409`. Other Compute
implementations reject bindings they do not support. SSH embedded OpenClaw accepts
only `{ "method": "runtime" }`: systemd loads operator-provided host credentials,
and OCC checks gateway readiness without validating model authentication. Host
credential changes are outside revision immutability; see [SSH Compute](drivers/ssh-compute.md).
Kubernetes rejects `runtime`; its managed validation remains unchanged.

Codex rejects missing or conflicting runtime inputs before starting its app
server. After login, a bounded native model turn must succeed before the server
starts; local credential storage alone does not prove provider acceptance.
Login state stays in its
bounded ephemeral home. Gateway transport and workload identity credentials
remain separate. A dedicated gateway receives no model credential. Model auth
cannot be supplied through Configuration `secretBindings` or the initial runtime
credential API; those own gateway credentials and transport/channel setup.

Kubernetes embedded OpenClaw performs one bounded native model probe in the actual gateway
startup, for both initial and replacement deployments. Embedded activation uses
the shared gateway's `Recreate` strategy: cutover can stop the working gateway
before the replacement validates its credentials. Invalid credentials or a
provider failure leave the replacement unready and the Agent unavailable until
repair and restart or a new deployment. There is no automatic rollback.
Readiness polling does not repeat model calls.

Both startup checks call the configured primary model. OpenClaw disables tools
and model fallback. Codex ignores user configuration and rules, disables execution
and external tools, and uses read-only filesystem policy without approval grants;
a tool event cannot satisfy its success check. The Codex probe runs with a minimal
environment that keeps only the runtime's TLS trust variables (`SSL_CERT_FILE`,
`SSL_CERT_DIR`), so a TLS-inspecting egress proxy can serve it. Each probe has a process timeout
and captures native output, emitting only a fixed failure message if unsuccessful.
A failed Codex probe also holds the process unready until restart.

These startup checks make provider requests and may incur model usage charges.
They do not verify access to every other configured model or guarantee continued validity
after upstream revocation. Embedded probe transport configuration must use
literal metadata rather than additional environment or Secret references. The
canonical `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` alias for the selected provider remains supported, and unrelated
gateway/channel configuration bindings remain separate.

The revision freezes the admitted source reference, not historical Secret bytes.
A managed account snapshot also retains its exact credential and verified private
Backend/workspace ownership. Later reconciliation cannot substitute a newly
issued account credential. Source updates require explicit deployment and a real
model turn to verify consumption; selected metadata does not establish readiness.
See [renewal and revocation](../guides/deploy/credential-lifecycle.md).

## Runtime logging

For level changes, collection, and backend verification, use the
[observability guide](../guides/observability.md).

A trusted ComputeDriver can instead declare deployment-managed runtime logging
for either new or adopted runtimes; see the
[logging design options](drivers/compute.md#runtime-logging-ownership). Admission
then preserves its native configuration without requiring the Driver to collect
logs. The following rendering policy applies to the default platform-owned path.

Compute renders logging from the admitted revision. Kubernetes mounts the
admitted native Configuration read-only under `/etc/openclaw`, with
`OPENCLAW_CONFIG_PATH` pointing at that document. Gateway containers receive
native JSON console logging at the admitted level and keep their own OTLP log
export disabled. Dedicated Codex app-servers receive `LOG_FORMAT=json`,
`RUST_LOG=<level>,codex_otel=off`, and host-owned `codex` configuration that
sets `otel.exporter="none"` and `otel.log_user_prompt=false`. Collector-based
export reads Codex stderr only; stdout remains protocol output.

Worker log attributes such as `work.id`, `work.operation`, `work.attempt`, and
`work.outcome` describe controller reconciliation. They do not define runtime
resource identity. The Collector derives `service.name`, version, container,
Namespace, Agent, and revision identity from protected container labels or Pod
metadata instead of trusting payload fields.

## Isolation and activation

Each deployed Agent owns its gateway. Embedded execution keeps the Harness in
that gateway; dedicated execution keeps the Harness separate and authenticates
the exact gateway-to-Harness connection. Credentials, workload identity, storage,
and permitted transport depend on the selected Driver and admitted topology.
The [Kubernetes security reference](security.md) defines its concrete credential
exceptions and enforcement limitations; Docker has its own narrower boundaries.

A replacement can be prepared while its predecessor serves. Embedded preparation
does not validate replacement credentials; its activation can interrupt service
as described above. Guarded activation publishes the replacement before the
prior revision is retired, and retries cannot allow an older operation to
overwrite a newer active revision. OCC records one active revision and routes
new requests to it during normal reconciliation.
Kubernetes Deployments do not guarantee a physical process singleton during node
partitions or manual replacement; see the
[gateway rollout limitation](drivers/kubernetes-compute.md#execution-modes).
The worker records one
activation audit when durable completion succeeds; recovery repeats safe effects
under the current claim. Exact ordering and failure handling are explained in
the [worker flow](../flows/controller-worker.md).

The pinned OpenClaw Codex plugin permits fresh remote work when OCC owns the
native process configuration, but it lacks a supported managed-remote resume path
for an existing ordinary session after gateway restart. Retained gateway session
state and persistent volume data prove storage continuity; they do not prove
continued native execution. Current dedicated restart acceptance remains
incomplete, and the existing ownership and persistence requirements remain. The
upstream restriction is documented in
[openclaw/openclaw@759e127](https://github.com/openclaw/openclaw/commit/759e127777b54426c922e8ab4c228523ddac04e9).

## Optional sandbox provisioning

The current optional SandboxDriver contract declares supported `networking`,
`filesystem`, and `process` facets. Startup requires bundled Kubernetes Compute
when a sandbox is selected. Compute retains platform ownership, identity, gateway,
and routing; a capable selected SandboxDriver can provision the dedicated Harness.

The bundled OpenShell implementation supports dedicated Codex. It configures
Codex for external containment instead of nested internal sandboxing. Its
paired Credential Gateway supplies the model key. The upstream gateway must still
support the app-server token Secret reference and projected workload identity
required by the admitted workload. Stock OpenShell incompatibilities
fail explicitly; test bridges do not establish turnkey production support.
There is no current command-level `exec` facet or per-tool sandbox admission.
See [SandboxDriver](drivers/sandbox.md) and [OpenShell](drivers/openshell-sandbox.md)
for the complete capability and upstream compatibility boundaries.

## Related

- [Deploy your first Agent](../guides/first-agent.md)
- [Agent compute](../guides/topics/agent-compute.md)
- [ComputeDriver contract](drivers/compute.md)
- [ServiceAccount credentials](service-accounts.md)
- [Harness execution and shared storage flow](../flows/harness-execution-topology.md)
- [Implementation history](../../specs/README.md)
