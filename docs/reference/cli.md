# OCC CLI command reference

`occ` manages OpenClaw Control Plane (OCC) resources. To install it and make
your first request, see [CLI setup](../guides/cli.md). To see help for the
installed version, run `occ --help` or add `--help` to a command.

## Global options

Command-line flags override the corresponding environment variables.

| Flag                 | Environment variable   | What it controls                                                                                                                           |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--url`              | `OCC_URL`              | Required for resource commands. An HTTP or HTTPS origin, without embedded credentials, a base path, query, or fragment.                    |
| `--service-key-file` | `OCC_SERVICE_KEY_FILE` | Required for resource commands. Path to the complete bootstrap or issued service-key JSON response.                                        |
| `--namespace`        | `OCC_NAMESPACE`        | Required for `configuration`, `secret`, `preset`, `credential-source`, `iam`, and `agent` commands. Supply the Namespace ID, not its name. |
| `--ca-bundle`        | `OCC_CA_BUNDLE`        | Adds a PEM certificate-authority bundle to the system trust roots for HTTPS. TLS verification cannot be disabled.                          |
| `--timeout-seconds`  | `OCC_TIMEOUT_SECONDS`  | Positive whole seconds for an HTTP request. Default: `30`.                                                                                 |
| `--output`, `-o`     | —                      | Output format: `table` (default), `json`, or `yaml`.                                                                                       |
| `--help`, `-h`       | —                      | Prints help for the command.                                                                                                               |
| `--version`, `-v`    | —                      | Prints the CLI version. Source builds report `dev`; published binaries report their OCE release version.                                   |

The service-key JSON must contain a nonempty `data.key` with no line breaks.
The client sends it as `x-api-key` and does not follow redirects. Use a trusted
HTTPS endpoint unless connecting to a local loopback development Installation.
See [Service API Keys](authentication/service-api-keys.md) for issuing or rotating
keys.

Pressing Ctrl-C, or sending `SIGTERM`, cancels an in-flight request and exits
with an error instead of waiting for `--timeout-seconds` to expire.

## Resource commands

Replace `ID` with the corresponding resource ID, `NAME` with a Namespace name,
and `FILE` with a JSON file path. `--file` reads a local file, not stdin; YAML
input is not supported. The server validates document fields against the
[HTTP API contract](api.md). `--help` on `configuration`, `secret`, `agent`,
`iam role`, and `iam access-binding` `create` shows a minimal sample document.

| Command                                                | What it does                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occ installation get`                                 | Reads the singleton Installation.                                                                                                                                                                                                                                                                                                                                                                 |
| `occ installation deployment-inventory`                | Reads the complete Agent deployment inventory for a coordinated fleet operation.                                                                                                                                                                                                                                                                                                                  |
| `occ namespace list`                                   | Lists authorized Namespaces. `ADOPTED NAMESPACE` is set only for adopted Kubernetes namespaces.                                                                                                                                                                                                                                                                                                   |
| `occ namespace get ID`                                 | Reads one Namespace and its status.                                                                                                                                                                                                                                                                                                                                                               |
| `occ namespace create NAME`                            | Creates a Namespace. `--existing-namespace K8S_NAME` requests adoption of an operator-prepared Kubernetes namespace and also requires Installation `administer`. The CLI refuses a name that is not a DNS-1123 label of at most 63 characters, the same rule as the API, before it sends the request. Explicitly supplying an empty value is refused; omit the flag to request managed placement. |
| `occ namespace delete ID`                              | Begins deleting an empty Namespace. Use `namespace get` to inspect the resulting state. Its name stays reserved and cannot be reused.                                                                                                                                                                                                                                                             |
| `occ configuration create --file FILE`                 | Creates a Configuration. The body contains `kind` and `values`.                                                                                                                                                                                                                                                                                                                                   |
| `occ configuration get ID`                             | Reads a Configuration.                                                                                                                                                                                                                                                                                                                                                                            |
| `occ configuration update ID --file FILE`              | Updates a Configuration; the body must replace `values`. Omit the create-only `kind`.                                                                                                                                                                                                                                                                                                             |
| `occ configuration delete ID`                          | Deletes an unreferenced Configuration.                                                                                                                                                                                                                                                                                                                                                            |
| `occ secret create --file FILE`                        | Stores a Namespace Secret from a protected JSON document.                                                                                                                                                                                                                                                                                                                                         |
| `occ secret list`                                      | Lists Namespace Secret metadata, never values.                                                                                                                                                                                                                                                                                                                                                    |
| `occ secret get ID`                                    | Reads Secret metadata, never its value, and the readable resources that reference it (`CONSUMERS`).                                                                                                                                                                                                                                                                                               |
| `occ secret update ID --file FILE`                     | Replaces the Secret value; consumers require explicit redeployment.                                                                                                                                                                                                                                                                                                                               |
| `occ secret delete ID`                                 | Deletes an unreferenced Namespace Secret.                                                                                                                                                                                                                                                                                                                                                         |
| `occ preset list`                                      | Lists the Namespace's [Presets](presets.md) the caller can read: ID, name, and creation time.                                                                                                                                                                                                                                                                                                     |
| `occ preset get ID`                                    | Reads a Preset; `-o json` or `-o yaml` includes its template.                                                                                                                                                                                                                                                                                                                                     |
| `occ preset delete ID`                                 | Deletes a Preset and its exact-resource AccessBindings. Agents and Configurations created from it are unchanged.                                                                                                                                                                                                                                                                                  |
| `occ credential-source create --file FILE`             | Registers a Secret with the selected Credential Gateway. See [credential sources](credential-sources.md#register-a-source).                                                                                                                                                                                                                                                                       |
| `occ credential-source list`                           | Lists credential sources without live gateway status.                                                                                                                                                                                                                                                                                                                                             |
| `occ credential-source get ID`                         | Reads a credential source and its live gateway status, never its value.                                                                                                                                                                                                                                                                                                                           |
| `occ credential-source delete ID`                      | Deletes an unreferenced credential source and the gateway's copy.                                                                                                                                                                                                                                                                                                                                 |
| `occ credential-source update ID [--file FILE]`        | Pushes current Secret values, or the replacement `secrets` in `FILE`, to the gateway copy. Running Agents use them after a redeploy. An `oauth2-refresh-token` source needs `FILE` naming a new `refresh_token` Secret.                                                                                                                                                                           |
| `occ service-account list`                             | Lists the Namespace's ServiceAccounts: ID and name.                                                                                                                                                                                                                                                                                                                                               |
| `occ service-account delete ID [--force]`              | Deletes an unreferenced ServiceAccount and revokes its access token. `--force` also deletes one whose ChatGPT Backend is gone; an administrator then revokes the token at the provider. See [service accounts](service-accounts.md#force-delete-when-the-backend-is-gone).                                                                                                                        |
| `occ iam role list`                                    | Lists Namespace Roles.                                                                                                                                                                                                                                                                                                                                                                            |
| `occ iam role get ID`                                  | Reads a Namespace Role.                                                                                                                                                                                                                                                                                                                                                                           |
| `occ iam role create --file FILE`                      | Creates a Namespace Role with explicit permissions.                                                                                                                                                                                                                                                                                                                                               |
| `occ iam role delete ID`                               | Deletes an unreferenced Namespace Role.                                                                                                                                                                                                                                                                                                                                                           |
| `occ iam access-binding list`                          | Lists Namespace AccessBindings.                                                                                                                                                                                                                                                                                                                                                                   |
| `occ iam access-binding get ID`                        | Reads a Namespace AccessBinding.                                                                                                                                                                                                                                                                                                                                                                  |
| `occ iam access-binding create --file FILE`            | Grants a Role to a principal for an exact resource.                                                                                                                                                                                                                                                                                                                                               |
| `occ iam access-binding delete ID`                     | Deletes a Namespace AccessBinding.                                                                                                                                                                                                                                                                                                                                                                |
| `occ iam service-principal create`                     | Creates a Namespace ServicePrincipal with no grant, for automation or a member's CLI key.                                                                                                                                                                                                                                                                                                         |
| `occ iam service-principal list`                       | Lists the Namespace's non-Agent ServicePrincipals.                                                                                                                                                                                                                                                                                                                                                |
| `occ iam service-principal get ID`                     | Reads a Namespace ServicePrincipal.                                                                                                                                                                                                                                                                                                                                                               |
| `occ service-key create`                               | With `--service-principal ID --name NAME --out FILE`, issues a [service key](authentication/service-api-keys.md) into a new `0600` file; never prints the key.                                                                                                                                                                                                                                    |
| `occ service-key revoke ID`                            | Revokes a service key.                                                                                                                                                                                                                                                                                                                                                                            |
| `occ agent delete ID`                                  | Begins asynchronous Agent deletion, including its owned runtime state.                                                                                                                                                                                                                                                                                                                            |
| `occ agent list`                                       | Lists authorized Agents in the selected Namespace.                                                                                                                                                                                                                                                                                                                                                |
| `occ agent get ID`                                     | Reads an Agent's desired state and active revision.                                                                                                                                                                                                                                                                                                                                               |
| `occ agent create --file FILE`                         | Creates an Agent draft.                                                                                                                                                                                                                                                                                                                                                                           |
| `occ agent update ID --file FILE`                      | Updates editable Agent fields; the body must include `configurationId`.                                                                                                                                                                                                                                                                                                                           |
| `occ agent deploy ID`                                  | Requests deployment and creates an immutable revision.                                                                                                                                                                                                                                                                                                                                            |
| `occ agent revisions ID`                               | Lists the Agent's immutable revisions (deployment IDs) with configuration generation, deployment status, and `*` on the active one.                                                                                                                                                                                                                                                               |
| `occ agent deployment-status ID [DEPLOYMENT_ID]`       | Reads the durable status, error, and plugin startup warnings of one Agent deployment; without `DEPLOYMENT_ID`, of the latest revision.                                                                                                                                                                                                                                                            |
| `occ agent runtime-credentials get ID`                 | Reads whether generated runtime credentials are configured for the Agent.                                                                                                                                                                                                                                                                                                                         |
| `occ agent runtime-credentials provision ID`           | Creates the initial generated runtime credential bundle (empty request body).                                                                                                                                                                                                                                                                                                                     |
| `occ agent credential-withdrawal request ID SOURCE_ID` | Revokes a credential source from the Agent's active revision; see [withdrawal](credential-sources/withdrawal.md).                                                                                                                                                                                                                                                                                 |
| `occ agent credential-withdrawal get ID SOURCE_ID`     | Shows whether that withdrawal is `pending` or `revoked`, who requested it, and the reason code of the latest attempt.                                                                                                                                                                                                                                                                             |
| `occ agent stop ID`                                    | Requests a stop while retaining revisions and persistent state; `occ agent deploy ID` starts it again.                                                                                                                                                                                                                                                                                            |
| `occ agent runtime ID`                                 | Reads Pod status, restarts, last termination, log sources and Events for a revision. See [runtime logs](#runtime-status-and-logs).                                                                                                                                                                                                                                                                |
| `occ agent logs ID --source SOURCE`                    | Prints one redacted page of container output, or follows it. See [runtime logs](#runtime-status-and-logs).                                                                                                                                                                                                                                                                                        |

Use the [HTTP API](api.md) to work with ServiceAccounts and configured
Backends, and to create or update [Presets](presets.md#crud-and-permissions);
the CLI has no commands for these. Neither the CLI nor the HTTP API
offers Configuration listing. An accepted deploy returns a revision; `agent get`
shows desired state, `LIFECYCLE` (`active` or `deleting`), and the selected
revision, not runtime health. Run `occ agent deployment-status ID` for the
latest deployment's status and error, and verify the model separately.

For [unreadable saved Agent settings](agents.md#unreadable-saved-settings),
`agent get`, `agent list`, and `agent revisions` retain metadata and show
`CONFIGURATION ERROR` with the affected field. JSON and YAML retain the typed
`configurationReadError`. Revision history leaves deployment status null for
unreadable rows; if the Agent itself is unreadable, it skips all status reads
and explains why on stderr. See the [CLI browsing flow](../flows/cli-agent-browsing.md).

`service-key create --expires-in-days N` accepts 1–365. Omit the flag for 30 days;
explicit zero is refused before output-file creation or API issuance.

Commands take IDs, not names. The CLI rejects a value without the expected
prefix, such as `ns_` or `agt_`, and names the list command that shows the ID.

The `installation get`, `installation deployment-inventory`, and `namespace
list` commands require an Installation-scoped service key. With a
Namespace-scoped key, use `namespace get ID` to read that exact Namespace
instead.

`installation deployment-inventory` requires Installation `administer`, exact
`read` access to every Namespace and Agent, exact `read` access to each selected
Agent's active revision, and exact `deploy` access to every running Agent that is
eligible for coordinated deployment. It fails instead of silently omitting an
unauthorized resource. JSON and YAML output include each Agent's desired runtime
state, execution mode, active revision, and whether deployment work is queued or
claimed.

## Runtime status and logs

`occ agent runtime AGENT_ID` and `occ agent logs AGENT_ID` read the
[Agent logs](../guides/topics/agent-logs.md) routes. Without `--revision ID`,
both read the latest revision when it is newer than the active one and has Pods
(a deploy in progress or a failed replacement, whose Pods hold the failure),
else the active revision, else the latest revision. They print the revision they
read to stderr; a reader without Agent `operate` cannot check for Pods, so the
notice names the newer revision to pass. `runtime` accepts `-o table|json|yaml`
and needs Agent `operate` and `read` plus `read` on the revision. Its table output
ends with each Pod's Events (`POD`, `CONTAINER`, `TYPE`, `REASON`, `COUNT`,
`LAST SEEN`, `MESSAGE`); `CONTAINER` is `-` for Pod-level Events. `logs` needs
Agent `read_logs` (or `administer`) and `read`, which cover every revision, and
each view is audited. Default revision selection lists only revisions you can
`read`: without revision grants, `logs` reads the active revision without
checking for a newer one, and an Agent with no active revision needs
`--revision ID`.

| `occ agent logs` flag  | Meaning                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source SOURCE`      | Required: `gateway`, `agent` (dedicated Harness container) or `sandbox` (OpenShell policy decisions; no `--pod` or `--previous`).                                                                          |
| `--revision ID`        | Revision to read; defaults as described above.                                                                                                                                                             |
| `--pod NAME`           | Pod to read when the source has more than one.                                                                                                                                                             |
| `--previous`           | Read the container instance before the last restart.                                                                                                                                                       |
| `--tail N`             | Lines from the end of the stream, 1 to 1000 (default 200).                                                                                                                                                 |
| `--since DURATION`     | Only lines newer than a Go duration such as `10m`, up to `24h`.                                                                                                                                            |
| `--follow`             | Poll every 2 seconds with the view's cursor until Ctrl-C.                                                                                                                                                  |
| `--level LEVEL`        | Only `error`, `warn`, `info` or `debug` lines and above, filtered by OCC after `--tail` (the last N lines are read, then filtered, so fewer may print); lines of unknown level stay. Default: every level. |
| `-o text` or `-o json` | Text lines (default) or NDJSON, one API record per line.                                                                                                                                                   |

Text output prints `TIME LEVEL KIND [SUBSYSTEM] MESSAGE key=value` per line.
Gap and withheld records are printed to stderr as `notice:` lines; in JSON mode
they are also records on stdout. Text lines and notices show an invisible or
control character, such as a bidirectional override, as an escape like
`\u202e`; a field value holding one is quoted. JSON records are unchanged. With `--follow`, the CLI waits for
`Retry-After` after a `429`, retries after a `504`, starts a new audited view
when the cursor is rejected, and exits cleanly on Ctrl-C. `501`, `503` and
permission errors end the command with a nonzero exit. `--follow` cannot be
combined with `--previous`.

```sh
occ agent runtime agt_...
occ agent logs agt_... --source gateway --since 10m
occ agent logs agt_... --source gateway --follow -o json | jq -r .message
```

## Output and errors

Table output is meant for people; it prints `-` for unset fields and `No
resources found.` for an empty list. A cell holding an invisible or control
character, such as a bidirectional override in a name, is printed quoted with
that character escaped; so is a value that starts with `"`. JSON and YAML print the exact resource or array
without the HTTP envelope. Deleting a Configuration prints
`Deleted configuration ID.` in table mode; structured output contains
`deleted`, `kind`, and `id`.

Failures go to stderr and the CLI exits nonzero. For HTTP errors, the CLI prints
the status and, when present, the API error code and message, and the
`Retry-After` delay in seconds. It does not print
the server's request ID. To capture that ID for a failed request, use the
[HTTP API directly](../guides/http-api.md#troubleshoot).

## Local development

Run these from a repository checkout. They use local development configuration,
not the remote connection or output options above. Kubernetes is the supported
local setup for deploying an Agent; follow [Local Setup](../guides/quickstart.md).

| Command                        | What it does                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `occ dev up`                   | Starts the profile selected by `OCC_DEVELOPMENT_COMPUTE_DRIVER`: `docker` (default) or `kubernetes`. Docker is a control-plane preview and cannot deploy Agents.               |
| `occ dev up --key-output PATH` | Writes the bootstrap service-key file to an absent absolute path in a private directory.                                                                                       |
| `occ dev down`                 | Stops the selected profile. Docker keeps Compose volumes by default. Kubernetes removes its owned k3d cluster; the Compose control-plane profile also removes Compose volumes. |
| `occ dev down --volumes`       | Also removes Docker Compose volumes; Kubernetes cleanup already removes its volumes.                                                                                           |

In the Go Kubernetes helpers, a failed exclusive write removes its newly created
output, including a partial key file. Existing targets stay unchanged. If removal
also fails, the returned error includes both failures.

Compose global options, when needed, must follow `--`. Keep the cleanup command
printed by startup so it selects the same profile and state directory.
The explicitly selected Kubernetes-only profile rejects Compose options. Use
`scripts/dev-up` and `scripts/dev-down` as the common entry points for every
profile; the Compute and Sandbox Driver settings select the implementation.
When `scripts/dev-up` fails on the Docker profile, `occ dev up` exits with the
script's status (`2` for a usage or configuration error) and prints nothing
beyond the script's own message.
