# Qualify Agent repository credentials

Use these checks for OCC admission, durable worker ownership and Kubernetes
material delivery. They are verification procedures, not evidence that the current
combined source has passed. For service and standalone-client checks, start with
the [repository credential test guide](repository-credentials.md).

## Verify Agent admission and durable ownership

The admission suite uses the actual HTTP application and checks authorized
selection, defaults, immutable public revision output and unsupported runtime
rejection. The Driver suite exercises the concrete registry, Unix control and
provider engine. It checks all four public status projections after complete
private decoding, including false disposal and valid historical revoked/expired
counts. Runtime-material suites check the closed file set, generation identity
and actual init-file publication. The detached client includes the pure private
client-contract validator alongside the GitHub client modules. Run the source checks with
prepared dependencies:

```sh
pnpm build
node --test tests/integration/repository-credentials-admission.test.mjs
node --test tests/integration/repository-credentials-driver.test.mjs
node --test tests/integration/repository-runtime-materialization.test.mjs
node --test tests/integration/repository-credentials-router.test.mjs
```

The build supplies emitted code for the detached materialization tests. They
execute both initializers and the relocated client, including fsGroup-style
group-writable parents. Relocation models the private subPath view; it does not
exercise a container mount. The separate
[runtime volume test](images.md#repository-runtime-volume-test-environment)
uses the image-installed client and real Docker mounts. It is required in the
`images-packaging` CI lane.

Follow [PostgreSQL setup](postgresql.md) for a migrated disposable application-role
database, then select `tests/integration/postgres-repository-sessions.test.mjs`
with `OCC_TEST_DATABASE_URL`. Its SQL constraints and State operations cover exact
revision ownership, immutable attempt inputs, phases and safe recovery identity.
The `postgres-restart-recovery.test.mjs` and `postgres-worker-agent-revision.test.mjs`
cases cover atomic terminal-retirement transfer, retries after Compute failure
and restart, and session-only repair that preserves the healthy workload.
These checks do not prove a running Kubernetes Pod or a model turn.

## Exercise the controlled platform path

Use the `repository-credentials-platform` CI lane for the complete prepared
fixture. It creates an owned loopback k3d cluster, a fresh migrated
`openclaw_k8s_*` database without an Installation, and a fixture-Harness image
derived from the current full Agent runtime with real Git/gh. The suite runs the
actual HTTP API, PostgreSQL queue, credential engine and Kubernetes material
delivery against two controlled repositories. It does not use a model or live
GitHub. With the [CI runner prerequisites](ci.md) prepared, run:

```bash
(
  set -e
  CREDENTIAL_TEST_RUN="$(mktemp -d)"
  printf 'Evidence directory: %s\n' "$CREDENTIAL_TEST_RUN"
  trap 'node scripts/ci/cleanup.mjs --state "$CREDENTIAL_TEST_RUN/state.json"' EXIT
  node scripts/ci/prepare.mjs --lane repository-credentials-platform \
    --state "$CREDENTIAL_TEST_RUN/state.json"
  node scripts/ci/run-tests.mjs run repository-credentials-platform \
    --state "$CREDENTIAL_TEST_RUN/state.json" \
    --results "$CREDENTIAL_TEST_RUN/results.json"
)
```

Preparation supplies the explicit kubeconfig/context, database URL, immutable
`OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM_IMAGE`, and private fixture relay
`OCC_TEST_REPOSITORY_CREDENTIALS_HOST_ADDRESS` through prepared state. The runner
selects `tests/integration/repository-credentials-platform.test.mjs` with
`OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM=1`. The lane belongs to the normal `ci`
and `full` groups. The fixture image contains a substituted Harness and makes no
model-execution claim.

The assertions cover independently scoped bindings in one Agent, natural clone
destinations, concurrent real clients, native PR creation and read-only denial.
With a push-ref policy configured, a mixed-ref push must leave upstream refs
unchanged and send no receive-pack request. This does not imply denial before
Git discovery or authentication.
They also withhold a created admission response until the real PostgreSQL claim
expires, then check recovery without bearer replay. Additional assertions inspect
private regular-file modes, retained material after worker replacement, exact
missing-Secret repair, Reader write denial and ordinary stop cleanup without
closing a sibling Agent's sessions. The credential service runs in a separate
child. Graceful restart and joined SIGKILL preserve the HTTP app, worker and
controlled provider inventories. After the crash, the replacement service rejects
the old bearer through HTTPS without provider authentication, while the exact
previously observed provider tokens remain unrevoked and unexpired.

Lost exposed sessions refuse automatic continuation of that revision. The case
checks actual Pod/container and Secret retirement alongside the retained session
attempts and their exact unresolved cleanup Work owner. A new authorized HTTP
deploy creates a distinct revision; its replacement Pod retains the workspace
PVC, unpushed commit and dirty files. This does not establish disposal of lost
provider obligations or replay Git/PR operations. Controlled service/provider
clocks then advance past hour thirteen to check fresh tokens with unchanged
material. This is a simulated
elapsed-time test, not a thirteen-hour wait or provider soak. The case skips
without its selector and fails on missing selected prerequisites.

## Qualify an installed Agent against GitHub

The [standalone live smoke](repository-credentials.md#run-an-authorized-live-smoke)
does not exercise OCC admission or a model.
Use `repository-credentials-k3d-real.test.mjs` for the joined installed path:
fresh Helm controller/PostgreSQL, API-created Namespace and Agent, worker-opened
session, private Kubernetes runtime material and the model's own
clone/edit/commit/push/native-PR task in both embedded OpenClaw and Dedicated
Codex. The Dedicated case creates a draft PR. One explicitly authorized disposable
repository is sufficient; two-repository deterministic coverage remains in the
controlled platform case.

Prepare the [real Kubernetes runtime prerequisites](kubernetes.md#kubernetes-model-turns-and-secrets).
Select the `repository-credentials-installed` lane with the same prepare/run/cleanup
sequence above. This lane is CLI-only and excluded from normal `ci`/`full` groups
and hosted workflow dispatch. It requires explicit live authorization and never
falls back to controlled evidence.

Supply existing authorized `OPENAI_API_KEY`, `OCC_TEST_OPENAI_MODEL`, and immutable
`NODE_BASE_IMAGE` (approved Node 24), `OCC_TEST_PRODUCTION_POSTGRES_IMAGE` and
`OCC_TEST_PRODUCTION_NODE_IMAGE`. Preparation builds controller and runtime from
current source, imports immutable references and supplies kubeconfig/context.
It also installs the pinned Envoy Gateway and cert-manager controllers. Dedicated
setup enables the production Helm private route and CA, admits only the observed
Envoy proxy address, and configures the disposable cluster's shared workspace
storage. OCC enrolls the native workspace node through that authenticated route.
The Helm fixture creates its own PostgreSQL; no external test database is needed.
The installed case additionally uses these variables with prefix
`OCC_TEST_REPOSITORY_CREDENTIALS_`:

| Suffix            | Required value                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `AUTHORIZED`      | `1`, explicitly permitting temporary branch/PR writes and cleanup                                     |
| `REPOSITORY`      | Exact authorized `owner/repository`                                                                   |
| `APP_CONFIG_FILE` | Protected mode-0600 JSON with only string `appId`, `githubInstallationId`, `repositoryId`             |
| `APP_KEY_FILE`    | Protected mode-0600 App PEM key                                                                       |
| `IMAGE`           | Immutable credential-service image reference                                                          |
| `UPSTREAM_CIDRS`  | Comma-separated approved public IPv4 `/32` destinations; no broad fallback                            |
| `GH_BINARY`       | Optional absolute managed host `gh` path for independently authenticated readback and guarded cleanup |

The runner sets `OCC_TEST_REPOSITORY_CREDENTIALS_REAL=1` and runs
`tests/integration/repository-credentials-k3d-real.test.mjs` from prepared state;
both execution modes must pass. To select only Dedicated against an already
prepared disposable cluster, supply the same protected inputs and immutable
image variables, then run:

```sh
OCC_TEST_REPOSITORY_CREDENTIALS_REAL=1 node --test \
  --test-name-pattern='^installed dedicated Agent' \
  tests/integration/repository-credentials-k3d-real.test.mjs
```

This selected command proves only Dedicated. The full lane retains the embedded
case and rejects skips.

Before cleanup after a failure, the test records container readiness, restart
counts, the plugin-ready marker state, and allowlisted runtime startup failure
codes. These diagnostics distinguish login and model-probe failures from later
readiness failures without exporting Pod logs, credentials, or model responses.
An unavailable diagnostic never replaces the original failure or prevents cleanup.

Dedicated uses the supported Codex `mode: yolo`, `approvalPolicy: never` and
`sandbox: danger-full-access` configuration, with `tools.exec.mode: full`, for this
authorized unattended task.
Its nonroot container, read-only root filesystem, private volume mounts and
Kubernetes NetworkPolicies remain the isolation boundary. The case checks separate
Gateway/Codex Pod identities, repository material and model-key delivery to Codex
only, and credential-service connectivity from Codex with denial from Gateway.
It pairs the Gateway's mirrored task with read-only native Codex thread evidence,
requiring completed commands, zero exit codes and matching remote commit/PR
readback. It does not start a second turn or execute repository commands from
the test runner. Dedicated task submission uses the private authenticated route
from the installed worker, which already holds its Gateway key and CA for node
enrollment. Console file transfer and Slack remain outside this shell-task proof;
see [Kubernetes testing](kubernetes.md).

The fixture installs OCC before constructing the registry, because its exact
Namespace ID comes from the API. It then enables the optional sidecar and
verifies the installed containers' credential boundaries. Only the model executes
the working clone/edit/commit/push/PR sequence; host `gh` observes the authorized
repository and reconciles owned temporary resources during cleanup. Missing
live selection skips; selected missing authorization, protected inputs, images,
networking or model credentials fails.

Record source and image identities, the admitted revision, model completion,
remote commit/PR identity and cleanup outcome together. Ordinary Agent stop,
session disposition and runtime Secret deletion are distinct from remote PR/branch
cleanup. The case is complete only when required cleanup succeeds. Test source,
rendered Helm or a ready Pod alone does not establish an installed model/live
provider result, and this case does not establish a real thirteen-hour soak.
