# Local development commands

Run these `occ dev` commands from a repository checkout to start and stop a local
profile. They use local development configuration, not the remote connection or
output options in the [CLI command reference](../cli.md). Kubernetes is the supported
local setup for deploying an Agent; follow [Local Setup](../../guides/quickstart.md).

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
