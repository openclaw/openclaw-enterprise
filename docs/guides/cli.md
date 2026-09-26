# Set up the OCC CLI

<a id="occ-cli"></a>

Use `occ` to manage OpenClaw Control Plane (OCC) resources from a terminal. You
need your Installation's OCC endpoint and a protected service-key response file.
For all commands and flags, see the [CLI command reference](../reference/cli.md).
To deploy through the browser, see [Create and deploy Agents in the console](../reference/console/create-and-deploy.md).

## Connect to your Installation

From the root of a trusted OpenClaw Enterprise checkout, install `occ` on your
Go binary path:

```bash
go install ./cmd/occ
```

Ensure that directory is on `PATH`. To use the binary inside the checkout
instead, run `pnpm cli:build` and substitute `./bin/occ` for `occ` below.

Set the endpoint and the service-key file supplied by your administrator or
created during [bootstrap](../reference/authentication/service-api-keys.md#retrieve-the-bootstrap-service-key):

```bash
export OCC_URL='https://occ.example.com'
export OCC_SERVICE_KEY_FILE='/private/path/occ-service-key.json'
occ installation get
occ namespace list
```

Replace both example values with your own. These commands require an
Installation-scoped key; reading the Installation also requires Installation
`read`. If your key is Namespace-scoped, use
`occ namespace get '<namespace-id>'` with the ID supplied by your administrator
instead.

`installation get` prints the Installation ID and name. `namespace list` prints
the authorized Namespaces and their `STATUS`; a Namespace must be `ready` to
deploy an Agent. Add `--output json` or `--output yaml` to print the resource or
list without the HTTP response envelope. Set a Namespace once for subsequent
commands:

```bash
export OCC_NAMESPACE='<namespace-id>'
```

Installation administrators can obtain a fail-closed fleet snapshot for a
coordinated deployment:

```bash
occ installation deployment-inventory --output json
```

This command requires exact read access to every Namespace and Agent and exact
deploy access to each eligible running Agent. OCC rejects the entire request if
those checks or durable deployment-work checks cannot establish a complete
inventory. Use the [production upgrade guide](deploy/production-upgrade.md) for
the supported image-replacement workflow.

## Create an Agent draft

Save this as `configuration.json` to create a draft that will not run yet:

```json
{
  "kind": "agent",
  "values": {}
}
```

If you plan to deploy now, use a complete [embedded or dedicated runtime
Configuration](deploy/production-agents.md#configure-the-agent-runtime)
instead. Choose a model your Installation can access and keep plaintext
credentials out of the file.

```bash
occ configuration create --file configuration.json
```

Copy the Configuration `ID` into `agent.json`:

```json
{
  "name": "support-agent",
  "configurationId": "<configuration-id>",
  "executionMode": "embedded"
}
```

Use `dedicated` instead if you chose a Codex runtime Configuration. Create the
Agent:

```bash
occ agent create --file agent.json
```

Save the Agent `ID`. Its `DESIRED STATE` is `stopped` and `ACTIVE REVISION` is
`-`; no workload has started. These calls require permission to create
Configurations and Agents in the Namespace and to read the exact Configuration.
See [Configuration](../reference/configuration.md#create-read-update-and-delete)
and [Agent operations](../reference/agents.md#supported-operations) for optional
fields.

## Deploy and check an Agent

Complete the [Agent deployment prerequisites](deploy/production-agents.md#configure-the-agent-runtime)
before deploying. If you created the empty Configuration above, use
`occ configuration update '<configuration-id>' --file configuration-update.json`.
The update body contains `values`; omit the create-only `kind` field. To update
the Agent itself, use `occ agent update '<agent-id>' --file agent-update.json`;
its [update body](../reference/agents.md#editable-configuration) must include
`configurationId`.

```bash
REVISION_ID="$(occ agent deploy '<agent-id>' --output json | jq -r .id)"
occ agent deployment-status '<agent-id>' "$REVISION_ID"
occ agent get '<agent-id>'
```

Deployment returns an immutable revision. `deployment-status` reports the
durable worker outcome for that revision, and `agent get` shows the desired
state and selected revision. None of these commands reports live health or
proves a model responded. Follow
[Verify production workloads](deploy/production-agents.md#verify-production-workloads)
to verify a response from this Agent on Kubernetes. If you lost the
deploy result, check [revision history](../reference/agents/deployment.md#revisions-and-deployment)
before retrying: each accepted request creates a revision.

Run `occ agent stop '<agent-id>'` to stop the workload while retaining its
revision history and persistent state.

Run `occ agent delete '<agent-id>'` only when you intend to remove the Agent,
its revision history, and its runtime credentials. Kubernetes also removes
Agent-owned workspace data; Namespace-owned Configurations and Secrets survive.
Deletion runs asynchronously. See [Agent deletion](../reference/agents.md#deletion)
for the full cleanup behavior.

## Provision integration Secrets

Use Secret commands to create or replace Namespace-owned credentials used by
Agent harness authentication or Configuration Secret bindings. The CLI sends
protected JSON documents to OCC and prints metadata only; it never returns stored
values.

```bash
export OCC_NAMESPACE='<namespace-id>'
occ secret create --file slack-bot-token-secret.json
occ secret get '<secret-id>'
occ secret update '<secret-id>' --file replacement-secret.json
occ secret delete '<secret-id>'
```

Bind the returned Secret references through the owning Agent or Configuration and
grant the consuming Agent service principal exact `operate` permission before
deployment. See [Configuration secrets and channels](../reference/configuration/secrets.md)
for binding shape and delivery boundaries.

## Manage Namespace IAM

Create a Namespace Role and bind it to the Agent's returned
`servicePrincipalId` when an Agent needs delegated access to an exact resource.
The IAM commands require Installation administration and Namespace read access.

```bash
occ iam role create --file role.json
occ iam access-binding create --file binding.json
```

Use the request documents in
[Namespace IAM](../reference/authorization.md#manage-namespace-policy). Inspect
Role permissions before reusing a Role; its name alone does not establish
access.

## Manage local development

For a local Installation that can deploy an Agent, follow
[Local Setup](quickstart.md). The [development commands](../reference/cli.md#local-development)
explain how to choose the Kubernetes profile and what cleanup removes.

## Connection and credential boundaries

The key file is the full JSON response from bootstrap or key issuance, not a
file containing only the raw key. Keep it owner-readable; never put the key in
command arguments, logs, or source control. For HTTPS signed by a private
certificate authority, set `OCC_CA_BUNDLE` to its PEM bundle. See
[global options](../reference/cli.md#global-options) for timeout, origin, and
TLS behavior.

## Troubleshoot

- `invalid service-key file`: Check that the JSON contains a nonempty
  `data.key` with no line break.
- HTTP `401`: OCC rejected the credential; retrieve or issue the intended key.
- HTTP `403`: Ask your administrator to check the service principal's permission
  for the exact operation and Namespace.
- Certificate error: Set `OCC_CA_BUNDLE` to the correct PEM bundle. The CLI has
  no insecure TLS mode.
