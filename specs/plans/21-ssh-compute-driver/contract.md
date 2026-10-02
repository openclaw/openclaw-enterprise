# Feature Spec: SSH Compute Driver for raw hosts: contract

[Spec overview](index.md). Original record; decisions and status are preserved.

## Contract

### Selection and configuration

Trusted Installation YAML selects the driver by its reserved bundled id. The
closed configuration schema is:

```yaml
drivers:
  compute:
    id: compute-ssh
    configuration:
      ssh:
        identityFile: /etc/openclaw/ssh/id_ed25519
        knownHostsFile: /etc/openclaw/ssh/known_hosts
        connectTimeoutSeconds: 10
      hosts:
        stable:
          address: 203.0.113.10
          port: 22
          user: root
          nodePath: /usr/bin/node
          openclawPath: /opt/openclaw/current/dist/index.js
      runtime:
        nodePath: /usr/bin/node
        openclawPath: /opt/openclaw/current/dist/index.js
        user: openclaw
        root: /var/lib/openclaw-enterprise
        systemdUnitDirectory: /etc/systemd/system
      network:
        gatewayPortRange:
          start: 18800
          end: 18899
```

| Setting                                    | Rule                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `ssh.identityFile`, `ssh.knownHostsFile`   | Required absolute paths on the worker. The client runs with `BatchMode=yes`, `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes`. |
| `ssh.connectTimeoutSeconds`                | Optional positive integer, default `10`.                                                                                        |
| `hosts.<name>`                             | Keyed by exact platform Namespace name. `address` required; `port` optional (default `22`); `user` required.                    |
| `hosts.<name>.nodePath` / `openclawPath`   | Optional absolute overrides of the shared `runtime` paths for that host.                                                        |
| `runtime.nodePath`, `runtime.openclawPath` | Required absolute host paths. The driver never installs, downloads, or builds either.                                           |
| `runtime.user`                             | Required host account that runs every gateway. Must exist on each host.                                                         |
| `runtime.root`                             | Required absolute state root. Default recommendation `/var/lib/openclaw-enterprise`.                                            |
| `runtime.systemdUnitDirectory`             | Optional absolute path, default `/etc/systemd/system`.                                                                          |
| `network.gatewayPortRange`                 | Required inclusive range; `1024 <= start <= end <= 65535`. Ports are allocated per host from this range.                        |

Paths must be absolute and contain no whitespace, quotes, or control characters
because they are passed as SSH command tokens. The SSH `user` must be able to
write the state root and unit directory and run `systemctl`; the first
implementation documents `root` and does not add `sudo` handling. Unknown keys
fail startup, like every other Driver schema.

The production-only Kubernetes checks in Installation composition (immutable
image digests, explicit Codex runtime, projected ServicePrincipal credentials)
apply only when the bundled Kubernetes Driver is selected. `drivers.secret`
remains required by the existing Installation contract; the SSH Driver never
consumes it. `drivers.sandbox` with `compute-ssh` fails startup.

### Transport and host helper

The worker executes the system `ssh` binary with explicit options and no
interactive fallback:

```text
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<knownHostsFile>
    -o IdentitiesOnly=yes -i <identityFile> -o ConnectTimeout=<seconds> -o LogLevel=ERROR
    -p <port> -l <user> <address> -- <nodePath> - <base64 operation>
```

The remote program is `apps/controller/src/drivers/compute/ssh/remote-helper.cjs`,
a self-contained CommonJS script read by the driver at import time and sent on
the SSH standard input. The operation is one JSON document encoded as base64 in
the final argument, so no shell quoting of operator data ever occurs. The helper
writes one JSON result line to standard output and exits nonzero on failure with
a sanitized message. Every operation carries the driver id, implementation, and
the exact Namespace, Agent, ServicePrincipal, and revision identities it may
touch; the helper refuses any host object whose recorded ownership differs.

Each SSH invocation is bounded by a timeout and by the current compute operation
signal from `operation-context.ts`; cancellation terminates the `ssh` child.
Because a closed session does not signal the remote process, the helper writes a
heartbeat line every second, exits when that write fails, and enforces its own
deadline below the transport timeout; the driver parses only the final result
line. The
transport is an internal constructor seam (`executor`) so conformance tests can
run the identical helper locally without SSH. Installation YAML cannot supply it.

### Host layout and ownership

Everything the driver owns lives under `runtime.root`; hashes are the first 12
hex characters of SHA-256 of the exact platform id, matching the other drivers.

```text
<root>/namespaces/<nsHash>/namespace.json                   ownership marker
<root>/namespaces/<nsHash>/agents/<agentHash>/agent.json    ownership, port, servicePrincipalId
<root>/namespaces/<nsHash>/agents/<agentHash>/home/         HOME for the gateway process
<root>/namespaces/<nsHash>/agents/<agentHash>/state/        OPENCLAW_STATE_DIR (persists across revisions)
<root>/namespaces/<nsHash>/agents/<agentHash>/gateway.env   driver-written OPENCLAW_GATEWAY_TOKEN (token mode only)
<root>/namespaces/<nsHash>/agents/<agentHash>/env           operator-provided credentials; never written by the driver
<root>/namespaces/<nsHash>/agents/<agentHash>/revisions/<revHash>/openclaw.json   immutable admitted document
<root>/namespaces/<nsHash>/agents/<agentHash>/revisions/<revHash>/revision.json   revision id, number, configuration hash, harness
<root>/namespaces/<nsHash>/agents/<agentHash>/current -> revisions/<revHash>       activation pointer
<root>/namespaces/<nsHash>/agents/<agentHash>/served.json                          revision whose restart last reached readiness
<systemdUnitDirectory>/openclaw-enterprise-gateway-<agentHash>.service
```

Host-wide serialization is a kernel `flock(2)` on `<root>/.compute-lock`, held by
a `sh -c 'read'` child of the helper whose stdin is the helper; any helper exit
closes that pipe and releases the lock, so no stale-lock reclamation exists.
`home/` and `state/` are owned by `runtime.user` with mode `0700`; JSON markers
and `gateway.env` are `0600`; the snapshot stays owned by the SSH account with
mode `0640` and the runtime account's group so the gateway cannot rewrite it.
Writes use a temporary file and rename.
The `current` symlink is replaced atomically. Files are never adopted: a marker
with different ownership, a snapshot whose configuration hash differs from the
admitted revision, or a unit file not carrying the driver's ownership header is
an error, not a repair.

The systemd unit contains, per Agent:

```ini
[Unit]
Description=OpenClaw Enterprise gateway <agentId>
# openclaw-enterprise namespace=<namespaceId> agent=<agentId>
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<runtime.user>
WorkingDirectory=<agentDir>/state
Environment=HOME=<agentDir>/home
Environment=OPENCLAW_STATE_DIR=<agentDir>/state
Environment=OPENCLAW_CONFIG_PATH=<agentDir>/current/openclaw.json
Environment=OPENCLAW_GATEWAY_PORT=<port>
EnvironmentFile=<agentDir>/gateway.env        ; omitted for native trusted-proxy auth
EnvironmentFile=-<agentDir>/env
ExecStart=<nodePath> <openclawPath> gateway --port <port>
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

The gateway reads the admitted document through the `current` pointer, so the
unit is stable across revisions and only its restart changes the served
snapshot. Gateway logs go to journald under the unit name. The driver sets no
`OPENCLAW_LOG_LEVEL`; the admitted document already carries the platform-owned
logging settings stamped at admission.

### Lifecycle operations

- `preflight()` verifies the local identity and known-hosts files exist, then
  probes every configured host: SSH reachability, `systemctl --version`,
  `nodePath` executable, `openclawPath` readable, and `runtime.user` resolvable.
  Any failure stops production startup with the offending host named.
- `ensureNamespace(namespace)` maps `namespace.name` to a configured host. An
  unmapped name returns `namespaceReady: false, failure: "permanent"`. The helper
  creates or verifies the Namespace marker and directory. SSH transport failures
  are `retryable`. Success records the Namespace-to-host binding in driver memory
  and runs `afterNamespacePrepared`.
- `bindAgent({ namespace, agent })` records the Namespace-to-host binding (the
  worker calls it before every revision operation) and the Agent's exact
  ServicePrincipal. A revision for an unbound Namespace fails closed.
- `prepareRevision(revision, context)` requires `harness.id === "openclaw"` and
  `harness.mode === "embedded"`; other topologies throw a configuration failure
  with a `TODO` naming dedicated Codex as deferred. A nonempty
  `context.secretEnvironment` throws: OCC Secret delivery is not implemented for
  hosts, and the message names the operator env file instead. The helper then:
  1. verifies the Namespace marker and creates or verifies `agent.json`,
     allocating the lowest free port in the range across every Agent on that
     host and generating `gateway.env` unless the admitted document selects
     `gateway.auth.mode: "trusted-proxy"`;
  2. writes the revision snapshot and `revision.json`, refusing an existing
     snapshot whose configuration hash differs;
  3. returns `ready: false` without effects when `current` already points at a
     higher revision number (a superseded candidate, matching Docker);
  4. renders the unit, rewrites it only when content changed, runs
     `systemctl daemon-reload` and `enable`;
  5. returns `ready: true` immediately when `current` already points at this
     revision, `served.json` records it, and the unit is active and `/readyz`
     answers 200;
  6. otherwise replaces `current`, runs `systemctl restart`, polls
     `http://127.0.0.1:<port>/readyz` for up to 120 seconds, and records
     `served.json` only after readiness. Success returns `ready: true`; timeout
     or an inactive unit throws, and the worker retries under its normal
     attempt budget. An interruption between the pointer flip and the restart
     therefore forces a restart on retry rather than a false acceptance.
     Replacement therefore causes a bounded restart of that Agent's gateway. This
     is the same limitation the Kubernetes Driver documents for its `Recreate`
     rollout, recorded here explicitly.
- `activateRevision(revision)` verifies ownership, that `current` resolves to
  the exact revision, that the unit is active, and that `/readyz` answers. It is
  idempotent and performs no cutover of its own.
- `deactivateRevision(revision)` verifies ownership and returns. The worker
  invokes it only for dedicated topologies, which this driver rejects at
  preparation; it exists to satisfy the production structural requirement.
- `retireRevision(revision)` runs `beforeWorkloadStop`, verifies ownership, and
  removes that revision's snapshot directory. When `current` still resolves to
  the retired revision, the helper stops and disables the unit and removes the
  pointer first, matching Docker's removal of a gateway still labelled with the
  retired revision. Agent state, home, env files, and other revisions remain.
- `deleteNamespace(namespace)` runs `beforeNamespaceDelete`, then for every
  owned Agent on the host stops and disables its unit, removes the unit file,
  reloads systemd, and removes the Namespace directory including Agent state.
  Foreign markers are refused; a missing directory is already deleted.

Errors from ownership or configuration violations are permanent; transport,
timeout, and unexpected helper failures are retryable, matching the Docker
Driver's classification.

### Credentials and boundaries

The worker holds only the SSH private key. Hosts never receive controller
credentials, database access, or Installation YAML. The driver writes exactly
one credential, the per-Agent gateway token, and reads none. Model and channel
credentials are operator-owned lines in `<agentDir>/env`, consumed by the native
document through ordinary `env` SecretRefs; systemd reads that file as root, so
it can stay `root:root 0600`. Native Configuration must not contain plaintext
credentials, exactly as for other drivers. The driver does not gate channel
providers: any provider the operator's OpenClaw build supports may be enabled in
embedded mode, and the reference states that the channel isolation the
Kubernetes Driver enforces through dedicated execution does not exist here.

