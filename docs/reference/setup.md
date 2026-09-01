# Setup command

`scripts/setup.mjs` installs a development or production control plane, creates
one Namespace and embedded OpenClaw Agent, deploys it, and opens its terminal UI.
Run it from the repository root with Node.js 24 or newer. It uses only Node
built-ins; host `pnpm install` is not required.

Follow the [deployment guide](../guides/deploy.md) for the short operator path.
The [setup flow](../flows/setup.md) traces implementation and authority.

## Commands

| Command                             | Required inputs                                      | Optional flags                                              |
| ----------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| `node scripts/setup.mjs dev`        | `--model MODEL`, `OPENAI_API_KEY` in the environment | `--runtime-image IMAGE`, `--state-dir DIR`, `--no-tui`      |
| `node scripts/setup.mjs production` | `--config FILE`, including a private model-key file  | `--state-dir DIR`, `--no-tui`                               |
| `node scripts/setup.mjs tui`        | Saved deployment state                               | `--state-dir DIR`, `--session SESSION`, `--message MESSAGE` |

The default state directory is `.deployment`. The default development runtime
image is `openclaw-enterprise-runtime:quickstart`; setup builds it from
[`deploy/runtime/Dockerfile`](../../deploy/runtime/Dockerfile) when absent.
A custom image must already be available and satisfy the
[runtime image contract](../../deploy/runtime/README.md).

Setup opens the native TUI unless `--no-tui` is supplied. Opening it requires an
interactive terminal. Reconnect requires the saved OCC service credential and
Docker or Kubernetes access; it does not require the operator's model key.
It reads the Agent's current active revision before selecting the gateway.

## Production configuration

Copy [`deploy/setup.production.example.json`](../../deploy/setup.production.example.json)
and replace its example values. File paths are resolved by the running command;
use absolute paths for production inputs.

| Input                                                      | Meaning                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `model`, `modelKeyFile`                                    | Authorized OpenAI model ID and private file containing its API key.                     |
| `kubeconfig`, `context`                                    | Explicit cluster selection; setup never changes the default context.                    |
| `url`                                                      | Operator-reachable HTTPS URL for the OCC API, routed to `openclaw-enterprise-api:8080`. |
| `controllerImage`, `runtimeImage`                          | Approved controller and combined runtime images, each pinned with `@sha256:`.           |
| `adminEmail`                                               | Initial human administrator email.                                                      |
| `clusterName`, `systemNamespace`, `release`                | Installation name, dedicated Kubernetes system namespace, and Helm release.             |
| `gatewayStorageClass`, `bootstrapStorageClass`             | SQLite-compatible RWO runtime storage and private bootstrap-output storage.             |
| `database.applicationUrlFile`, `database.migrationUrlFile` | Separate private PostgreSQL URL files for application and migration roles.              |
| `database.cidr`, `database.port`                           | NetworkPolicy-visible database IPv4 `/32` and TCP port.                                 |
| `apiClient.namespace`, `apiClient.podLabels`               | Exact in-cluster HTTPS proxy/client selector allowed to reach the API.                  |
| `kubernetesApi.cidr`, `kubernetesApi.port`                 | NetworkPolicy-visible Kubernetes API IPv4 `/32` and TCP port.                           |
| `gatewayClient.namespace`, `gatewayClient.podLabels`       | Approved in-cluster gateway clients; defaults to `apiClient`.                           |
| `dns.namespace`, `dns.podLabels`                           | Cluster DNS selector; defaults to `kube-system` / `k8s-app: kube-dns`.                  |

Credential files must be regular, private files; use mode `0600` and private
parent directories. Do not embed their values in the JSON or command arguments.
The model key and database URLs are delivered through Secrets. OCC service
credentials stay with the operator and never enter Agent workloads.

### Generated configuration

Setup writes an Installation configuration and Helm values into the state
directory. It selects native IAM, Kubernetes Configuration/Compute/Secret
Drivers, embedded OpenClaw execution, RWO storage, and bounded default resources.
The initial connectivity Agent skips first-run onboarding. This command does
not configure ChatGPT integration, dedicated Codex execution, or existing tenant
namespace adoption; use the feature references for those separate operations.

The operator must supply the external database, DNS/TLS proxy, approved images,
and enforcing NetworkPolicies. Kubernetes authority must cover creating, reading,
and updating the system Namespace and chart ClusterRoles/ClusterRoleBindings,
as well as namespaced Secrets, PVCs, Pods, Deployments, Jobs, Services,
RoleBindings, and NetworkPolicies. Namespace-scoped credentials alone are
insufficient. Setup creates its owned startup Secrets,
bootstrap PVC, Helm resources, and tenant-local worker/Configuration
RoleBindings. It does not grant the controller cluster-wide RoleBinding creation.

Current Compute allows public IPv4 TCP/443 model egress. A narrower additive
NetworkPolicy cannot restrict that allowance. See
[security controls](security.md) before selecting a production cluster.

## State and reruns

Keep the state directory private (mode `0700`) and retain it with the deployment.
It contains non-secret IDs in `state.json`, the initial service key in
`initial-admin-service-key.json`, and private generated configuration/credential
files. Production also copies `initial-admin-password` for human recovery.
Individual files use mode `0600`. `.deployment` is excluded from Git and Docker
build contexts; alternate in-repository locations are rejected.

Rerun the same command with the same inputs and state directory to verify and
reuse the recorded Installation, Namespace, Configuration, Agent, and revision.
Setup does not rotate credentials or create another revision on a successful
rerun. It rejects changed deployment identity and does not adopt resources by
name. Change Agents through the ordinary API after initial setup.

A lock prevents concurrent state updates and is released before TUI attachment.
A crash can leave `state.lock`; its error identifies the owning PID and host.
Remove only that lock after confirming its owner is stopped. Keep `state.json`
and credentials.

A retained pending marker means a mutating request may have succeeded without its response
being saved. For a pending Helm install, setup first inspects the exact saved
release and its owned resources, and resumes only when initialization is proven
complete. An unresolved API or Helm outcome needs manual inspection. Preserve
state and verify the actual outcome before resuming; do
not clear the marker merely to force a retry. Losing the state directory is not
a reason to start a second setup against the same resources.

## Recovery

| Symptom                                | Check                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Development startup fails              | `docker compose logs --tail=50 bootstrap controller worker`; use the saved Compose project if customized. |
| Production initialization fails        | Initialization Job logs and private bootstrap output; follow the recovery below.                          |
| Namespace remains provisioning         | Exact tenant worker RoleBinding and worker health.                                                        |
| Configuration returns `503`            | Tenant Configuration RoleBinding for the API ServiceAccount.                                              |
| Gateway is Pending or unready          | Exact Agent transport/model Secrets, digest pulls, PVC attachment, and resource limits.                   |
| TUI connects but no assistant responds | Model authorization, gateway logs, and outbound HTTPS.                                                    |
| OCC credential returns `401`           | Expiry/revocation; use [human administrator recovery](authentication.md#service-api-keys-for-automation). |

### Incomplete bootstrap

Bootstrap makes one attempt and preserves accounts, keys, and partial output on
failure. `installation.bootstrap-failed` reports available non-secret IDs and
paths; file existence alone does not establish a committed Installation.

Use approved database access to establish whether the original transaction
committed and compare its Installation, human, service-principal, and key IDs
with current records. If the database is unavailable, the outcome remains
unresolved. Preserve storage and diagnostics; do not delete output or retry.

For a confirmed noncommitted attempt, manually remove only proven orphan
accounts/keys and quarantine that attempt's output in protected storage. Retain
credentials for a matching committed seed and use ordinary key recovery. A
losing concurrent attempt may have separate orphan records. Retry only after
repair, or after an explicitly authorized reset of an identified disposable
Installation's dedicated database and credential storage.

## Credential retrieval and replacement

Successful setup already copies the initial service-key JSON into the private
state directory. For manual API operations:

```bash
export OCC_URL='<API URL from state.json>'
export OCC_SERVICE_KEY_FILE="$PWD/.deployment/initial-admin-service-key.json"
scripts/occ-api GET /installation
```

The helper reads `data.key` without exposing it in arguments or terminal output.
To replace an expired/revoked key, follow the
[human sign-in and key issuance procedure](authentication.md#service-api-keys-for-automation),
verify the replacement, then install its JSON at the saved `serviceKeyFile`
path with mode `0600`. Keep the original Installation and principal IDs.
Deleting a local key file does not revoke it.

## Stopping

Exit the TUI with Ctrl+D; the Agent remains running. `docker compose down` stops
the default development control plane and preserves volumes. It does not stop
worker-created Agent containers. To stop this Agent, find the gateway container
with Docker labels `org.openclaw.enterprise.agent-id=<saved agentId>` and
`org.openclaw.enterprise.role=gateway`, verify the exact container ID, then run
`docker stop <container-id>`. Retain its volumes. If you used a different
Compose project, pass the exact saved project with `-p`. Do not add `--volumes`
unless deliberately deleting the development database and credentials.
Production removal is a separate operator action; setup has no uninstall or
reset command.
