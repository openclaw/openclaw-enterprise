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
The `postgres-repository-broker-receipts.test.mjs` case joins the real broker,
private receipt listener and limited application role to verify confirmed disposal
and fencing across service restart. The `postgres-restart-recovery.test.mjs` and
`postgres-worker-agent-revision.test.mjs` cases cover terminal-retirement transfer,
retries and session-only repair.
These checks do not prove a running Kubernetes Pod or a model turn.

## Controller and broker image compatibility probe

Use this probe only with a disposable broker configured with a synthetic registry,
synthetic TLS and App material, and an isolated receipt socket fixture. Never
point it at a live broker or production receipt listener. The controller image
contains the entrypoint `/app/apps/controller/src/drivers/repo/github/credentials/admission-probe.mjs`.
Run it as `node <entrypoint> <control-socket> <mode> <admission-id>`, once for
`recover` and once for `reserve`. Use distinct, fresh IDs formatted as a
13-digit wall-clock millisecond timestamp, a hyphen, and a lowercase UUIDv4.

The probe calls the image's actual GitHub Repo Driver with a fixed synthetic
binding and a two-second deadline. Exit 0 returns one JSON object containing
`version: 1`, the `mode`, `admissionId`, `outcome`, and normalized `input`.
Recovery succeeds only with `outcome: "missing"`; reservation succeeds only
with `outcome: "unavailable"`. Exit 1 prints a generic error to stderr. No bearer
or provider authority is printed. Missing entrypoints, invalid requests and
unsupported broker capability fail the probe. A reserve timeout can produce an
unavailable outcome and therefore cannot qualify the pair without the matching
receipt observation.

The receipt fixture must independently record each broker request and match its
kind, admission ID, and normalized input to the report. It must respond to the
matching `recover` request with HTTP 200 and `{"kind":"missing"}`, and reject
the matching `reserve` request with HTTP 503 without acknowledging a reservation.
Require both reports and both observations. An unavailable outcome by itself is
ambiguous: it can also mean the broker or receipt listener was unreachable.
Synthetic missing proves the wire exchange, not session absence, disposal, or
PostgreSQL durability. The fixture must not create sessions or contact a provider.

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
  trap 'cleanup_exit_code=$?; trap - EXIT; node scripts/ci/cleanup.mjs --state "$CREDENTIAL_TEST_RUN/state.json" || cleanup_exit_code=1; exit "$cleanup_exit_code"' EXIT
  node scripts/ci/prepare.mjs --lane repository-credentials-platform \
    --state "$CREDENTIAL_TEST_RUN/state.json"
  node scripts/ci/run-tests.mjs run repository-credentials-platform \
    --state "$CREDENTIAL_TEST_RUN/state.json" \
    --results "$CREDENTIAL_TEST_RUN/results.json"
)
```

The command exits unsuccessfully if preparation, tests, or cleanup fails. Cleanup
verifies that the owned cluster and its matching Docker resources are absent;
on an inventory or deletion failure, retain the private state and investigate
any partially created containers, networks, or volumes before retrying cleanup. A
missing state file after preflight alone does not prove a cluster was created.

Preparation supplies the explicit kubeconfig/context, database URL, immutable
`OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM_IMAGE`, and private fixture relay
`OCC_TEST_REPOSITORY_CREDENTIALS_HOST_ADDRESS` through prepared state. The runner
selects both `repository-credentials-platform.test.mjs` and
`repository-credentials-platform-recovery.test.mjs` with
`OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM=1` and a fresh database per file. The lane belongs to the normal `ci`
and `full` groups. The fixture image contains a substituted Harness and makes no
model-execution claim.

The assertions cover independently scoped bindings in one Agent, natural clone
destinations, concurrent real clients, native PR creation and read-only denial.
With a push-ref policy configured, a mixed-ref push must leave upstream refs
unchanged and send no receive-pack request. This does not imply denial before
Git discovery or authentication.
They withhold a created admission response until the real PostgreSQL claim
expires, then check recovery without bearer replay. A separate Agent stop case
withholds a committed disposal response, kills the broker, and checks that the
worker recovers the exact receipt without issuing a replacement token. Additional assertions inspect
private regular-file modes, retained material after worker replacement, exact
missing-Secret repair, Reader write denial and ordinary stop cleanup without
closing a sibling Agent's sessions. The credential service runs in a separate
child. Graceful restart and joined SIGKILL preserve the HTTP app, worker and
controlled provider inventories. After the crash, the replacement service rejects
the old bearer through HTTPS without provider authentication, while the exact
previously observed provider tokens remain unrevoked and unexpired.

After graceful broker restart, the worker recovers confirmed disposal receipts
and replaces those sessions within the same revision while retaining the workspace.
After an abrupt crash, active receipts remain unavailable and maintenance retains
the original sessions without issuing replacements. A new authorized HTTP deploy
creates a distinct revision and retires the predecessor runtime; the unresolved
sessions remain in closing with their durable cleanup Work. The replacement Pod
retains the workspace PVC, unpushed commit and dirty files. This does not establish
disposal of lost provider obligations or replay Git/PR operations. Controlled service/provider
clocks then advance past hour thirteen to check fresh tokens with unchanged
material. This is a simulated
elapsed-time test, not a thirteen-hour wait or provider soak. The case skips
without its selector and fails on missing selected prerequisites.

## Qualify an installed Agent against GitHub

The installed GitHub journey is temporarily unavailable: its previous automatic
remote cleanup could race with changes to the branch or pull request. Preparation
and selected direct execution fail before creating resources or dispatching a task.
The procedure below describes the intended journey, which must not be used for
qualification until safe cleanup and its independent ownership are supported.

The [standalone live smoke](repository-credentials.md#run-an-authorized-live-smoke)
does not exercise OCC admission or a model.
Use `repository-credentials-k3d-real.test.mjs` for the joined installed path:
fresh Helm controller/PostgreSQL, API-created Namespace and Agent, worker-opened
session, private Kubernetes runtime material and the model's own
clone/edit/commit/push/native-PR task in both embedded OpenClaw and Dedicated
Codex. Each case creates a ready-for-review PR. One explicitly authorized disposable
repository is sufficient; two-repository deterministic coverage remains in the
controlled platform case.

Prepare the [real Kubernetes runtime prerequisites](kubernetes.md#kubernetes-model-turns-and-secrets).
Select the `repository-credentials-installed` lane with the same prepare/run/cleanup
sequence above. This lane is CLI-only and excluded from normal `ci`/`full` groups
and hosted workflow dispatch. It requires explicit live authorization and never
falls back to controlled evidence.

Supply existing authorized `OPENAI_API_KEY`, `OCC_TEST_OPENAI_MODEL`, and immutable
`OCC_TEST_PRODUCTION_POSTGRES_IMAGE` and `OCC_TEST_PRODUCTION_NODE_IMAGE`.
By default, preparation builds controller and runtime from current source; supply
an immutable `NODE_BASE_IMAGE` for approved Node 24. To select released images
instead, set `OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE_MODE=release` and supply both
`OCC_TEST_PRODUCTION_CONTROLLER_IMAGE` and `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`
as immutable `image@sha256:` references. Missing or mutable selections fail
before resources are created. Select a chart and credential-service image
compatible with the release; this lane uses the chart in the checked-out source.

Preparation verifies the supplied registry digests against Docker, imports the
selected platform images into the disposable cluster, and supplies kubeconfig and
context. Docker archive import can produce a different platform-manifest digest:
retain the private preparation state and record its source references, host image
IDs and imported references alongside the separately observed worker and broker
Pod image IDs. The worker image comes from its actual container status, including
restartable init-container status when present. Agent-stop disposal is
not evidence of graceful broker shutdown or recovery after forced termination.
This local import does not prove that a production registry serves an identical manifest;
verify production pull and deployed image identity separately. Preparation also
installs the pinned Envoy Gateway and cert-manager controllers. Dedicated
setup enables the production Helm private route and CA, admits only the observed
Envoy proxy address, and uses stock local-path RWO Harness storage. OCC enrolls the native workspace node through that authenticated route.
The Helm fixture creates its own PostgreSQL; no external test database is needed.
It grants the existing operator roles in both tenant and control-plane namespaces
and gives the Gateway 2 GiB for first-request plugin loading. Tool evidence uses
the latest result for the exact call, or a successful poll of its exact process
session. An earlier error alone neither proves success nor hides a later completion.
The installed case additionally uses these variables with prefix
`OCC_TEST_REPOSITORY_CREDENTIALS_`:

| Suffix            | Required value                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `AUTHORIZED`      | `1`, explicitly permitting temporary branch/PR writes                                     |
| `REPOSITORY`      | Exact authorized `owner/repository`                                                       |
| `APP_CONFIG_FILE` | Protected mode-0600 JSON with only string `appId`, `githubInstallationId`, `repositoryId` |
| `APP_KEY_FILE`    | Protected mode-0600 App PEM key                                                           |
| `IMAGE`           | Immutable credential-service image reference                                              |
| `UPSTREAM_CIDRS`  | Comma-separated approved public IPv4 `/32` destinations; no broad fallback                |
| `GH_BINARY`       | Optional absolute managed host `gh` path for independently authenticated readback         |

The runner sets `OCC_TEST_REPOSITORY_CREDENTIALS_REAL=1` and runs
`tests/integration/repository-credentials-k3d-real.test.mjs` from prepared state;
all three scenarios must pass. To select only Dedicated against an already
prepared disposable cluster, supply the same protected inputs and immutable
image variables, then run:

```sh
OCC_TEST_REPOSITORY_CREDENTIALS_REAL=1 node --test \
  --test-name-pattern='^installed dedicated ' \
  tests/integration/repository-credentials-k3d-real.test.mjs
```

This selected command exercises both Dedicated scenarios. The full lane retains
the embedded case and rejects skips. A selected run must supply the prepared
`OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE` and use the same owned cluster.

Before cleanup after a failure, the test records container readiness, restart
counts, the plugin-ready marker state, and allowlisted runtime startup failure
codes. These diagnostics distinguish login and model-probe failures from later
readiness failures without exporting Pod logs, credentials, or model responses.
An unavailable diagnostic never replaces the original failure or prevents cleanup.

Preparation derives the reviewed, version-pinned Codex seccomp profile from
each disposable k3d node's RuntimeDefault policy. It verifies that RuntimeDefault
blocks the sandbox and that the derived Localhost profile permits the actual
sandbox probe; an unsupported Codex version fails preparation. The Dedicated
Agents use `mode: guardian`, `approvalPolicy: never`, and
`sandbox: workspace-write`. Each model turn runs a native workspace write and
an attempted write to a separately seeded outside-workspace file; the test checks
the command's denial and independently reads both files. It verifies the selected
Localhost profile on the Agent container. This is local k3d evidence, not a
production-node seccomp qualification.

The full-access binding must clone, fetch, commit, push and create a ready-for-review PR.
A separate `git-read` Agent must clone and fetch the same repository, then
receive the broker's HTTP 400 denial on one push; independent provider readback
must show no new branch. Both bind native command completions to the Gateway's
mirrored turn. The full-access case also matches the remote commit and PR.
The fixture checks separate Gateway/Codex Pod identities, repository material and
model-key delivery to Codex only, and credential-service connectivity from Codex
with denial from Gateway. The test runner observes and stops the local Agent but does not
execute the repository task or reconcile remote resources. Dedicated task submission uses the private
authenticated route from the installed worker. Console file transfer and Slack
remain outside this shell-task proof; see [Kubernetes testing](kubernetes.md).

The fixture installs OCC before constructing the registry, because its exact
Namespace ID comes from the API. It then enables the optional sidecar and
verifies the installed containers' credential boundaries. Only the model executes
the working clone/edit/commit/push/PR sequence; host `gh` observes the authorized
repository. Remote reconciliation requires an independent operator. Missing
live selection skips; selected missing authorization, protected inputs, images,
networking or model credentials fails.

Record source and image identities, the admitted revision, model completion,
remote commit/PR identity and cleanup outcome together. Ordinary Agent stop,
session disposition and runtime Secret deletion are distinct from remote PR/branch
cleanup. The case is complete only when required cleanup succeeds. Test source,
rendered Helm or a ready Pod alone does not establish an installed model/live
provider result, and this case does not establish a real thirteen-hour soak.
