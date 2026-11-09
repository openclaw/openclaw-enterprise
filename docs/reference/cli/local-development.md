# Local development commands

Run these `occ dev` commands from a repository checkout to start and stop a local
profile. They use local development configuration, not the remote connection or
output options in the [CLI command reference](../cli.md). Kubernetes is the supported
local setup for deploying an Agent; follow [Local Setup](../../guides/quickstart.md).

The CLI uses the nearest enclosing checkout identified by its OCE `go.mod` and
`compose.yaml`. The Compose marker must be a regular file or a symlink to one.
An absent marker allows the search to continue; an invalid or unresolvable marker
stops both commands with the exact path to fix. If `go.mod` contains CRLF line
endings, convert the file to LF and retry. These errors do not fall through to
an outer checkout that could own a different stack.

| Command                                         | What it does                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `occ dev up`                                    | Starts the profile selected by `OCC_DEVELOPMENT_COMPUTE_DRIVER`: `docker` (default) or `kubernetes`. Docker is a control-plane preview and cannot deploy Agents.               |
| `occ dev up --key-output PATH`                  | Writes the bootstrap service-key file to an absent absolute path in a private directory.                                                                                       |
| `occ dev up --sandbox-network-policy-file FILE` | Adds binary and endpoint rules for Kubernetes Compute with OpenShell; see [startup network policy](../../guides/deploy/local-sandbox-network-policy.md).                       |
| `occ dev down`                                  | Stops the selected profile. Docker keeps Compose volumes by default. Kubernetes removes its owned k3d cluster; the Compose control-plane profile also removes Compose volumes. |
| `occ dev down --volumes`                        | Also removes Docker Compose volumes; Kubernetes cleanup already removes its volumes.                                                                                           |

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

The Go Local Setup commands write `[occ-dev-timing]` records to the progress output for
image builds, pulls, exports/imports, cluster creation, Compose startup, Helm
installation, and Kubernetes readiness waits. Each record contains a fixed stage,
elapsed milliseconds, and whether the command failed. It excludes arguments,
environment values, and subprocess output. Concurrent commands overlap, so their
durations must not be added as total startup time. These records do not change
command cancellation, readiness checks, or failure handling.

When Kubernetes-only startup returns an error, `[occ-dev-startup]` reports the
selected error's `primary_stage`, or `unknown` when no stage is identified.
`cleanup_failed` records failure in tracked network-probe cleanup, registry
detachment or startup rollback, including canceled sibling steps; it does not
inventory every resource cleanup.
`parent_context_done` says whether the parent context had ended when the CLI
reported the result. It does not establish that cancellation initiated failure.
Original errors and exit behavior are preserved. The record contains no raw
errors, paths or subprocess output.
