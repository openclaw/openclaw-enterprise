---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# OpenShell tests

## Overview

Run these OpenShell setup and real Agent execution tests from the repository
root. Setup selects official OpenShell `v0.1.6`; [images and trust](openshell-oauth.md#prepare-images-and-trust)
lists exact versions and qualification limits.

## Start a reusable development environment

The [local OpenShell profile](../guides/deploy/local-kubernetes-development.md#start-the-openshell-fail-closed-profile)
starts a private k3d cluster, PostgreSQL, the OCE control plane, and the
OpenShell Gateway. It does not create an Agent or require a model credential.

```sh
go build -trimpath -o bin/occ ./cmd/occ
export OCC_DEVELOPMENT_STATE_DIRECTORY="$(mktemp -d)/state"
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
./scripts/dev-up
```

Keep the state directory and environment variables for later commands, with a
separate directory per checkout. The launcher prints its API URL, kubeconfig,
context, and service-key file without changing the default kubeconfig or context.
Set `OCC_DEVELOPMENT_CONTAINER_ENGINE=docker` or `podman` if selection is ambiguous.

To stop the environment, including after a partial startup, run:

```sh
./scripts/dev-down
```

This deletes the owned cluster and its database. It does not delete unrelated
clusters. For the Compose control-plane variant, set
`OCC_DEVELOPMENT_CONTROL_PLANE=compose` before startup.

## Finite repository removal

To qualify one Agent after repository-binding removal, set `file` to
`tests/integration/openshell-git-finite-removal-real.test.ts`. Follow the lane
prerequisites below; pass `--selected-file "$file"` to
`scripts/ci/prepare.mjs --lane openshell`, then `--file "$file"` to
`scripts/ci/run-tests.mjs run openshell`, using the same private `--state "$state"`.
Always run `node scripts/ci/cleanup.mjs --state "$state"`, even after preparation
or execution fails. The fixture owns a disposable Kubernetes control plane and
PostgreSQL, a real OpenShell deployment, and a controlled HTTPS Git issuer. It requires
authorized model credentials and immutable controller/runtime images matching
the candidate checkout; relabeling an earlier image is not sufficient.

The case first reads Git with the admitted credential and starts a real model
conversation. It removes the binding before the original ten-minute deadline.
The issuer refuses retirement of that exact credential with HTTP 503; direct
HTTP 200 witnesses bracket each subsequent Git attempt. This keeps issuer
validity separate from OpenShell's revocation of the Git provider.

If the first denied request reaches the worker, it must receive a fresh signed
`access_withdrawn` decision for the original revision. If provider detachment wins
that race, the case requires the supervisor's ordered pre-HTTP policy refusal and
records the signer as unexercised. It does not delay cleanup to force a signature.
The signed-request PostgreSQL integration remains separate evidence for that boundary.
After detachment and worker replacement, the case requires successful
`REPOSITORY_ACCESS_WITHDRAWN` maintenance, Git revocation and model readiness on
the same reduced supervisor generation, another ordered Git refusal without
origin traffic or new issuance, and a reply in the original conversation and
runtime. Finally, withdrawing required model authority must clear the active
revision and remove the original Sandbox and Agent Pods before the same deadline.
Queued retirement and fixture teardown do not satisfy this final assertion.

`openshell-git-retention-real.test.ts` tests natural expiry separately. In its
two-Agent case, B reads with its original grant after A's live denial, before
worker replacement. After replacement, A must remain denied before origin and
continue its conversation on the same runtime. This case does not qualify B's
grant after replacement. Exact-scope `retire-runtime` fails expiry immediately;
retain the selected image digests, case results and cleanup evidence.

Conversation failures in the finite-removal and two-Agent cases identify the
failed check: `execution identity`, `target discovery`, `gateway identity`,
`model turn`, or `persisted reply`. These fixed labels identify where verification
stopped, not its root cause. Raw command arguments, output, and error causes
remain withheld.

## Codex plugin installation

The `plugin-install` QA scenario deploys a dedicated Codex Agent with the selected
curated plugin, reads installed state from its final WebSocket process, restarts
that native process, and removes the selection through the Agent API. It uses the
same real OpenShell and Credential Proxy fixture as the Sandbox suite. The
selected account must have plugin access and the required app connection.
`OCC_TEST_CODEX_INSTALL_PLUGIN_ID` defaults to
`codex-plugin:linear@openai-curated-remote`; GitHub plugin login is not required.

Prepare the OpenShell lane, then prepare
`tests/integration/openshell-plugin-install-real.test.ts` with the same state file.
Run that file through the lane runner, or select `OCC_TEST_QA_SCENARIOS=plugin-install`
with `OCC_TEST_QA_SANDBOX_ENV` and `OCC_TEST_QA_CODEX_TOKEN_FILE` as described in
[QA setup](openshell-coverage.md#qa-matrix-selector). The OpenShell advisory lane
registers this case separately from model-tool qualification.

This scenario uses ordinary Sandbox policy configuration to admit six observed
regional package hosts on port 443, with TLS inspection, read-only REST access,
and the pinned native Codex binary paths. The test reads the emitted policy and
checks that artifact hosts are absent from the PAT profile. The explicit list
is in the scenario's Installation configuration; it is not an exhaustive CDN
inventory. New destinations remain denied until reviewed. These defaults do not
extend a protected egress plan.

`codex-plugin-stdio-real.test.ts` also runs the production stdio helper against
the pinned native image with networking disabled. It checks local installation,
process replacement, and cleanup after an actual install error. That narrower
proof does not establish remote account access or OpenShell enforcement.

## Linear tool-use qualification

The opt-in `openshell-linear-read` QA scenario boots the shipped Kubernetes and
OpenShell stack, creates the credential source, and provisions a dedicated
Linear Agent with the shipped Codex configuration through OCE APIs. A normal
turn through the configured OCE Gateway route must produce a native Linear tool
call and a successful result matching known data. Kubernetes access runs the API
client in the existing controller and reads evidence; it does not replace Drivers,
read Gateway passwords from Secrets, or patch workloads.

Provide an existing connected account through `OCC_TEST_QA_CODEX_TOKEN_FILE`, an
authorized model ID through `OCC_TEST_QA_CODEX_MODEL`, and the harmless read fixture:
`OCC_TEST_CODEX_LINEAR_PROMPT`, `OCC_TEST_CODEX_LINEAR_TOOL_NAME`, and
`OCC_TEST_CODEX_LINEAR_RESULT_EXPECT`. The account must already have its Linear
connection authorized; the test does not automate an OAuth consent decision.

Select `OCC_TEST_QA_SCENARIOS=openshell-linear-read` in the QA matrix, or set
`OCC_TEST_OPENSHELL_LINEAR_REAL=1` and run
`tests/integration/openshell-linear-read-real.test.ts`. The default matrix `all`
selection excludes this dedicated OpenShell scenario. The standalone file belongs
to the manual `openshell-linear` lane, which selects it explicitly. Selected cases fail when
inputs are missing. Installation-only evidence
does not establish a successful Linear tool call.

## Test setup and cleanup

Stop the reusable environment before running these tests. Each creates and
removes its own disposable cluster. Install Docker or Podman, k3d, kubectl,
Helm, and the dependencies in the [testing prerequisites](README.md#requirements-and-credentials).
Build the local CLI first with `pnpm cli:build`.

```sh
# Kubernetes control plane, including a real first-Agent deployment and browser access checks.
# Install certutil and sandboxed Chromium as in the Kubernetes testing prerequisites.
# Select an existing authorized Codex service account and its model.
CODEX_ACCESS_TOKEN_FILE=/secure/oce/codex-token OCC_TEST_OPENAI_MODEL="$MODEL" \
OCC_TEST_DEV_UP_OPENSHELL_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs

# Compose control plane
OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

Each command selects one case and skips the other. These tests verify setup,
Workspace reconciliation, and cleanup. They use a synthetic credential and
do not create an Agent or make a model call. They default to Docker; set
`OCC_TEST_DEV_UP_CONTAINER_ENGINE=podman` to use Podman.

## OpenShell Sandbox

The real Sandbox suite checks a dedicated Codex Agent's authenticated Gateway
access, model and tool turns, credential delivery, filesystem and network
restrictions, replacement, and cleanup. Local fixtures alone do not prove these
outcomes; see [OpenShell coverage](openshell-coverage.md).

If the credential-route check's allowed endpoint fails, the suite captures one
bounded tail from the Harness's exact supervisor before cleanup: source type,
curl HTTP/CONNECT statuses and exit code, and counts of recognized
provider-environment changes and stale-generation denials for the selected
destination. Raw log lines and request data are excluded. `no_match` means
neither class appeared; `unavailable` means capture failed or timed out. The tail
is **uncorrelated** with the request, can contain earlier or queued events, and
does not identify the curl failure's cause. The assertion still fails; neither
curl nor diagnostic reads are retried. Passing routes collect no tail.

Preparation requires the Codex credential and model; running the complete lane
also requires the separate native OpenAI key. For direct Codex file runs, also provide the
[policy fixture's migrator connection](openshell-coverage.md#agent-network-policy).

The suite delivers initial workspace files through real `ExecSandbox` and reads
them through the Agent API. Separate startup integration checks completion
markers, uncertain acknowledgments and edit preservation with a local native
initializer; those checks alone do not prove the OpenShell transport.

<a id="external-chatgpt-authentication-boundary"></a>

Experimental ChatGPT OAuth has separate [receiver fixtures and full-stack
qualification](openshell-oauth.md#receiver-fixtures-and-full-stack-qualification).
The [controlled-issuer proof](openshell-oauth.md) covers Gateway refresh and
official operator-mTLS access-token retrieval. Synthetic issuer results do not
prove real ChatGPT login or model execution; repeat credentialed qualification
against the exact selected images.

The CI lane requires authorized `CODEX_ACCESS_TOKEN` for Codex and
`OPENAI_API_KEY` for native OpenClaw, both permitting `OCC_TEST_OPENAI_MODEL`.
Keep them separate: a Codex PAT cannot authenticate native OpenClaw. Never put
either value in commands, logs, or shell history. Docker, k3d, kubectl, Helm,
`openssl`, and network access to pinned assets are required. Preparation creates
a disposable cluster, installs OpenShell and Agent Sandbox prerequisites, imports
immutable images, and prepares PostgreSQL; a standard k3d cluster is insufficient.
See the [CI lane guide](ci/full-integration.md#scenarios) for hosted runs.

To run the same lane locally, export both credentials and the model through your
approved credential workflow. Preparation builds the controller unless
`OCC_TEST_PRODUCTION_CONTROLLER_IMAGE` selects an approved, immutable prebuilt
controller. For a local build, choose an approved digest-pinned Node 24 build
image for `NODE_BASE_IMAGE`. Hosted CI uses its configured
`CONTAINER_NODE_BASE_IMAGE`; local commands do not inherit that variable. Then run:

```sh
if [ -n "${OCC_TEST_PRODUCTION_CONTROLLER_IMAGE:-}" ]; then
  export OCC_TEST_PRODUCTION_CONTROLLER_IMAGE
else
  : "${NODE_BASE_IMAGE:?Set an approved digest-pinned Node 24 build image}"
  export NODE_BASE_IMAGE
fi
export OCC_OPENSHELL_TEST_ROOT="$(mktemp -d)"
node scripts/ci/prepare.mjs --lane openshell \
  --state "$OCC_OPENSHELL_TEST_ROOT/state.json"
node scripts/ci/run-tests.mjs run openshell \
  --state "$OCC_OPENSHELL_TEST_ROOT/state.json" \
  --results "$OCC_OPENSHELL_TEST_ROOT/results.json"
```

The Codex account must permit `:danger-full-access`; OpenShell supplies the outer
sandbox. The live probe checks the effective profile before starting inference
and fails immediately if managed policy selects a restricted sandbox.

The lane includes both setup tests, the Sandbox test, and first-Agent tests for
both control-plane variants. It fails when selected prerequisites are missing.
Run cleanup even if preparation or a test fails:

```sh
node scripts/ci/cleanup.mjs --state "$OCC_OPENSHELL_TEST_ROOT/state.json"
```

The [Git retention case](repository-credentials.md#verify-openshell-git-expiry-and-restart)
checks finite-grant expiry and worker restart after installation.

The Codex Sandbox case and guided native OpenClaw first-Agent case use production
Drivers, but neither qualifies a production installation. The separate native
Sandbox case uses a test-only compatibility bridge. Use the k3d helper below to
run that case. The [Sandbox Driver reference](../reference/drivers/openshell-sandbox.md#qualification-contract)
describes the remaining limits.

Codex also exercises Python deny/grant/allow/revoke, loaded-version confirmation
across a worker restart, isolation from another Agent, and disabling edits while
preserving access. Suggestions and decorated logs are read through OCC.

### Native OpenClaw with k3d

The [k3d helper](kubernetes.md#develop-with-local-containers-and-k3d) prepares
the native test and builds the sibling `../openclaw` checkout. Set
`OCC_K3D_OPENCLAW_SOURCE` to use another absolute checkout path.

```sh
./scripts/k3d test --harness openclaw
./scripts/k3d demo --harness openclaw
```

For a custom OpenAI-compatible Responses endpoint, bind the model catalog and
CredentialSource to the same URL:

```sh
OCC_K3D_CONTAINER_ENGINE=podman ./scripts/k3d test --harness openclaw \
  --base-url https://models.example.com/v1 --model-id vendor/model
```

Set `OPENAI_API_KEY` privately to the endpoint's authorized key. The URL must
use HTTPS port 443 and end in `/v1`. Use the provider's exact model ID, including
its namespace. Both `test` and `demo` accept these flags. Without flags,
`OCC_TEST_OPENSHELL_MODEL_BASE_URL` and `OCC_TEST_OPENAI_MODEL` select the endpoint
and model. Explicit flags override inherited and prepared settings. Native helper
bootstrap and its selected native test use `OPENAI_API_KEY`, not `CODEX_ACCESS_TOKEN`.
Full OpenShell lane preparation and the first-Agent workflows still require their
Codex token.

Both commands use the test-only bridge. `test` requires an authorized
`OPENAI_API_KEY`; `demo` prompts for one if it is not set. `demo` leaves the
proven environment running and opens the Control UI and OCE console on loopback.
It leaves the dedicated worker slot free for the first browser session.
Run `./scripts/k3d down --harness openclaw` to remove it. Codex and native OpenClaw
use separate helper-owned state; without `--harness`, `copy` selects the active
demo and `down` removes both environments.

## First-Agent proof

For a manual Compose-plus-k3d proof, start the development environment above
with `OCC_DEVELOPMENT_CONTROL_PLANE=compose`. Supply an existing authorized
`CODEX_ACCESS_TOKEN` or set `CODEX_ACCESS_TOKEN_FILE` to an absolute private file; set
only one. Then run:

```sh
node scripts/first-agent.mjs my-agent --harness codex --control-ui
```

A successful turn prints `Model response verified:`; a selected version or ready
Sandbox is insufficient. Rerun with `--replace-key` for an invalid key. The
starter disables tools. With OpenShell and either local control plane,
`--control-ui` prints OCE console and OpenClaw Control UI URLs. Trust startup's
browser CA before opening them. Finish with `./scripts/dev-down` using the same
state directory.

### Guided native OpenClaw redeployment

`tests/integration/local-first-agent-real.test.mjs` runs in both Compose-plus-k3d
and Kubernetes-only first-Agent stacks. Each stack is created by the public Local
Setup installer, including OpenShell installation. Hosted focused jobs prepare
current-source images through the [CI image path](ci.md); local runs retain source
builds in the installer.
The initial invocation checks a fresh nonce and custom prompt. Reuse checks a
new nonce without that prompt or helper-environment credentials, retaining the
exact Agent, revision, Namespace, and model. [CI results](ci/openshell-execution.md#interpret-timing-and-proof)
retain stage timings.

After verifying the ready default Namespace created by Local Setup, the test
runs distinct Codex and native Agents concurrently. Codex uses its `codex-pat`
source; native OpenClaw uses a separate `openai` source from `OPENAI_API_KEY`.
The test drains both operations before shared denial checks and stack teardown.
The native case uses the pinned runtime and production Drivers without the k3d
helper's compatibility bridge.

To exercise an OpenAI-compatible service, set
`OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE` to a private JSON file containing
`baseUrl`, `api` (`openai-responses` or `openai-completions`), and a `models` array
with explicit native model metadata. The first model ID selects the native Agent's
model; it can differ from the Codex starter model. Supply that service's key as
`OPENAI_API_KEY`, while retaining the separate `CODEX_ACCESS_TOKEN` for Codex.
Configure the Installation `runtime.modelProvider` with that URL and API first.
The native source authorizes the same destination. The same provisioning,
model-and-exec, and retained-session redeployment assertions run with this input;
changing only the embedded QA preset does not exercise this path.

The case edits `USER.md` through the workspace API, verifies its marker through
real model execution and `exec`. That turn writes a unique session-worktree file. It
waits for the enrolled node's actual setup expiry before normal redeployment,
adding up to ten minutes. The successor must retain the owned setup Secret,
credential, expiry and device identity while recording its own enrolled revision.
Completion receipts must match while present. Empty status is allowed only after
the Gateway's 20-minute retention window. Durable Secret and execution assertions still
apply; emitted events are not counted. Checks also cover replacement Sandbox and
Pod UIDs, retained workspace PVC/subpath, and every owner file's bytes. Resuming
the same session ID and key must produce another model turn and `exec` reading
the original file and hash. Run placement must identify the replacement Harness
and required worker profile. A fresh session would miss lost worktrees despite
surviving session metadata.

Previously captured guided live proof covers native OpenClaw only and predates
the current Sandbox-owned initialization. It does not establish fresh proof
for the merged images, guided Codex, or ChatGPT OAuth.

For interactive native testing, choose OpenAI, OpenClaw and Dedicated in
[Create Agent](../reference/console/create-and-deploy.md#create-an-agent) and select
an API-key Secret; the Codex PAT used by the starter is a separate credential.

## Troubleshooting

- If a Docker subnet overlaps, run `dev-down` for the owned partial setup and
  select an unused `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` before retrying. Do not
  remove unrelated networks or clusters.
- If setup times out, inspect the Pods and events in `openshell-system` and
  `agent-sandbox-system`, then clean up the owned environment before retrying.
- If the model turn fails, check that the key can access the selected model and
  that provider egress is available. Do not print Secrets, provider files, Pod
  environments, or complete process arguments.
- An inactive direct Agent Service is expected for the provider-owned endpoint;
  inspect the OpenShell-advertised route instead.
