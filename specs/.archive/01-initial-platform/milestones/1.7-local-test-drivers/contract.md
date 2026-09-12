# Feature Spec: Milestone 1.7 — Local Test Drivers: contract

[Spec overview](../1.7-local-test-drivers.md). Original record; decisions and status are preserved.

## Contract

### Driver-owned real-binary bootstrap

The selected `LocalTestComputeDriver` owns resolution, validation, and reuse of
both explicitly configured real executables. Its binary resolver initializes
once per Driver instance, before any gateway or workload starts, and retains its
resolved result. Driver operations await that one memoized initialization;
reconciliation never
downloads, copies, or repeatedly resolves either binary.

Pin Codex and OpenClaw independently by exact version; their default pins are
`0.147.0` and `2026.5.28`, respectively. Both explicitly configured executable
paths are mandatory. Validate each resolved path, executable permissions,
exact parsed version token, and runnable runtime; a version containing the
expected pin as a substring is not a match. For OpenClaw, confirm gateway
startup and readiness; `--version` alone cannot prove a launcher has its
required distribution or runtime files. Reject a missing, nonexecutable,
unavailable, wrong-version, or nonrunnable binary; never select `latest`, use a
bundled executable substitute, or discover a personal executable implicitly
through inherited `PATH`.

Every executable version probe has a bounded deadline. If a probe hangs,
terminate its child, confirm the child exits, reject runtime startup, and allow
Driver shutdown to complete without retaining the probe process.

Execute each Codex and OpenClaw version check, readiness probe, and runtime
launch from its own fresh, empty, scope-owned working directory. OpenClaw reads
`cwd/.env`, so an isolated environment without an isolated working directory can
still inherit personal credentials.

The resolved configuration contains both executable paths and their verified
versions. The Harness descriptor versions the Harness implementation, not the
Codex executable; define its compatible Codex pin separately and preserve the
independent OpenClaw pin. Installation bootstrap remains OCC-owned.

### Namespace gateway lifecycle

`ensureNamespace` starts or reuses exactly one OpenClaw gateway for its exact
Namespace using the provisioned OpenClaw executable. The gateway owns one
Namespace-local loopback endpoint and isolated state directory. Report
`namespaceReady` and `gatewayReady` only after that same process is healthy and
its exact ownership and runnable gateway readiness are verified. Concurrent
requests for the same Namespace share one in-flight launch; retries reuse its
verified gateway. Reject unsafe Namespace ID path components before creating
directories or starting processes. Cross-Namespace process adoption and
ambiguous ownership fail closed.

Each gateway receives an isolated Namespace-owned OpenClaw configuration with
mode `0600` and `gateway.controlUi.enabled=false`. Disabling the public control
UI and its catchall routes prevents direct loopback requests from bypassing the
parent authorization guard; `/readyz` remains public for readiness checks,
while workload routes require the Namespace's private gateway capability.

`deleteNamespace` stops only that Namespace's gateway, confirms its child has
exited, and then removes its routes, endpoint, and state. An already deleted
Namespace is successful. Agent deployment, replacement, retirement, and
deletion never start, replace, or stop the Namespace gateway. The gateway neither
authorizes platform operations nor assumes an Agent's identity.

### Revision workload and activation

`prepareRevision` requires the exact ready Namespace gateway, selected Compute
identity, compatible Harness, admitted immutable revision, and stable Agent
workload identity. Reject unsafe Namespace, Agent, or revision ID path
components before any filesystem effect. Start one supervised, idle Codex
harness process in a unique revision-owned directory. Record its exact
Namespace, Agent, and revision; concurrent preparations for that tuple share
one in-flight launch, and retries reuse only its exact process. A ready
prepared process accepts no Agent operations until OCC has committed it as the
active revision.

Inject a trusted, read-only `isRevisionActive(namespaceId, agentId, revisionId)`
resolver into the Driver. A Driver-owned loopback HTTP routing guard or proxy
runs in the parent process, not in either opaque child. For every request, it
verifies exact Namespace and Agent ownership, calls the resolver for the exact
revision, checks the corresponding prepared Codex process, and actually forwards
the authorized request to that Namespace's OpenClaw gateway and associated
workload. A lookup failure, inactive candidate, retired revision, foreign
Namespace, or stopped process rejects the request without forwarding. The
gateway and Codex child do not call OCC directly. This request-time check makes
the existing committed OCC pointer the sole activation authority; no worker
callback, route-enablement event, recovery scan, or new queue is required.

The proxy accepts only safe origin-form request paths and forwards exclusively
to the fixed, exact Namespace gateway origin. Absolute, protocol-relative,
authority-form, or malformed request targets are rejected before forwarding and
cannot redirect the internal capability to another origin. The proxy removes
caller-supplied `Authorization`, `Cookie`, and hop-by-hop headers, then
authenticates to OpenClaw using a fresh, random, Namespace-specific internal
`OPENCLAW_GATEWAY_TOKEN`. The OpenClaw child receives only its own capability
and rejects unauthenticated direct loopback requests, preventing callers from
bypassing the parent-process guard. This internal capability is not a personal
credential, provider credential, or reusable platform secret; it is absent from
arguments, logs, and observable snapshots.

`retireRevision` terminates only that revision's process, confirms its child
has exited, and then removes its route and temporary directory. Preparation
failure leaves the previous active process available. If retirement succeeds
before activation fails, requests fail closed because the old process is gone
and the candidate is not active. Sibling Agents and their shared Namespace
gateway remain unaffected.

### Process identity and credential isolation

Build gateway and workload child environments from an explicit allowlist, never
from `...process.env`. Use isolated scope-specific `HOME`, working,
configuration, cache, and state directories; assign each Codex revision its own
`CODEX_HOME`. Every probe and launch receives a fresh, empty, scope-owned `cwd`;
never run either executable from a checkout or inherited working directory.
Launch resolved absolute executables and expose only the minimal required
system runtime paths, explicitly configured broker endpoints, and the
OpenClaw gateway's own Namespace-specific internal capability.

Exclude personal Codex and OpenClaw sessions, inherited provider or cloud API
keys, browser credentials, controller bearer tokens, GitHub tokens, SSH-agent
sockets, and reusable provider credentials from child environments, files,
arguments, and logs. Disable ambient credential-store fallback or refuse to
launch when it cannot be excluded. Test containment is a local test boundary, not
production sandbox or Kubernetes identity enforcement.

### Test-only build and shutdown boundary

The production controller's `apps/controller/tsconfig.json` explicitly excludes
`src/drivers/compute/local-test/**`; release output cannot contain the local
Driver. `apps/controller/tsconfig.local-test.json` independently typechecks that
subtree with the shared strict settings and `noEmit: true`.

Driver `close()` first rejects new gateway and workload starts, drains every
already-running Namespace or revision operation, and then stops all resulting
children before removing their state. Once shutdown completes, no in-flight
operation can launch or leave behind a process.

