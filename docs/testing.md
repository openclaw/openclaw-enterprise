# Testing

Choose a suite by the behavior you need to verify. Local conformance and API
tests need no provider credentials. PostgreSQL, image, Kubernetes, and real
model tests require the setup below. Run commands from the repository root.

## Run tests

| Command                 | Tests selected                                                            |
| ----------------------- | ------------------------------------------------------------------------- |
| `pnpm test`             | All conformance and integration tests.                                    |
| `pnpm test:conformance` | Conformance tests only.                                                   |
| `pnpm test:integration` | Integration tests only, including infrastructure and real-runtime suites. |

`pnpm test` selects every conformance and integration file. A green result can
include skipped infrastructure tests; it is not proof that every integration
ran. Run prepared infrastructure suites by exact filename, one suite at a time.
The `pnpm test`, `pnpm test:conformance`, `pnpm test:integration`, and
`pnpm test:postgres` scripts run `scripts/verify-workspace-boundary.mjs` before
the Node.js test runner.

Keep their variables scoped to a subshell or one test process. In particular,
the OpenShell suite detects **any** configured test database, Kubernetes context,
or runtime image as selection, then requires its explicit opt-in and full setup.
Running `pnpm test:integration` after exporting only `OCC_TEST_DATABASE_URL` can
therefore fail in OpenShell. Setting `OCC_TEST_OPENSHELL_K3D_REAL=0` does not
override that selection behavior.

## Integration Tests

Each linked section contains the setup requirements and commands for that suite.

| Suite                    | What it verifies                                                                                                                      | Setup and commands                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Local API and lifecycle  | HTTP routes, authentication, startup, worker behavior, Driver packages, and local process boundaries.                                 | [Local checks](#local-checks)                                             |
| PostgreSQL               | Real persistence, constraints, authentication, API keys, Secret metadata, queue claims, recovery, and production bootstrap.           | [PostgreSQL](#postgresql)                                                 |
| Images and Helm          | Built controller modules, runtime startup, and rendered production packaging.                                                         | [Images and Helm](#images-and-helm)                                       |
| Docker Compose           | Real PostgreSQL, API, worker, isolated containers, and embedded OpenClaw plus dedicated Codex model turns.                            | [Docker Compose model turns](#docker-compose-model-turns)                 |
| SSH raw hosts            | Real SSH, systemd, embedded OpenClaw readiness, revision cutover, state persistence, retirement, and deletion; no model turn.         | [SSH raw hosts](#ssh-raw-hosts)                                           |
| Kubernetes HTTP fixture  | Real Kubernetes API, RBAC, ownership, revision routing, namespace preservation, and enforced NetworkPolicies.                         | [Kubernetes HTTP fixture](#kubernetes-http-fixture)                       |
| Kubernetes real runtimes | Dedicated Codex, embedded OpenClaw, shared workspace, Secret API delivery, rotation, authorization, and focused workspace-file proof. | [Kubernetes model turns and Secrets](#kubernetes-model-turns-and-secrets) |
| Slack                    | Actual Socket Mode ingress and a gateway-authored reply through dedicated Codex.                                                      | [Slack](#slack)                                                           |
| ChatGPT service accounts | Actual provider account creation, credential issuance, exact Agent delivery, and a model turn.                                        | [ChatGPT service accounts](#chatgpt-service-accounts)                     |
| OpenShell Sandbox        | Provider-owned dedicated Harness execution and filesystem/network enforcement through real tools.                                     | [OpenShell Sandbox](#openshell-sandbox)                                   |

## GitHub Actions

The [suite map](../scripts/ci/test-suites.json) assigns each active test file to exactly one lane, with its required inputs and preparation resources. Check its coverage after adding or renaming tests:

```sh
node scripts/ci/run-tests.mjs audit
```

Both workflows reuse the [run-ci-lane action](../.github/actions/run-ci-lane/action.yml) for setup, tests and cleanup; each job retains its own environment and credentials.

The PR workflow runs exactly five lanes on ephemeral runners: checks/baseline/browser, PostgreSQL, image/packaging, Kubernetes fixture/Configuration, and logging collector. Full Integration runs only through manual dispatch from `main`, using that immutable commit and the selected lane’s protected environment. The ChatGPT `provider-account` lane keeps its main-only credential environment without per-run approval. Other model, routing, Slack, OpenShell, and additional OpenTelemetry lanes require separately approved environments. A missing environment or selected prerequisite fails the run. A PR aggregate is not full credentialed coverage; targeted protected runs also report only their selected lanes.

Implementation status: routing, OpenShell, and logging now have concrete CI preparation contracts. Routing installs pinned Gateway API, cert-manager v1.18.4, and Envoy Gateway v1.6.7 controller manifests and generates a private test CA. OpenShell creates an owned K3s v1.36.4 cluster, installs a matched kubectl, configures the selected RuntimeClass with the cluster's `runc` handler, verifies handler availability with a smoke Pod, installs OpenShell CLI/chart assets, imports gateway and supervisor images, and installs Agent Sandbox resources. Only the disposable CI OpenShell cluster exempts its selected RuntimeClass from Pod Security Admission. Preparation proves that a violating ordinary Pod is rejected in a restricted namespace and that the same Pod is admitted with the selected class. The full OpenShell suite proves provider-owned supervisor enforcement for filesystem, endpoint/L7 network, and process boundaries while preserving the current binary-unaware sidecar policy. Logging preparation owns a real OpenTelemetry Collector backend with JSONL evidence, and `OCC_TEST_OTEL_LOGS_URL` is no longer a required external input. The Collector and Docker-model jobs use the shared [setup-test-docker action](../.github/actions/setup-test-docker/action.yml) to pin Docker 29.4.0, which supports the production `fluentd-write-timeout` logging option. The action stops the preinstalled daemon on the ephemeral runner, installs Docker 29.4.0 through the SHA-pinned official Docker setup action, and points `/var/run/docker.sock` at the action socket so the CLI, production Compose, and Driver use one daemon. Other jobs keep the runner Docker daemon. Full-suite acceptance remains incomplete until main-only protected hosted execution records every selected lane. See the [delivery status](../specs/19-github-actions-test-coverage.md#delivery-status) for current proof boundaries and live gaps.

Each lane runs whole test files. The runner validates actual Node case results and required names; any skip or TODO fails a selected lane. Missing results, zero cases, failures and cleanup errors also fail. The aggregate checks required job and lane results at the same source commit without repeating case validation. Ordinary `pull_request` jobs may save pnpm-store caches within the PR merge-ref scope; protected jobs use trusted main inputs.

Prepare infrastructure only on a disposable host or through the reviewed CI helpers. Each run owns its Compose project, file-specific databases, cluster and temporary files. CI writes private cleanup state under `RUNNER_TEMP` and uploads only sanitized result JSON, so hosted-runner cleanup state is unavailable after the job ends. Local failures can retain cleanup state while the host and state path still exist. On local Docker Desktop or equivalent VM-backed Docker hosts, run one Kubernetes lane at a time when disk or network pressure has caused measured instability. The GitHub matrix remains parallel; this local guidance is for reproducible operator runs. Model/service tests require the approved credentials and spend policy described in the [implementation specification](../specs/19-github-actions-test-coverage.md); configuring workflow files does not prove those tests have passed.

See the [execution flow](flows/github-actions-testing.md) for entrypoints, result accounting, cleanup and failure interpretation. Existing suite-specific setup below remains the local reproduction contract.

### Integration coverage by trigger

The [CI workflow](../.github/workflows/ci.yml) runs five noncredentialed lanes on
pull requests, pushes to `main`, merge groups, and manual dispatch.
[Full Integration](../.github/workflows/full-integration.yml) runs only through
manual dispatch from `main`, using the requested lane or `all`. It does not run
on pushes or merges. The `provider-account` lane remains manual because its
configured admin credential cannot authenticate from the hosted runner.

### Integration tests outside automatic CI

The ten integration files below have no automatic workflow entrypoint.
A green `CI Required` check does not establish their coverage. This inventory describes workflow selection, not
whether a test has ever passed in a local or hosted run.

#### Manual Full Integration lanes

In GitHub Actions, these nine files run only when explicitly selected in
[Full Integration](../.github/workflows/full-integration.yml) from `main`, using
the listed lane or `all`. The model/service lanes require their configured
credentials and infrastructure. All credentialed lanes except `provider-account`
require protected-environment approval; `provider-account` remains restricted to
`main` without per-run approval. `helper-timeout`
has no environment approval gate; it is separate because it spends five minutes
testing the real helper deadline.

| Lane               | Integration test file                                                                                         | Coverage absent from automatic CI                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `docker-model`     | [docker-compute-real.test.mjs](../tests/integration/docker-compute-real.test.mjs)                             | Docker Compose deployment and real embedded OpenClaw/dedicated Codex model turns.                                        |
| `k3d-model`        | [harness-topology-k3d-real.test.mjs](../tests/integration/harness-topology-k3d-real.test.mjs)                 | Dedicated Codex continuity across Pod replacement and embedded model turns with persisted credentials or the Secret API. |
| `gateway-routing`  | [harness-topology-k3d-routing-real.test.mjs](../tests/integration/harness-topology-k3d-routing-real.test.mjs) | Dedicated Codex consumption of workspace files through the real Envoy/OCC route.                                         |
| `production-tui`   | [production-tui-k3d-real.test.mjs](../tests/integration/production-tui-k3d-real.test.mjs)                     | Helm-installed production control plane, interactive TUI, and revision cutover.                                          |
| `slack`            | [harness-topology-k3d-slack-real.test.mjs](../tests/integration/harness-topology-k3d-slack-real.test.mjs)     | Real Slack ingress and a gateway-authored reply through the approved proxy and Codex Agent.                              |
| `provider-account` | [service-account-driver-real.test.mjs](../tests/integration/service-account-driver-real.test.mjs)             | Actual ChatGPT service-account creation, credential delivery, and a dedicated Codex model turn.                          |
| `openshell`        | [sandbox-driver-openshell-k3d-real.test.mjs](../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs) | Provider-owned dedicated Codex Harness and real OpenShell sandbox enforcement.                                           |
| `helper-timeout`   | [dev-up-timeout.test.mjs](../tests/integration/dev-up-timeout.test.mjs)                                       | Full 300-second readiness deadline for a running but unready worker.                                                     |
| `k3d-otel`         | [harness-topology-k3d-otel-real.test.mjs](../tests/integration/harness-topology-k3d-otel-real.test.mjs)       | Actual OTLP logs emitted during embedded and dedicated runtime model turns.                                              |

#### No GitHub workflow entrypoint

[ssh-compute-real.test.mjs](../tests/integration/ssh-compute-real.test.mjs) belongs
to the `ssh-host` lane, which is excluded from both the `ci` and `full` groups
and is not a Full Integration dispatch option. No current workflow provisions
its disposable Linux/systemd SSH host or invokes that lane. It proves real-host
readiness, revision cutover, state isolation/persistence, and deletion, without a
model call. Follow [SSH raw hosts](#ssh-raw-hosts) for the disposable host,
required environment settings, and direct test command.

Every current `tests/integration/*.test.mjs` file has a suite-map owner. Ownership
alone does not mean a workflow runs it; keep this list aligned with both the
suite-map groups and workflow entrypoints.

## Console browser checks

The [console](reference/console.md) uses real controller routes in
`tests/integration/console-api.test.mjs`, `tests/browser/console.test.mjs`, and
`tests/browser/console-agents.test.mjs`. The shared browser fixture runs
Fastify, Better Auth memory storage, Native IAM, and in-memory platform storage
on an ephemeral loopback port. Configuration and Compute helpers are test-only.
The Agent browser suite seeds active revision pointers only to render admitted
history; that fixture does not prove runtime dispatch, worker leases, Compute
Driver effects, PostgreSQL persistence, live Provider health, or deployed Agent
runtime behavior.

Run the API/static boundary checks without a browser:

```sh
node --test tests/integration/console-api.test.mjs
```

On a host approved for browser automation, provision Playwright's Chromium and
run the dedicated browser suite:

```sh
pnpm exec playwright install chromium
pnpm test:console-browser
```

`OCC_TEST_BROWSER_EXECUTABLE` optionally selects an approved existing browser
executable. The suite always uses a fresh context. Browser setup is explicit;
the test command does not install software or silently skip a missing browser.
Do not change managed browser policies to make the suite run. A managed Chrome
debugging policy can currently block the browser suite on locked-down hosts; use
an approved browser environment instead. Set `OCC_TEST_CONSOLE_ARTIFACT_DIR` to
retain screenshots at a chosen path; otherwise the suite uses a temporary
directory. The existing
[image smoke test](#images-and-helm) also loads console assets from the built
controller image; it does not claim a live production deployment.

## Requirements and credentials

Use Node.js 24 or newer and the pnpm version pinned in
[`package.json`](../package.json), with dependencies installed from the lockfile:

```sh
pnpm install --frozen-lockfile
```

The tests import TypeScript source directly; a separate build is not required
to invoke them. Some local integrations also execute Git, `tar`, and pnpm. The
Driver-package test installs local fixture archives offline into temporary
directories with lifecycle scripts disabled.

| Input you supply                                                        | Used by                                                          | Where it comes from                                                                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                                        | Docker, ordinary Kubernetes runtime tests, Slack, and OpenShell. | An existing authorized provider credential with access to the selected model.                                                                                                 |
| `OCC_TEST_CHATGPT_ADMIN_KEY_PATH` and `OCC_TEST_CHATGPT_WORKSPACE_ID`   | Real ChatGPT service-account test.                               | A protected file containing an authorized workspace admin key, plus its exact workspace ID. The test issues the Agent's credential itself; it does not need `OPENAI_API_KEY`. |
| `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `OCC_TEST_SLACK_SENDER_BOT_TOKEN` | Slack test only.                                                 | An existing Socket Mode app, its bot, and a distinct sender bot in the same workspace and test channel.                                                                       |
| Application-role database URLs                                          | PostgreSQL and Kubernetes integrations.                          | The disposable local databases prepared below. The documented local passwords are development fixtures, not production credentials.                                           |
| Dedicated kubeconfig                                                    | Kubernetes integrations.                                         | The disposable cluster prepared below, with authority to provision the test's scoped resources and RBAC.                                                                      |

Tests generate their own local login credentials, session secrets, transport
tokens, and scoped Kubernetes Secrets. The Kubernetes Secret API case also
provisions its test IAM grants, after proving deployment is denied without the
Agent's exact `operate` grant. You do **not** need to prepare Agent-specific
Secrets or manually grant native IAM access before running that case. This
test setup does not provide a public IAM-management interface; see the
[Secret binding requirements](reference/drivers/kubernetes-secret.md#bind-a-secret-to-gateway-environment).

Supply real keys through your authorized credential manager or an existing
private environment file. Test entrypoints do not automatically load `.env`.
For example, after preparing a file outside the repository:

```sh
TEST_ENV_FILE=/absolute/path/to/private/runtime-test.env
chmod 600 "$TEST_ENV_FILE"
node --env-file="$TEST_ENV_FILE" --test tests/integration/docker-compute-real.test.mjs
```

That file must contain the inputs for the selected suite, including its opt-in
and images. Node passes the loaded environment to test subprocesses. Existing
exported values take precedence over the file, so avoid stale selectors or keys
in the parent shell. Do not print credentials, commit them, or include them in
command-line arguments. For the ChatGPT admin key, use its dedicated file-path
option as shown below.

Model suites make real provider requests. Set `OCC_TEST_OPENAI_MODEL` explicitly
to an authorized model that supports Codex custom tools; the Kubernetes examples
use `gpt-5.1`. Docker, OpenShell, and ChatGPT account suites default to
`gpt-5.6-sol`. The Kubernetes Harness defaults to `gpt-4.1`, which does not
support the documented dedicated Codex request shape; override it when running
that suite. ChatGPT account tests require a model available to the issued
account's Codex credentials.

## Local checks

With infrastructure selectors unset:

```sh
pnpm check:workspace
pnpm format:check
pnpm typecheck
pnpm openapi:check
pnpm test:conformance
pnpm test:integration
```

`check:workspace` checks the active workspace.
The test scripts above run the same canonical workspace verification before
their selected Node.js tests. `openapi:check` compares generated routes and both
API artifacts with the checked-in versions. `typecheck` and `build` currently
invoke the same TypeScript build command.

The [conformance tests](../tests/conformance/) cover domain rules and selected
Driver contracts. Kubernetes conformance tests use fixtures and rendered
resources; they do not exercise a live cluster.
SSH conformance executes the real host helper with local transport, a fixture
`systemctl` that starts loopback readiness listeners, and a fixture `flock`
that wraps the same `flock(2)` syscall because macOS lacks util-linux `flock`.
Account-management fixtures exercise ownership and failure handling. They do
not prove OS account isolation, SSH reachability, real systemd, util-linux
`flock`, or real OpenClaw.

The local [integration tests](../tests/integration/) include these groups:

- `occ-api`, `configuration-controller`, `secret-api`, and `service-api-keys`:
  actual Fastify routes with test Drivers and in-memory state.
- `controller-lifecycle`, `configuration-startup`, `secret-driver-startup`, and
  `sandbox-driver-startup`: admission, lifecycle, and startup validation.
- `production-controller-security` and `production-healthcheck`: internal
  request admission, HTTP cancellation, and readiness-marker behavior.
- `driver-plugin-installation` and `git-hooks`: local package installation,
  Driver selection, and hook installation/preservation in temporary checkouts.
- `compute-singleton-worker`: two local validation cases. The six database-backed
  cases live in `compute-singleton-worker-postgres` and require `OCC_TEST_DATABASE_URL`.

To target a file or one named case:

```sh
node --test tests/integration/secret-api.test.mjs
node --test --test-name-pattern='part of the test name' tests/integration/secret-api.test.mjs
```

## PostgreSQL

Requires Docker Compose. Use disposable databases: tests can initialize or
change singleton platform state. The production bootstrap database must be
migrated and contain no Installation.

The following creates three new databases: general tests, production bootstrap,
and Kubernetes. If any name already exists, choose a new test name and update
the corresponding URL; do not drop an existing database to make setup pass.

```sh
pnpm db:up

(
  set -eu
  for test_database in openclaw_test_local openclaw_bootstrap_local openclaw_k8s_local; do
    docker compose -f compose.postgres.yaml exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "CREATE DATABASE $test_database"
    docker compose -f compose.postgres.yaml exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U postgres -d "$test_database" \
      -c "GRANT CREATE ON DATABASE $test_database TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;"
    OCC_MIGRATION_DATABASE_URL="postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/$test_database" \
      pnpm db:migrate
  done
)
```

Compose provisions the local `occ_migrator` and `occ_app` roles. Run migrations
as `occ_migrator` and the tests as the less-privileged `occ_app`. Queue coverage
uses `OCC_TEST_DATABASE_URL` with the other `pg.Pool`-backed PostgreSQL tests;
production bootstrap still needs its own URL:

```sh
(
  export OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_test_local
  export OCC_PRODUCTION_WIREUP_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_bootstrap_local
  pnpm test:postgres
  node --test tests/integration/compute-singleton-worker-postgres.test.mjs
)
```

The two PostgreSQL URLs select different coverage. Omitting the general URL
skips most persistence tests, including queue coverage; omitting
`OCC_PRODUCTION_WIREUP_DATABASE_URL` skips production bootstrap. `test:postgres`
does not include the singleton-worker file, hence the second command.

Four optional live Configuration cases additionally require
`OCC_TEST_KUBERNETES_CONFIGURATION=1` and an already configured live Kubernetes
Configuration Driver in the subprocess startup environment. The flag alone
does not configure that Driver. A pre-bootstrap case also skips if its database
already has an Installation. See [PostgreSQL settings](reference/settings.md#postgresql-test-environment).

For a repeat of production bootstrap, prepare a fresh migrated database and
change its URL. Keep the general and bootstrap databases separate.

## Images and Helm

Build the [runtime image](../deploy/runtime/README.md), then run its startup smoke:

```sh
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:test deploy/runtime
OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime:test \
  node --test tests/integration/runtime-image-startup.test.mjs
```

This checks gateway readiness and bundled Codex/Slack plugin loading from a
fresh runtime home, then initializes the image's real Codex app-server through
the installed plugin's version guard. The smoke runs offline without provider
credentials. It does not make a model call or establish a Slack connection;
run the [live Slack test](#slack) for channel delivery proof.

Build the controller image using the [production prerequisites](guides/deploy.md#production-prerequisites),
then set `OCC_TEST_PRODUCTION_IMAGE` to the local tag you built:

```sh
OCC_TEST_PRODUCTION_IMAGE=openclaw-enterprise:reviewed \
  node --test tests/integration/production-image-startup.test.mjs
```

The controller smoke intentionally uses an unreachable database with networking
disabled. It verifies module loading and packaged OpenShell protocol assets;
the expected database error is the boundary being tested.

With Helm and a `yq` executable supporting `eval-all -o=json` installed:

```sh
node --test tests/integration/production-kubernetes-packaging.test.mjs
```

This renders the chart and verifies configuration, RBAC, networking, credential
placement, and bootstrap ordering. It does not install the chart. Missing Helm
or `yq` skips this suite; unset image selectors skip the image smokes.

## Docker Compose model turns

Requires Docker Engine, Compose, the built runtime image, host Python 3 with
PTY support, and an exported `OPENAI_API_KEY` or a private environment file
supplying it. The suite creates and migrates its own Compose database; the
separate PostgreSQL setup above is not required.

```sh
OCC_TEST_DOCKER_COMPUTE_REAL=1 \
OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:test \
OCC_TEST_OPENAI_MODEL=gpt-5.6-sol \
  node --test tests/integration/docker-compute-real.test.mjs
```

Both the embedded and dedicated paths must produce provider-backed responses.
The test also checks authentication, isolation, Agent deletion, invalid-token
TUI rejection, two same-session TUI replies, and Ctrl+D TUI exit while the
gateway remains ready. It generates its own Compose project, ports, network
range, and local administrator, then removes its project volumes and labelled
containers/networks.

An image selector also enables the suite without the opt-in flag. Missing
Docker, images, or the model credential then fails the run. Explicitly select
an image rather than relying on the test's historical local-image fallback.
See [Docker test settings](reference/settings.md#docker-compose-development-test-environment)
for separate gateway and Agent images.

## SSH raw hosts

The `checks-baseline` CI lane runs SSH conformance and startup coverage. The
`ssh-host` lane selects the real-host test with required operator-provided SSH
settings. It is not part of the `ci` or `full` groups because those jobs do not
provision an SSH host.
Prepare the disposable rig below before selecting this lane; missing inputs or
skipped tests fail the lane.

The bundled [SSH Compute Driver](reference/drivers/ssh-compute.md) has an opt-in
real-host integration. Use a disposable Linux systemd host only. The test
checks gateway readiness, two-revision cutover, state persistence, retirement,
and Namespace deletion over real SSH. It also checks distinct Agent UID/GID
assignments and sibling state/configuration read denial using Linux `runuser`. It makes no model call and needs no
model credential. The ordinary local test command reports an explicit skip:

```sh
node --test tests/integration/ssh-compute-real.test.mjs
```

The fixture image builds on the runtime image's `node:24-bookworm` base and
adds systemd as PID 1, sshd, an `openclaw` system user, and the pinned
OpenClaw/Codex packages from
[`deploy/runtime/Dockerfile`](../deploy/runtime/Dockerfile); it builds on amd64
and arm64. Start it on a Docker Engine with privileged systemd/cgroup support
(Docker Desktop on Apple silicon works). This privileged container is a
disposable test rig, not production packaging. If the Engine cannot run
systemd, use an explicitly selected disposable Linux VM instead; do not
substitute the conformance fixture and call it host proof.

```sh
SSH_RIG=$(mktemp -d)
chmod 700 "$SSH_RIG"
ssh-keygen -q -t ed25519 -N '' -f "$SSH_RIG/id_ed25519"
docker build -t oce-ssh-host:local tests/fixtures/ssh-compute/host
docker run -d --name oce-ssh-host --privileged --cgroupns=host \
  --tmpfs /run --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --mount "type=bind,src=$SSH_RIG/id_ed25519.pub,dst=/run/occ-authorized_keys,readonly" \
  -p 127.0.0.1:22222:22 oce-ssh-host:local
docker exec oce-ssh-host install -o root -g root -m 600 \
  /run/occ-authorized_keys /root/.ssh/authorized_keys
docker exec oce-ssh-host systemctl is-active ssh
docker exec oce-ssh-host cat /etc/ssh/ssh_host_ed25519_key.pub \
  | awk '{ print "[127.0.0.1]:22222 " $1 " " $2 }' > "$SSH_RIG/known_hosts"
chmod 600 "$SSH_RIG/known_hosts"
```

The read-only `/run/occ-authorized_keys` mount is the fixture's public-key
input; copying it gives sshd's `/root/.ssh/authorized_keys` the required root
ownership and mode. Root login permits keys only (`PermitRootLogin
prohibit-password`). The known-host entry above comes directly from this
task-owned container, without disabling strict host-key verification. Wait for
`systemctl is-active ssh` to report `active` before selecting the suite.

```sh
OCC_TEST_SSH_REAL=1 \
OCC_TEST_SSH_ADDRESS=127.0.0.1 \
OCC_TEST_SSH_PORT=22222 \
OCC_TEST_SSH_USER=root \
OCC_TEST_SSH_IDENTITY_FILE="$SSH_RIG/id_ed25519" \
OCC_TEST_SSH_KNOWN_HOSTS_FILE="$SSH_RIG/known_hosts" \
OCC_TEST_SSH_NODE_PATH=/usr/local/bin/node \
OCC_TEST_SSH_OPENCLAW_PATH=/opt/openclaw/current/dist/index.js \
OCC_TEST_SSH_RUNTIME_USER=openclaw \
OCC_TEST_SSH_ROOT=/var/lib/openclaw-enterprise \
OCC_TEST_SSH_UNIT_DIRECTORY=/etc/systemd/system \
node --test tests/integration/ssh-compute-real.test.mjs
```

The gateway port range is `18800`–`18899`; it is checked on the host through
SSH and does not need a published container port. The suite creates unique
Namespace and Agent identities and removes only its Namespace and units. When
selected, missing settings, unreachable SSH, failed systemd, or unready OpenClaw
fail the test. Successful local conformance or an unselected skip does not
establish real-host proof; rerun this suite after changing the Driver, helper,
or fixture.

After testing, remove only the rig and its generated keys:

```sh
docker rm -f oce-ssh-host
rm -r "$SSH_RIG"
```

See [SSH test settings](reference/settings.md#ssh-real-host-test-environment)
for every input and default. Inspect the Agent's exact unit with `journalctl -u`
inside the container when readiness fails; keep logs free of credential values.

## Kubernetes HTTP fixture

Requires Docker, k3d, `kubectl`, and the migrated `openclaw_k8s_local` database
from [PostgreSQL](#postgresql). Create a new disposable cluster; if `oce` already
exists, use a new name consistently throughout these commands.

```sh
mkdir -m 700 -p /tmp/oce-k3d
k3d cluster create oce \
  --api-port 127.0.0.1:6443 \
  --kubeconfig-update-default=false \
  --kubeconfig-switch-context=false
k3d kubeconfig get oce > /tmp/oce-k3d/kubeconfig
chmod 600 /tmp/oce-k3d/kubeconfig

docker build --pull=false -t oce-fixture:local tests/fixtures/kubernetes
k3d image import oce-fixture:local -c oce

OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-k3d/kubeconfig \
OCC_TEST_KUBERNETES_CONTEXT=k3d-oce \
OCC_TEST_KUBERNETES_IMAGE=oce-fixture:local \
OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_k8s_local \
  node --test tests/integration/kubernetes-compute-real.test.mjs
```

All three fixture cases must run: Driver lifecycle/isolation, externally managed
namespace preservation, and PostgreSQL API-plus-worker reconciliation. No model
key is needed. Missing all cluster selectors skips the suite; partial selectors
fail, and a missing database skips the API-plus-worker case.

The tests require an explicit loopback `k3d-*` context and enforcing
NetworkPolicies. They create scoped RBAC and resources, and configure the
selected cluster's local-path provisioner for shared filesystem tests. Because
that changes cluster-wide storage configuration, use a disposable cluster.

## Kubernetes model turns and Secrets

Use the disposable cluster and `openclaw_k8s_*` database above, an exported
`OPENAI_API_KEY`, and approved real gateway/Codex images. Import local image
tags, then register their corresponding immutable references inside k3s.
Replace the placeholders with the exact tags and digest references for your
images:

```sh
k3d image import '<local-gateway-tag>' '<local-codex-tag>' -c oce
docker exec k3d-oce-server-0 ctr -n k8s.io images tag \
  '<imported-gateway-image>' '<gateway-image>@sha256:<digest>'
docker exec k3d-oce-server-0 ctr -n k8s.io images tag \
  '<imported-codex-image>' '<codex-image>@sha256:<digest>'
```

Prepare a private runtime environment file with the model key and these
nonsecret settings, using the actual digest references:

```dotenv
OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-k3d/kubeconfig
OCC_TEST_KUBERNETES_CONTEXT=k3d-oce
OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_k8s_local
OCC_TEST_KUBERNETES_GATEWAY_IMAGE=<gateway-image>@sha256:<digest>
OCC_TEST_KUBERNETES_AGENT_IMAGE=<codex-image>@sha256:<digest>
OCC_TEST_OPENAI_MODEL=gpt-5.1
```

Workspace-file conformance and Helm rendering are separate from the real
private-routing proof. The focused case requires Envoy Gateway v1.6.7 and
cert-manager controllers/CRDs in the selected disposable cluster, in addition
to the database, native gateway/Codex images, and authorized model credential.
It must use the real Envoy data plane; a hand-built TLS proxy does not exercise
the supported routing or authentication implementation.

The focused proof creates an Agent through production OCC composition, waits
for Compute's automatic HTTPRoute, writes and reads all four supported files,
and asks a fresh native session for the marker supplied only through
`AGENTS.md`. It then replaces the gateway Pod and repeats file reads and fresh
model consumption. Proxy authentication denials, key rotation, and cert-manager
leaf renewal under the same CA are separate required assertions.

For CI-shaped setup, let `prepare.mjs` install the pinned Gateway API,
cert-manager v1.18.4, and Envoy Gateway v1.6.7 controllers, then create the
disposable test CA before `run-tests.mjs` invokes the case:

```sh
node scripts/ci/prepare.mjs \
  --lane gateway-routing \
  --state "$RUNNER_TEMP/state/gateway-routing.json" \
  --github-env "$GITHUB_ENV"
node scripts/ci/run-tests.mjs run gateway-routing \
  --state "$RUNNER_TEMP/state/gateway-routing.json" \
  --results "$RUNNER_TEMP/results/gateway-routing.json"
```

For local manual setup, install the same controllers into the disposable
cluster first. The fixture creates its own GatewayClass, CA Issuer, Gateway,
and service-key Secret. The default controller namespaces are
`envoy-gateway-system` and `cert-manager`; override them with
`OCC_TEST_ENVOY_GATEWAY_NAMESPACE` and `OCC_TEST_CERT_MANAGER_NAMESPACE` when
needed. Helm must be on `PATH` or selected by `OCC_HELM_BIN`.

When preparing the CA manually, create a disposable test CA before starting Node
so its ordinary TLS verifier trusts the cert-manager-issued leaf. Do not use a
production CA signing key:

```sh
umask 077
TEST_GATEWAY_CA_DIR=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
  -subj '/CN=OCC disposable routing test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$TEST_GATEWAY_CA_DIR/key.pem" \
  -out "$TEST_GATEWAY_CA_DIR/cert.pem"
export OCC_TEST_GATEWAY_CA_CERT_PATH="$TEST_GATEWAY_CA_DIR/cert.pem"
export OCC_TEST_GATEWAY_CA_KEY_PATH="$TEST_GATEWAY_CA_DIR/key.pem"
export NODE_EXTRA_CA_CERTS="$TEST_GATEWAY_CA_DIR/cert.pem"

OCC_TEST_GATEWAY_ROUTING_REAL=1 OCC_TEST_SLACK_LIVE=0 \
  node --env-file="$TEST_ENV_FILE" --test \
  tests/integration/harness-topology-k3d-routing-real.test.mjs
```

The focused fixture currently requires Docker Desktop and free local port 443.
Docker publishes that loopback port without running the test process as root.
TCP forwarders carry unchanged TLS bytes through `host.docker.internal` and a
Pod to the real Envoy listener, providing a genuine nonloopback downstream peer.
They do not implement HTTP,
authentication, header rewriting, or native RPC. OCC's production API and
worker run in the Node test process; this is not a Helm-installed controller
proof. The test applies the chart's Gateway policies, rotates the listener key
and API-side key file, and verifies certificate renewal without restarting OCC.
Remove only the newly created test CA directory after the run.

The ordinary native-runtime command below leaves this additional routing case
unselected. The earlier Docker manual-proxy proof has been removed because
Docker does not implement automatic private Agent routes.

Run the ordinary runtime cases independently of Slack:

```sh
OCC_TEST_HARNESS_K3D_REAL=1 OCC_TEST_SLACK_LIVE=0 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-real.test.mjs
```

Three non-Slack runtime cases must pass: dedicated Codex, embedded OpenClaw with
a persisted service-account credential, and embedded OpenClaw using the Secret
API. The Secret API case verifies native SecretRefs, exact grants and denial,
shared Secrets, rotation, and redeployment. It prepares those Secrets and grants
itself. Routing, Slack and OTLP cases live in separate files, so this invocation
contains only its three required runtime cases.

This suite uses the real production API and worker in the Node test process.
It does not install the controller with Helm. Missing selected-suite
prerequisites fail; an unselected suite skips. Default Codex version expectation
is `0.152.1`; see [runtime settings](reference/settings.md#kubernetes-real-runtime-test-environment)
for version assertions and alternate image variables.

## Slack

Use the Kubernetes runtime prerequisites and model credential above, plus an
authorized test channel. The gateway image must already contain the Slack plugin
and its runtime dependencies. Run the [runtime image smoke](#images-and-helm)
before provisioning the cluster, and use a Codex app-server version accepted by
the gateway's installed Codex plugin. Successful `--version` commands alone do
not prove that the two runtimes are compatible.

Put the three Slack tokens in the private environment
file. Set `OCC_TEST_SLACK_CHANNEL_ID` and `OCC_TEST_SLACK_PROXY_URL`; the proxy URL
must have a literal IP and explicit port. Both bots must belong to the same
workspace and have joined the channel. Use an existing Socket Mode app configured
to receive the test messages.

```sh
OCC_TEST_SLACK_LIVE=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-slack-real.test.mjs
```

This posts real Slack messages and leaves them in the channel. It verifies the
reply and exact runtime/session evidence. The sender bot must differ from the
Agent bot; its credential remains with the test runner. Run this file and the
ordinary runtime file for both coverage groups. See [Slack test settings](reference/settings.md#slack-test-environment).

## ChatGPT service accounts

Use the same disposable cluster, migrated database, and immutable runtime
images. Supply a protected admin-key file and the exact authorized workspace ID;
the test creates a real provider account and issues its model credential. For a
direct local `node --test` run, import approved gateway and Agent images first
and export their immutable `image@sha256:<digest>` references as shown in
[Kubernetes model turns and Secrets](#kubernetes-model-turns-and-secrets).

The test configures shared-filesystem provisioning in that disposable k3d
cluster and grants its controller identities the production worker's volume
and Pod observation permissions. The worker remains unable to read Secrets.

The protected `provider-account` GitHub Actions lane builds the checked-in
runtime image and imports it into the run-owned k3d cluster when either
`OCC_TEST_KUBERNETES_GATEWAY_IMAGE` or `OCC_TEST_KUBERNETES_AGENT_IMAGE` is
unset. If both image variables are set, the lane uses those explicit references
after validating that each is immutable.

```sh
(
  unset OCC_TEST_CHATGPT_ADMIN_KEY
  export OCC_TEST_CHATGPT_ADMIN_KEY_PATH=/absolute/path/to/private/chatgpt-admin-key
  export OCC_TEST_CHATGPT_WORKSPACE_ID='<authorized-workspace-id>'
  OCC_TEST_CHATGPT_SERVICE_ACCOUNT_REAL=1 \
    node --env-file="$TEST_ENV_FILE" --test tests/integration/service-account-driver-real.test.mjs
)
```

Keep `OCC_TEST_CHATGPT_ADMIN_KEY` out of that environment file as well: a nonempty
environment key takes precedence over the file-path option. Protect the supplied
key file with mode `0600`. `OPENAI_API_KEY` is not required. Set the supported
model explicitly as above. The test attempts provider-account deletion and
scoped resource cleanup; investigate any reported cleanup failure before rerunning.

## OpenShell Sandbox

This suite needs the owned OpenShell CI recipe: a disposable K3s v1.36.4 k3d
cluster, matched kubectl, the selected RuntimeClass bound to the cluster's
`runc` handler, a successful RuntimeClass smoke Pod, Agent Sandbox
CRDs/controller, OpenShell CLI/Helm/chart files, imported immutable OpenShell
gateway and supervisor images, real gateway/Codex images, the Kubernetes test
database, `openssl`, and `OPENAI_API_KEY`. The standard k3d recipe alone is
insufficient because it does not install the CI-owned admission config,
RuntimeClass, Agent Sandbox, or OpenShell assets.

For CI-shaped setup, let `prepare.mjs` create the pinned K3s cluster, install
OpenShell prerequisites, and export the lane environment before
`run-tests.mjs` invokes the case:

```sh
node scripts/ci/prepare.mjs \
  --lane openshell \
  --state "$RUNNER_TEMP/state/openshell.json" \
  --github-env "$GITHUB_ENV"
node scripts/ci/run-tests.mjs run openshell \
  --state "$RUNNER_TEMP/state/openshell.json" \
  --results "$RUNNER_TEMP/results/openshell.json"
```

For manual setup, prepare these inputs using the
[OpenShell test settings](reference/settings.md#openshell-test-environment) and
[OpenShell requirements](reference/drivers/openshell-sandbox.md#kubernetes-and-admission-requirements),
then run the exact file:

```sh
OCC_TEST_OPENSHELL_K3D_REAL=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/sandbox-driver-openshell-k3d-real.test.mjs
```

The test proves provider-owned dedicated Codex execution, real tool filesystem
and network enforcement, duplicate reconciliation, replacement/cleanup with an
absent Pod, and rejection of embedded placement. It uses explicit integration
bridges documented in the Driver reference; it is not general production-installation
proof. Missing prerequisites after selection fail rather than skip.

## Results, cleanup, and troubleshooting

Read the test runner's pass, failure, and skip counts. Record the selected files,
commit, nonsecret image digests/model, and which optional cases were enabled.
Do not report a skipped model turn, database case, or cluster case as verified.
Keep optional live Configuration cases and mutually exclusive Slack selection
distinct from missing prerequisites.

Tests normally clean up their own temporary processes, resources, and files.
Kubernetes suites leave the selected cluster and database in place. Logging
cleanup removes its local Docker backend container and JSONL/config directory
without requiring a live Kubernetes API; the disposable k3d cluster owns
Collector Namespace and RBAC cleanup. After all needed suites finish, remove only
the disposable cluster you created:

```sh
k3d cluster delete oce
```

Retain failure evidence before removing test resources. Review and remove only
databases created for this run when no test connections remain. Do not delete
shared Compose volumes, existing databases, or unrelated clusters. Slack messages
remain; provider-account cleanup failures require explicit follow-up.

| Symptom                                                  | Check or recovery                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Green command with expected integration coverage absent  | Inspect skips and selection variables; target the exact suite with its full prerequisites.                                                                    |
| OpenShell prerequisite error during a database-only run  | Run `test:postgres` and the singleton-worker file directly; do not invoke the all-integration glob with shared infrastructure variables.                      |
| Provider authentication or unsupported custom-tool error | Check credential/model access without printing the key; explicitly select a compatible model.                                                                 |
| Kubernetes `ImagePullBackOff`                            | Import the local tag and register the exact configured digest alias inside k3s.                                                                               |
| Bootstrap database already contains an Installation      | Use a new disposable, migrated bootstrap database.                                                                                                            |
| Secret-backed deployment denied                          | The test's missing-grant case deliberately expects `403`; a failing positive case needs exact caller and Agent `operate` grants, not broader Kubernetes RBAC. |
| Missing Helm or `yq`                                     | Install the required tools before claiming packaging coverage; this test does not install them.                                                               |

## Related

- [Test environment settings](reference/settings.md#postgresql-test-environment)
- [Deployment guide](guides/deploy.md)
- [Runtime image recipe](../deploy/runtime/README.md)
- [Contributor integration boundaries](../AGENTS.md#running-integration-tests)
