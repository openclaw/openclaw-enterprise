# Integration tests outside automatic CI

These integration files have no automatic workflow entrypoint.
A green `CI Required` check does not establish their coverage. This inventory describes workflow selection, not
local or hosted test results.

## Manual Full Integration lanes

These ten files run only when selected in
[Full Integration](../../.github/workflows/full-integration.yml), using the listed
lane or `all`. Model/service lanes require configured credentials and infrastructure.
`helper-timeout` is separate because it spends five minutes testing the helper deadline.

| Lane               | Integration test file                                                                                                  | Coverage absent from automatic CI                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-model`     | [docker-compute-real.test.mjs](../../tests/integration/docker-compute-real.test.mjs)                                   | Docker Compose deployment and real embedded OpenClaw/dedicated Codex model turns.                                                                                 |
| `k3d-model`        | [harness-topology-k3d-real.test.mjs](../../tests/integration/harness-topology-k3d-real.test.mjs)                       | Dedicated Codex continuity across Pod replacement and embedded model turns with persisted credentials or the Secret API.                                          |
| `k3d-model`        | [local-first-agent-real.test.mjs](../../tests/integration/local-first-agent-real.test.mjs)                             | Fresh local Agent deployment and reuse with real model replies; external changes block credential replacement.                                                    |
| `gateway-routing`  | [harness-topology-k3d-routing-real.test.mjs](../../tests/integration/harness-topology-k3d-routing-real.test.mjs)       | Dedicated Codex consumption of workspace files through the real Envoy/OCC route.                                                                                  |
| `production-tui`   | [production-tui-k3d-real.test.mjs](../../tests/integration/production-tui-k3d-real.test.mjs)                           | Helm-installed production control plane, interactive TUI, and revision cutover.                                                                                   |
| `slack`            | [harness-topology-k3d-slack-real.test.mjs](../../tests/integration/harness-topology-k3d-slack-real.test.mjs)           | Real Slack ingress and a gateway-authored reply through the approved proxy and Codex Agent.                                                                       |
| `provider-account` | [service-account-driver-real.test.mjs](../../tests/integration/service-account-driver-real.test.mjs)                   | Actual ChatGPT service-account creation, credential delivery, and a dedicated Codex model turn.                                                                   |
| `openshell`        | [sandbox-driver-openshell-k3d-real.test.mjs](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)       | Provider-owned dedicated Codex Harness and real OpenShell sandbox enforcement.                                                                                    |
| `openshell`        | [local-first-agent-openshell-real.test.mjs](../../tests/integration/local-first-agent-openshell-real.test.mjs)         | The first-Agent command with dedicated Codex in OpenShell and the Compose control plane: real model replies, OpenShell routing, and CredentialSource-only access. |
| `openshell`        | [local-first-agent-openshell-k3d-real.test.mjs](../../tests/integration/local-first-agent-openshell-k3d-real.test.mjs) | The same first-Agent proof with the API, worker, and PostgreSQL in k3d instead of Compose.                                                                        |
| `helper-timeout`   | [dev-up-timeout.test.mjs](../../tests/integration/dev-up-timeout.test.mjs)                                             | Full 300-second readiness deadline for a running but unready worker.                                                                                              |
| `k3d-otel`         | [harness-topology-k3d-otel-real.test.mjs](../../tests/integration/harness-topology-k3d-otel-real.test.mjs)             | Actual OTLP logs emitted during embedded and dedicated runtime model turns.                                                                                       |

## No GitHub workflow entrypoint

[dev-up-k3d-real.test.mjs](../../tests/integration/dev-up-k3d-real.test.mjs)
belongs to the CLI-only `dev-up-k3d` lane, outside both workflow groups and
Full Integration dispatch. See [run the local installation lane](README.md#run-the-local-installation-lane).

[repository-credentials-k3d-real.test.mjs](../../tests/integration/repository-credentials-k3d-real.test.mjs)
belongs to the explicitly selected `repository-credentials-installed` CLI lane,
excluded from both workflow groups and Full Integration dispatch. The lane is
temporarily refused until its remote cleanup is safe; see
[qualify an installed Agent against GitHub](repository-credentials-platform.md#qualify-an-installed-agent-against-github).

[repository-credentials-live.test.mjs](../../tests/integration/repository-credentials-live.test.mjs)
belongs to the `repository-credentials-live` lane, excluded from both workflow
groups and Full Integration dispatch. Follow the
[repository credential qualification guide](repository-credentials.md) for the
authorized disposable repository, protected service setup, and cleanup. The
automatic container lane exercises controlled provider behavior and separate
container credential isolation. A passing run establishes only selected checks
at its recorded source and images, not installed platform or live-provider qualification.

[postgres-azure-workload-identity.test.mjs](../../tests/integration/postgres-azure-workload-identity.test.mjs)
belongs to the `postgres-azure-workload-identity` lane, excluded from the `ci`
and `full` groups and Full Integration dispatch. Follow the
[Azure PostgreSQL test procedure](postgresql.md#azure-workload-identity-connections)
for private input setup and result handling. Ordinary constructor,
security-rejection, and password cases in
[postgres-connection-auth.test.mjs](../../tests/integration/postgres-connection-auth.test.mjs)
run in the mandatory `postgres-platform` lane.

[ssh-compute-real.test.mjs](../../tests/integration/ssh-compute-real.test.mjs) belongs
to the `ssh-host` lane, excluded from the `ci` and `full` groups and
Full Integration dispatch. No workflow provisions its disposable Linux/systemd
SSH host or invokes the lane. The readiness-only selector proves real-host
readiness, revision cutover, state isolation/persistence, and deletion without
a model call. The optional `OCC_TEST_SSH_MODEL=1` selector adds
[real provider execution and runtime credential proof](ssh.md#runtime-credential-model-proof).
Follow [SSH raw hosts](ssh.md#ssh-raw-hosts) for the disposable host, required
environment settings, and direct test command.

See [GitHub Actions testing](ci.md) for the automatic lanes and result accounting.
