# Feature Spec: Common OpenTelemetry logging: contract

[Spec overview](../20-common-otel-logging.md). Original record; decisions and status are preserved.

## Contract

### Configuration ownership

Add one optional closed block to the operator-owned startup YAML selected by `OCC_CONFIG_PATH`:

```yaml
logging:
  level: info
```

`level` accepts `debug`, `info`, `warn` or `error`, defaults to `info`, and is shared by API, worker and scripts. Invalid or unknown keys fail startup with safe diagnostics. This is startup configuration, not a persisted Installation field or API resource. Development setup passes the same file to these processes; its no-file path uses the same default.

Operators configure export directly in standard Collector YAML mounted by Compose or Helm. The Collector alone receives exporter secrets and TLS material; it never receives the Installation file. Use OTLP HTTP/protobuf with HTTPS and verified server identity, allowing plaintext only for an explicitly local development/test receiver. Export is opt-in through deployment configuration; local output works without a Collector. Endpoint/auth changes require Collector reconfiguration only.

### Emission and runtime settings

| Component | Managed output and settings |
| --- | --- |
| OCC API/worker/scripts | Shared Pino factory, Fastify `loggerInstance` and worker `emit` adapter. JSON records carry timestamp, severity, event and available request/work/resource identity. CLI diagnostics use stderr when stdout is a machine protocol. |
| OpenClaw gateway | Native `logging.level` and `logging.consoleLevel` equal the common level; `logging.consoleStyle=json`; `diagnostics.otel.logs=false`. Clear conflicting `OPENCLAW_LOG_LEVEL`, omit verbosity flags and keep source secret redaction enabled. |
| Dedicated Codex | Derive `RUST_LOG=<level>,codex_otel=off` and `LOG_FORMAT=json` from the admitted gateway level. Supply host-owned app-server overrides `-c 'otel.exporter="none"'` and `-c 'otel.log_user_prompt=false'`. Collect stderr only; stdout is protocol output. Preserve `CODEX_HOME` and authentication. |

OCC emits one HTTP completion record with generated request ID, route template, method, status and duration, plus a diagnostic for an unexpected error. Worker results include work identity, attempt, operation, result and bounded error code. Sanitize before writing; do not serialize request/reply objects, credentials, query strings or provider payloads. Preserve safe public errors and independently configured non-log runtime signals.

Source contracts: [gateway console](https://github.com/openclaw/openclaw/blob/2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4/src/logging/subsystem.ts#L240-L260), [Codex JSON/filter layers](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/src/lib.rs#L647-L679), [content-bearing Codex events](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/otel/src/events/session_telemetry.rs#L1101-L1147). JSON formatting and `log_user_prompt=false` alone do not establish content safety.

### Admission and updates

Pass the typed level through `ControllerOptions`. In [deployAgent](../../packages/occ/src/index.ts), stamp the native gateway fields after `sandbox.configureAgent` and before validation/revision creation. Override tenant values only for platform-owned logging controls; preserve the stored Configuration and unrelated fields. Existing `AgentRevision.configuration` / `admitted_spec.draft_spec` stores the policy without a new field or migration.

Docker and Kubernetes renderers consume only this snapshot, require its two native levels to agree, and directly configure both runtime roles. Pass the level into Kubernetes `deployment()` and propagate generated Codex environment through existing OpenShell workload requirements. Lifecycle hooks cannot transport this policy: their values are opaque placeholders and dedicated gateways do not receive them consistently.

Reserve `RUST_LOG`, `LOG_FORMAT` and native log-export controls against tenant SecretBindings and lifecycle overrides, including the `OTEL_` prefix alongside already reserved `OPENCLAW_`/`CODEX_` controls. Reject collisions at admission and rendering. External Drivers must implement the same launch contract before claiming support.

Restarting OCC applies the new level to API/worker; an authorized deploy creates a new revision to apply it to gateway/Codex. Recreating an admitted revision retains its saved level. A revision without these fields requires a fresh deploy before recreation under the new renderer; existing workloads keep running. Document this redeploy requirement during rollout.

### Collection and privacy

Use one collection route per process output. Kubernetes uses a pinned Collector DaemonSet with CRI file parsing, restricted read-only mounts and metadata RBAC; reuse an existing cluster Collector if it already owns those files. Include startup/init-container records and persist read offsets. Docker uses Engine `fluentd` forwarding for both Compose services and [Driver-created containers](../../apps/controller/src/drivers/compute/docker/index.ts), with an Engine-reachable private Collector Fluent Forward receiver. It has no TLS/auth; do not expose it externally. Verify connectivity from the Docker VM rather than assuming container DNS works from the Engine.

Collector configuration maps supported Pino/gateway/Codex JSON into OTel timestamp, severity, body and attributes. Map severity explicitly. Derive `service.name` (`occ-api`, `occ-worker`, `openclaw-gateway`, `codex-app-server`), version and Enterprise scope from operator configuration and protected container/Pod metadata; payload fields cannot override identity or destination. Request/work IDs remain attributes; native trace/span fields require valid existing context.

Remote export permits reviewed operational metadata and message classes only. Omit content-bearing fields/targets and unclassified text; scrub known sensitive values and count dropped records. Bound records to 32 KiB and drop malformed/oversized input without unbounded buffering. Preserve bounded operator-restricted local logs for troubleshooting. Do not additionally ingest native exporters, runtime files, stdout protocol streams, HOME, sessions, workspaces or auth stores. Collector credentials and state remain inaccessible to tenants.

Use standard Collector queues, retries and self-telemetry with finite memory/disk limits. Docker forwarding uses async connection, nonblocking delivery, finite buffering and a write timeout; retain a bounded local cache. Collector output must not depend on its own forwarding route. Export outages and overflow may lose logs but cannot block API/reconciliation or weaken audit persistence. Forward SIGTERM to runtime children and drain owned buffers within the existing termination budget. Collector egress alone reaches the exporter; preserve workload network denies. [Docker transport](https://docs.docker.com/engine/logging/drivers/fluentd/), [Collector receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/6fb0fc4220a07a4ef6c727b6d472c741f5693f6d/receiver/fluentforwardreceiver/README.md), [resilience](https://opentelemetry.io/docs/collector/resiliency/).

