# OCC CLI command reference

`occ` manages OpenClaw Control Plane (OCC) resources. To install it and make
your first request, see [CLI setup](../guides/cli.md). To see help for the
installed version, run `occ --help` or add `--help` to a command.

## Global options

Command-line flags override the corresponding environment variables.

| Flag                 | Environment variable   | What it controls                                                                                                                 |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--url`              | `OCC_URL`              | Required for resource commands. An HTTP or HTTPS origin, without embedded credentials, a base path, query, or fragment.          |
| `--service-key-file` | `OCC_SERVICE_KEY_FILE` | Required for resource commands. Path to the complete bootstrap or issued service-key JSON response.                              |
| `--namespace`        | `OCC_NAMESPACE`        | Required for `configuration`, `secret`, `credential-source`, `iam`, and `agent` commands. Supply the Namespace ID, not its name. |
| `--ca-bundle`        | `OCC_CA_BUNDLE`        | Adds a PEM certificate-authority bundle to the system trust roots for HTTPS. TLS verification cannot be disabled.                |
| `--timeout-seconds`  | `OCC_TIMEOUT_SECONDS`  | Positive whole seconds for an HTTP request. Default: `30`.                                                                       |
| `--output`, `-o`     | —                      | Output format: `table` (default), `json`, or `yaml`.                                                                             |
| `--help`, `-h`       | —                      | Prints help for the command.                                                                                                     |
| `--version`, `-v`    | —                      | Prints the CLI version. Source builds report `dev` unless release packaging sets a version.                                      |

The service-key JSON must contain a nonempty `data.key` with no line breaks.
The client sends it as `x-api-key` and does not follow redirects. Use a trusted
HTTPS endpoint unless connecting to a local loopback development Installation.
See [Service API Keys](authentication/service-api-keys.md) for issuing or rotating
keys.

## Resource commands

Replace `ID` with the corresponding resource ID, `NAME` with a Namespace name,
and `FILE` with a JSON file path. `--file` reads a local file, not stdin; YAML
input is not supported. The server validates document fields against the
[HTTP API contract](api.md).

| Command                                        | What it does                                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occ installation get`                         | Reads the singleton Installation.                                                                                                                                |
| `occ installation deployment-inventory`        | Reads the complete Agent deployment inventory for a coordinated fleet operation.                                                                                 |
| `occ namespace list`                           | Lists authorized Namespaces.                                                                                                                                     |
| `occ namespace get ID`                         | Reads one Namespace and its status.                                                                                                                              |
| `occ namespace create NAME`                    | Creates a Namespace. `--existing-namespace K8S_NAME` requests adoption of an operator-prepared Kubernetes namespace and also requires Installation `administer`. |
| `occ namespace delete ID`                      | Begins deleting an empty Namespace. Use `namespace get` to inspect the resulting state.                                                                          |
| `occ configuration create --file FILE`         | Creates a Configuration. The body contains `kind` and `values`.                                                                                                  |
| `occ configuration get ID`                     | Reads a Configuration.                                                                                                                                           |
| `occ configuration update ID --file FILE`      | Updates a Configuration; the body must replace `values`. Omit the create-only `kind`.                                                                            |
| `occ configuration delete ID`                  | Deletes an unreferenced Configuration.                                                                                                                           |
| `occ secret create --file FILE`                | Stores a Namespace Secret from a protected JSON document.                                                                                                        |
| `occ secret get ID`                            | Reads Secret metadata, never its value.                                                                                                                          |
| `occ secret update ID --file FILE`             | Replaces the Secret value; consumers require explicit redeployment.                                                                                              |
| `occ secret delete ID`                         | Deletes an unreferenced Namespace Secret.                                                                                                                        |
| `occ credential-source create --file FILE`     | Registers a Secret with the selected Credential Gateway. See [credential sources](credential-sources.md#register-a-source).                                      |
| `occ credential-source list`                   | Lists credential sources without live gateway status.                                                                                                            |
| `occ credential-source get ID`                 | Reads a credential source and its live gateway status, never its value.                                                                                          |
| `occ credential-source delete ID`              | Deletes an unreferenced credential source and the gateway's copy.                                                                                                |
| `occ iam role list`                            | Lists Namespace Roles.                                                                                                                                           |
| `occ iam role get ID`                          | Reads a Namespace Role.                                                                                                                                          |
| `occ iam role create --file FILE`              | Creates a Namespace Role with explicit permissions.                                                                                                              |
| `occ iam role delete ID`                       | Deletes an unreferenced Namespace Role.                                                                                                                          |
| `occ iam access-binding list`                  | Lists Namespace AccessBindings.                                                                                                                                  |
| `occ iam access-binding get ID`                | Reads a Namespace AccessBinding.                                                                                                                                 |
| `occ iam access-binding create --file FILE`    | Grants a Role to a principal for an exact resource.                                                                                                              |
| `occ iam access-binding delete ID`             | Deletes a Namespace AccessBinding.                                                                                                                               |
| `occ agent delete ID`                          | Begins asynchronous Agent deletion, including its owned runtime state.                                                                                           |
| `occ agent list`                               | Lists authorized Agents in the selected Namespace.                                                                                                               |
| `occ agent get ID`                             | Reads an Agent's desired state and active revision.                                                                                                              |
| `occ agent create --file FILE`                 | Creates an Agent draft.                                                                                                                                          |
| `occ agent update ID --file FILE`              | Updates editable Agent fields; the body must include `configurationId`.                                                                                          |
| `occ agent deploy ID`                          | Requests deployment and creates an immutable revision.                                                                                                           |
| `occ agent deployment-status ID DEPLOYMENT_ID` | Reads the durable status of one exact Agent deployment.                                                                                                          |
| `occ agent stop ID`                            | Requests a stop while retaining revisions and persistent state.                                                                                                  |

Use the [HTTP API](api.md) to inspect revision history or to work with
ServiceAccounts and configured Backends; the CLI has no commands for these.
Neither the CLI nor the HTTP API offers Configuration
listing. An accepted deploy returns a revision; `agent get`
shows desired state and the selected revision, not runtime health. Use the
[deployment status command](#resource-commands) and verify the model
separately.

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

## Output and errors

Table output is meant for people; it prints `-` for unset fields and `No
resources found.` for an empty list. JSON and YAML print the resource or array
without the HTTP envelope. Deleting a Configuration prints
`Deleted configuration ID.` in table mode; structured output contains
`deleted`, `kind`, and `id`.

Failures go to stderr and the CLI exits nonzero. For HTTP errors, the CLI prints
the status and, when present, the API error code and message. It does not print
the server's request ID. To capture that ID for a failed request, use the
[HTTP API directly](../guides/http-api.md#troubleshoot).

## Local development

Run these from a repository checkout. They use local development configuration,
not the remote connection or output options above. Kubernetes is the supported
local setup for deploying an Agent; follow [Local Setup](../guides/quickstart.md).

| Command                        | What it does                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occ dev up`                   | Starts the profile selected by `OCC_DEVELOPMENT_COMPUTE_DRIVER`: `docker` (default) or `kubernetes`. Docker is a control-plane preview and cannot deploy Agents.  |
| `occ dev up --key-output PATH` | Writes the bootstrap service-key file to an absent absolute path in a private directory.                                                                          |
| `occ dev down`                 | Stops the selected profile. Docker keeps Compose volumes by default. Kubernetes removes its owned k3d cluster; the ordinary profile also removes Compose volumes. |
| `occ dev down --volumes`       | Also removes Docker Compose volumes; Kubernetes cleanup already removes its volumes.                                                                              |

Compose global options, when needed, must follow `--`. Keep the cleanup command
printed by startup so it selects the same profile and state directory.
The OpenShell Kubernetes-only profile rejects Compose options. Use
`scripts/dev-up` and `scripts/dev-down` as the common entry points for every
profile; the Compute and Sandbox Driver settings select the implementation.
