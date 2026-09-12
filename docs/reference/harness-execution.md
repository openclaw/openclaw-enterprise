# Harness execution

An Agent selects an execution mode; its native Configuration selects a supported
Harness. OCC admits the pair into an immutable AgentRevision. The selected
Compute Driver owns realization, activation, and retirement. This reference
defines supported selection and execution behavior; the
[Harness flow](../flows/harness-execution-topology.md) traces its implementation.

## Supported topology

| Harness  | Agent execution mode | Workloads                                                        |
| -------- | -------------------- | ---------------------------------------------------------------- |
| OpenClaw | `embedded`           | One Agent-owned gateway executes the built-in Harness.           |
| Codex    | `dedicated`          | An Agent-owned gateway connects to a separate dedicated Harness. |

Agent creation defaults to `embedded`; an update preserves the existing mode
when omitted. Unsupported Harness/mode pairs are rejected before work is admitted.
A Harness is a server-approved descriptor rather than a user-created resource or
independently selected Driver. Runtime availability and containment additionally
depend on the selected Compute and optional Sandbox implementation.

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

Deployment authorizes the exact Agent, its Configuration, and any associated
ServiceAccount. A selected SandboxDriver may transform a copy of the native
configuration before validation and admission. The stored source Configuration
is unchanged; the revision freezes the admitted document, source Configuration
identity and generation, approved Harness identity/version, execution mode,
Compute identity, and any selected sandbox or account binding.

Admission also stamps the platform-owned native logging settings after any
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

## Runtime logging

For level changes, collection, and backend verification, use the
[observability guide](../guides/observability.md).

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

A replacement can be prepared while its predecessor serves. Guarded activation
publishes the replacement before the prior revision is retired, and retries
cannot allow an older operation to overwrite a newer active revision. OCC records
one active revision and routes new requests to it during normal reconciliation.
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
upstream gateway must support the exact Secret references and projected workload
identity required by the admitted workload. Stock OpenShell incompatibilities
fail explicitly; test bridges do not establish turnkey production support.
There is no current command-level `exec` facet or per-tool sandbox admission.
See [SandboxDriver](drivers/sandbox.md) and [OpenShell](drivers/openshell-sandbox.md)
for the complete capability and upstream compatibility boundaries.

## Related

- [Deployment](../guides/deploy.md)
- [ComputeDriver contract](drivers/compute.md)
- [ServiceAccount credentials](service-accounts.md)
- [Harness execution and shared storage flow](../flows/harness-execution-topology.md)
- [Implementation history](../../specs/README.md)
