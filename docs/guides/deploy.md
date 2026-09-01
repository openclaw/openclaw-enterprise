# Deploy OpenClaw Enterprise

Choose development or production below. The setup command starts the control
plane, provisions an Agent, waits for its active revision, and opens the
OpenClaw terminal UI (TUI). Run commands from the repository root.

## Development

You need Node.js 24+, Docker Engine with Docker Compose, and an authorized
OpenAI model/key. The local worker controls Docker through its socket; use a
trusted development host. Choose a model your key can access.

```bash
# Load OPENAI_API_KEY into this shell using your credential manager.
node scripts/setup.mjs dev --model gpt-5.1
```

Setup builds the bundled runtime image if needed, starts Compose, retrieves the
bootstrap service credential privately, and deploys one embedded OpenClaw Agent.
The first run builds images and can take several minutes. No host dependency
installation, hand-written API requests, or copied gateway tokens are required.
Use `--runtime-image IMAGE` to select an existing compatible runtime image.

When the TUI opens, follow [Verify the conversation](#verify-the-conversation).
For unattended setup, add `--no-tui` and reconnect later with the command below.

## Production

Production requires an existing Kubernetes cluster with enforcing
NetworkPolicies, external PostgreSQL with separate application/migration roles,
approved controller/runtime image digests, RWO storage, and an HTTPS proxy for
the private OCC API. The chart does not provide the database or HTTPS endpoint.
You also need Node.js 24+, `kubectl`, Helm, and operator permissions to manage
Namespaces and the chart's ClusterRoles/ClusterRoleBindings, create namespaced
resources, read bootstrap output, and exec into the Agent gateway. See the
[required authority](../reference/setup.md#generated-configuration).

Prepare private files for the model key, kubeconfig, and both database URLs.
Then copy the configuration template into a private directory:

```bash
umask 077
mkdir -p .deployment
chmod 700 .deployment
cp deploy/setup.production.example.json .deployment/config.json
```

Edit `.deployment/config.json` with your cluster, approved image digests,
credential file paths, storage classes, API URL, and actual network destinations.
The [configuration reference](../reference/setup.md#production-configuration)
explains each input. Keep credential values in their private files.

The configured HTTPS proxy must route to `openclaw-enterprise-api:8080` in
`systemNamespace`, with Pod labels matching `apiClient`. Ensure your cluster's
network controls permit the current public IPv4 TCP/443 model egress described
in the [security reference](../reference/security.md).

```bash
node scripts/setup.mjs production --config .deployment/config.json
```

Setup validates the configuration and chart, creates its startup Secrets and
private bootstrap volume, installs Helm, retrieves both initial administrator
credentials, provisions tenant access and Agent Secrets, and opens the TUI.
It keeps operator credentials out of the Agent workload.

## Verify the conversation

Wait for the TUI to show a connected session. Send:

```text
Reply exactly: deployment-check-one
```

Require an **assistant reply** containing `deployment-check-one`; the echoed
user prompt alone is not success. In the same TUI session, send
`Reply exactly: deployment-check-two` and require the second assistant reply.
This proves both the gateway connection and model-backed conversation.

Press Ctrl+D to leave the TUI. The gateway keeps running. Reconnect using the
saved deployment state:

```bash
node scripts/setup.mjs tui
```

Use `--state-dir DIR` consistently if you selected a different state directory.
The reconnect command does not need the model API key in your shell.

## Rerun or recover

Keep `.deployment` private and retain it. It records the exact deployment IDs and
stores credentials in separate private files. Rerunning the same setup command
reuses those resources; it does not rotate keys or deploy another revision.

If setup reports an uncertain bootstrap or pending API operation, preserve the
state and follow [setup recovery](../reference/setup.md#recovery). Do not delete
state or bootstrap output to force a retry. Expired service credentials use
[human administrator recovery](../reference/authentication.md#service-api-keys-for-automation).

For local shutdown, `docker compose down` stops the control plane and preserves
its data. Agent containers remain running; see [stopping](../reference/setup.md#stopping)
to stop the exact gateway or select a customized Compose project. Production removal is a separate operator action.

## Details

- [Setup commands, configuration, and state](../reference/setup.md)
- [Runtime image recipe](../../deploy/runtime/README.md)
- [Setup execution flow](../flows/setup.md)
- [API and feature reference](../reference/README.md)
