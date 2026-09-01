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

| Suite                    | What it verifies                                                                                                            | Setup and commands                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Local API and lifecycle  | HTTP routes, authentication, startup, worker behavior, Driver packages, and local process boundaries.                       | [Local checks](#local-checks)                                             |
| PostgreSQL               | Real persistence, constraints, authentication, API keys, Secret metadata, queue claims, recovery, and production bootstrap. | [PostgreSQL](#postgresql)                                                 |
| Images and Helm          | Built controller modules, runtime startup, and rendered production packaging.                                               | [Images and Helm](#images-and-helm)                                       |
| Docker Compose           | Real PostgreSQL, API, worker, isolated containers, and embedded OpenClaw plus dedicated Codex model turns.                  | [Docker Compose model turns](#docker-compose-model-turns)                 |
| Kubernetes HTTP fixture  | Real Kubernetes API, RBAC, ownership, revision routing, namespace preservation, and enforced NetworkPolicies.               | [Kubernetes HTTP fixture](#kubernetes-http-fixture)                       |
| Kubernetes real runtimes | Dedicated Codex, embedded OpenClaw, shared workspace, and Secret API delivery, rotation, and authorization.                 | [Kubernetes model turns and Secrets](#kubernetes-model-turns-and-secrets) |
| Slack                    | Actual Socket Mode ingress and a gateway-authored reply through dedicated Codex.                                            | [Slack](#slack)                                                           |
| ChatGPT service accounts | Actual provider account creation, credential issuance, exact Agent delivery, and a model turn.                              | [ChatGPT service accounts](#chatgpt-service-accounts)                     |
| OpenShell Sandbox        | Provider-owned dedicated Harness execution and filesystem/network enforcement through real tools.                           | [OpenShell Sandbox](#openshell-sandbox)                                   |

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
use `gpt-5.1`. Docker defaults to `gpt-5.6-sol`, OpenShell to `gpt-5.6-sol`, and
the Kubernetes Harness and ChatGPT account suites currently default to `gpt-4.1`.
The latter default does not support the documented dedicated Codex request
shape; override it when running those suites.

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

The local [integration tests](../tests/integration/) include these groups:

- `occ-api`, `configuration-controller`, `secret-api`, and `service-api-keys`:
  actual Fastify routes with test Drivers and in-memory state.
- `controller-lifecycle`, `configuration-startup`, `secret-driver-startup`, and
  `sandbox-driver-startup`: admission, lifecycle, and startup validation.
- `production-controller-security` and `production-healthcheck`: internal
  request admission, HTTP cancellation, and readiness-marker behavior.
- `driver-plugin-installation` and `git-hooks`: local package installation,
  Driver selection, and hook installation/preservation in temporary checkouts.
- `compute-singleton-worker`: two local validation cases and six additional
  database-backed cases when `OCC_TEST_DATABASE_URL` is supplied.

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
  node --test tests/integration/compute-singleton-worker.test.mjs
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

This starts an embedded gateway with a fresh runtime home and checks readiness
and Codex plugin discovery. It does not make a model call.

Build the controller image with `docker build --target production -t
openclaw-enterprise:reviewed .`, then set `OCC_TEST_PRODUCTION_IMAGE` to the local tag you built:

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

Run the ordinary runtime cases independently of Slack:

```sh
OCC_TEST_HARNESS_K3D_REAL=1 OCC_TEST_SLACK_LIVE=0 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-real.test.mjs
```

Three cases must pass: dedicated Codex, embedded OpenClaw with a persisted
service-account credential, and embedded OpenClaw using the Secret API. The
last case verifies native SecretRefs, exact grants and denial, shared Secrets,
rotation, and redeployment. It prepares those Secrets and grants itself. The
independent Slack case is expected to skip in this run.

This suite uses the real production API and worker in the Node test process.
It does not install the controller with Helm. Missing selected-suite
prerequisites fail; an unselected suite skips. Default Codex version expectation
is `0.147.0`; see [runtime settings](reference/settings.md#kubernetes-real-runtime-test-environment)
for version assertions and alternate image variables.

## Slack

Use the Kubernetes runtime prerequisites and model credential above, plus an
authorized test channel. Put the three Slack tokens in the private environment
file. Set `OCC_TEST_SLACK_CHANNEL_ID` and `OCC_TEST_SLACK_PROXY_URL`; the proxy URL
must have a literal IP and explicit port. Both bots must belong to the same
workspace and have joined the channel. Use an existing Socket Mode app configured
to receive the test messages.

```sh
OCC_TEST_SLACK_LIVE=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-real.test.mjs
```

This posts real Slack messages and leaves them in the channel. It verifies the
reply and exact runtime/session evidence. The sender bot must differ from the
Agent bot; its credential remains with the test runner. This selection skips
the three ordinary runtime cases, so run both selections for complete Harness
coverage. See [Slack test settings](reference/settings.md#slack-test-environment).

## ChatGPT service accounts

Use the same disposable cluster, migrated database, and immutable runtime
images. Supply a protected admin-key file and the exact authorized workspace ID;
the test creates a real provider account and issues its model credential.

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

This suite needs a separately prepared disposable cluster with the selected
RuntimeClass, Agent Sandbox CRD, and ready Agent Sandbox controller. It also
needs OpenShell CLI/Helm/chart files, imported immutable OpenShell gateway and
supervisor images, real gateway/Codex images, the Kubernetes test database,
`openssl`, and `OPENAI_API_KEY`. The standard k3d recipe alone is insufficient.

Prepare these inputs using the
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
Kubernetes suites leave the selected cluster and database in place. After all
needed suites finish, remove only the disposable cluster you created:

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

## Setup command integration

`node --test tests/integration/setup-cli.test.mjs` checks CLI input and private
state boundaries. For real development setup, provide `OPENAI_API_KEY` and a
local runtime image, then run:

```sh
OCC_TEST_SETUP_DOCKER_REAL=1 \
  node --test tests/integration/setup-cli.test.mjs
```

This creates a disposable Compose project, invokes the shipped setup CLI twice,
checks exact resource/revision reuse, and verifies two assistant replies through
its TUI reconnect command. Cleanup targets only that test's resources.

`tests/integration/setup-production-k3d-real.test.mjs` invokes the same shipped
production command against an explicitly selected disposable k3d cluster. Set
`OCC_TEST_SETUP_PRODUCTION_REAL=1`, the existing Kubernetes context/kubeconfig
selection, `OPENAI_API_KEY`, and these imported immutable image references:
`OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`, `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`,
`OCC_TEST_PRODUCTION_POSTGRES_IMAGE`, and `OCC_TEST_PRODUCTION_NODE_IMAGE`.
Alternatively, `OCC_TEST_PRODUCTION_IMAGES_FILE` names JSON containing those four
keys. Helm and kubectl must be on `PATH`. The test supplies only infrastructure
prerequisites (database and TLS proxy); setup owns control-plane installation,
credentials, tenant access, and Agent provisioning. It checks a successful rerun
and two TUI assistant replies. Neither suite runs against a production cluster.
