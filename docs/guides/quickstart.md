# Quickstart

Run a local OpenClaw Agent and exchange messages through its terminal UI.
You need Node.js 24+, Docker Engine with Docker Compose, and an authorized
OpenAI model/key. Run from the repository root.

```bash
# Load OPENAI_API_KEY into this shell using your credential manager.
node scripts/setup.mjs dev --model gpt-5.1
```

Choose a model your key can access. Setup builds the runtime image when needed,
starts the control plane, creates the Agent, and opens its terminal UI. The
first run can take several minutes. The worker has Docker host access through
the Docker socket, so use a trusted development host.

Once connected, send `Reply exactly: hello-one` and require an assistant reply.
Send `Reply exactly: hello-two` in the same session and require a second reply.
Press Ctrl+D to leave; the Agent keeps running.

Reconnect with:

```bash
node scripts/setup.mjs tui
```

Keep the private `.deployment` directory for reconnect and recovery. For an
unattended install, add `--no-tui` to setup and reconnect later. To stop the local
control plane while retaining data, run `docker compose down`. Agent containers
remain running; see [stopping](../reference/setup.md#stopping) to stop the gateway.

See [Deploy](deploy.md) for production and [Setup reference](../reference/setup.md)
for flags, private state, and recovery. Human administrator sign-in and key
rotation are in the [authentication reference](../reference/authentication.md#service-api-keys-for-automation).
