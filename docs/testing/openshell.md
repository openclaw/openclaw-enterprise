---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# OpenShell tests

## Overview

Use official OpenShell `v0.1.6` from the repository root. See [images and trust](openshell-oauth.md#prepare-images-and-trust)
for versions and qualification limits.

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

Retain one state directory per checkout and its environment. The launcher
prints the API URL, kubeconfig, context, and service-key file; default Kubernetes
configuration stays unchanged. Set `OCC_DEVELOPMENT_CONTAINER_ENGINE=docker` or `podman` if selection is ambiguous.

Stop, including after partial startup:

```sh
./scripts/dev-down
```

This deletes only the owned cluster and database. For Compose, set
`OCC_DEVELOPMENT_CONTROL_PLANE=compose` before startup; otherwise the control
plane follows the Compute Driver, selecting Kubernetes here.

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

Finite-removal and two-Agent failures identify the failed conversation check:
`execution identity`, `target discovery`, `gateway identity`, `model turn`, or
`persisted reply`. These labels do not diagnose the cause. Raw command
arguments, output, and error causes remain withheld.

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

The scenario's ordinary Sandbox policy admits six observed regional package
hosts on port 443 with TLS inspection, read-only REST access, and pinned native
Codex binary paths. The test verifies that the emitted PAT profile excludes
artifact hosts. The Installation lists allowed hosts, not an exhaustive CDN
inventory. Other destinations stay denied pending review. These defaults
do not extend a protected egress plan.

`codex-plugin-stdio-real.test.ts` also runs the production stdio helper against
the pinned native image with networking disabled. It checks local installation,
process replacement, and cleanup after an actual install error. That narrower
proof does not establish remote account access or OpenShell enforcement.

## Linear tool-use qualification

The opt-in `openshell-linear-read` scenario boots the shipped Kubernetes and
OpenShell stack. Through OCE APIs it creates the credential source and a dedicated
Linear Agent with the shipped Codex configuration. A normal turn through the
configured OCE Gateway route must call a native Linear tool and return known
data successfully. Kubernetes access runs the API client in the existing
controller and reads evidence without replacing Drivers, reading Gateway
passwords from Secrets, or patching workloads.

Set `OCC_TEST_QA_CODEX_TOKEN_FILE` to an existing connected account's token file
and `OCC_TEST_QA_CODEX_MODEL` to an authorized model ID. Supply the harmless read
fixture through `OCC_TEST_CODEX_LINEAR_PROMPT`, `OCC_TEST_CODEX_LINEAR_TOOL_NAME`,
and `OCC_TEST_CODEX_LINEAR_RESULT_EXPECT`. Authorize the account's Linear
connection beforehand. The test does not automate OAuth consent.

Select `OCC_TEST_QA_SCENARIOS=openshell-linear-read` in the QA matrix, or set
`OCC_TEST_OPENSHELL_LINEAR_REAL=1` and run
`tests/integration/openshell-linear-read-real.test.ts`. The default matrix `all`
excludes this scenario. The manual `openshell-linear` lane explicitly selects
the standalone file. Missing inputs fail selected cases. Installation alone
cannot prove a Linear tool call.

## Test setup and cleanup

See [host relay diagnostics](docker.md#verify-host-routing-relay-diagnostics).

Stop reusable environments first. Tests own disposable clusters.
Install the [prerequisites](README.md#requirements-and-credentials), Docker or
Podman, k3d, kubectl and Helm, then run `pnpm cli:build`.

```sh
# Kubernetes: real first-Agent reply and browser access.
# Install certutil and sandboxed Chromium per the prerequisites.
# Select an authorized OpenAI API key and model.
OPENAI_API_KEY_FILE=/secure/oce/openai-api-key OCC_TEST_OPENAI_MODEL="$MODEL" \
OCC_TEST_DEV_UP_OPENSHELL_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs

# Compose control plane
OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

Each command skips the other case. Both check setup, Workspace reconciliation,
and cleanup. Kubernetes adds browser access and a real Agent reply using an OIDC
fixture and `OPENAI_API_KEY` or `OPENAI_API_KEY_FILE`; PATs are excluded. Compose
needs no model credential or call. Docker is default; set
`OCC_TEST_DEV_UP_CONTAINER_ENGINE=podman` for Podman.

For prepared Docker Compose images, set `OCC_TEST_DEV_UP_COMPOSE_CONTROLLER_IMAGE`
to an immutable development-controller reference under
`127.0.0.1:<port>/openclaw-ci-first-images-<id>/controller`, and
`OCC_KUBERNETES_RUNTIME_IMAGE` to an immutable runtime reference. Both must be
locally inspectable, built from this checkout, and labeled with its revision.
Retain provenance; never relabel images. The extra Compose file replaces
all five services' builds, excluding build coverage but preserving assertions.
Unset both image variables for full source-build coverage.

For Kubernetes, `OCC_TEST_NATIVE_BROWSER_RECEIPT` selects a new file in an existing
directory for source, image identities, and assertions; otherwise a temporary
path is printed. Overwrites are refused. CI retains `native-browser-receipt-*`
JSON for seven days, including successes, without cookies, OAuth exchanges,
model text, or media. [Console visual review](../contributing/console-storybook.md#appearance-review)
separately requires screenshots and video.

## OpenShell Sandbox

The real Sandbox suite checks Codex Gateway access, model/tool turns, credentials,
filesystem/network restrictions, replacement and cleanup. Local fixtures alone
are insufficient; see [OpenShell coverage](openshell-coverage.md).

If the credential-route check's allowed endpoint fails, the suite captures one
bounded tail from the Harness's exact supervisor before cleanup: source type,
curl HTTP/CONNECT statuses and exit code, and counts of recognized
provider-environment changes and stale-generation denials for the selected
destination. Raw log lines and request data are excluded. `no_match` means
neither class appeared; `unavailable` means capture failed or timed out. The tail
is **uncorrelated** with the request, can contain earlier or queued events, and
does not identify the curl failure's cause. The assertion still fails; neither
curl nor diagnostic reads are retried. Passing routes collect no tail.

Prepare with the Codex credential and model. The full lane also requires the
native OpenAI key. Direct Codex file runs require the
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

General installers, including focused runs, and native OpenClaw use `OPENAI_API_KEY`.
Dedicated PAT cases require `CODEX_ACCESS_TOKEN` and retain managed permission checks.
Both must permit `OCC_TEST_OPENAI_MODEL`. Never put
either value in commands, logs, or shell history. Docker, k3d, kubectl, Helm,
`openssl`, and network access to pinned assets are required. Preparation creates
a disposable cluster, installs OpenShell and Agent Sandbox prerequisites, imports
immutable images, and prepares PostgreSQL; a standard k3d cluster is insufficient.
See the [CI lane guide](ci/full-integration.md#scenarios) for hosted runs.

Locally, export both credentials and the model through your approved credential
workflow. Preparation builds the controller unless `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`
selects an approved immutable prebuilt controller. Local builds require an
approved digest-pinned Node 24 `NODE_BASE_IMAGE`. Hosted CI uses
`CONTAINER_NODE_BASE_IMAGE`; local commands do not inherit it.

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

Missing prerequisites fail the lane. Always clean up:

```sh
node scripts/ci/cleanup.mjs --state "$OCC_OPENSHELL_TEST_ROOT/state.json"
```

For scratch, select `tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts`
with preparation `--selected-file` and execution `--file`. Both require
`OCC_TEST_OPENSHELL_HARNESS=codex`,
`OCC_TEST_OPENSHELL_MODEL_BASE_URL=https://api.openai.com/v1`,
`OPENAI_API_KEY`, and `OCC_TEST_OPENAI_MODEL`.
The case checks writes, frozen selection, and claim refusals. NVMe and node loss are separate.

The [Git retention case](repository-credentials.md#verify-openshell-git-expiry-and-restart)
checks finite-grant expiry and worker restart after installation.

Codex Sandbox and guided native OpenClaw first-Agent tests use production
Drivers. Neither qualifies a production installation. Run the separate native
Sandbox test with the k3d helper below. It uses a test-only compatibility
bridge. See [Sandbox Driver qualification limits](../reference/drivers/openshell-sandbox.md#qualification-contract).

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

Set `OPENAI_API_KEY` privately to the endpoint's authorized key. Use HTTPS port 443,
a URL ending in `/v1`, and the provider's exact namespaced model ID. Without flags,
`OCC_TEST_OPENSHELL_MODEL_BASE_URL` and `OCC_TEST_OPENAI_MODEL` select the endpoint
and model. Explicit flags override inherited and prepared settings. Native helper
bootstrap and its selected native test use `OPENAI_API_KEY`, not `CODEX_ACCESS_TOKEN`.
Full OpenShell lane preparation still requires a token for its dedicated PAT cases.
The local helper retains its destination through resource preparation and reset.
In CI, custom endpoints require focused upstream, refresh, withdrawal, or Gateway
tool-policy tests; native provider files require a guided first-Agent test.
Whole-lane CI preparation rejects either override before setup.

Both commands use the test-only bridge. `test` requires an authorized
`OPENAI_API_KEY`; `demo` prompts for one if it is not set. `demo` leaves the
proven environment running and opens the Control UI and OCE console on loopback.
It leaves the dedicated worker slot free for the first browser session.
Run `./scripts/k3d down --harness openclaw` to remove it. Codex and native OpenClaw
use separate helper-owned state; without `--harness`, `copy` selects the active
demo and `down` removes both environments.

## First-Agent proof

For manual Compose-plus-k3d proof, start the environment above with
`OCC_DEVELOPMENT_CONTROL_PLANE=compose`. Supply an authorized `CODEX_ACCESS_TOKEN`
or point `CODEX_ACCESS_TOKEN_FILE` to an absolute private file. Set only one.

```sh
node scripts/first-agent.mjs my-agent --harness codex --control-ui
```

`Model response verified:` proves a model turn; a selected version or ready
Sandbox does not. Failures include [bounded runtime evidence](../flows/secret-storage-and-delivery.md#4-grant-the-first-local-agent-access-to-its-model-credential).
Replace an invalid key with `--replace-key`. The starter disables tools.
With either OpenShell control plane, `--control-ui` prints OCE console and
OpenClaw Control UI URLs. Trust startup's browser CA first. Finish with
`./scripts/dev-down` using the same state directory.

### Guided native OpenClaw redeployment

`tests/integration/local-first-agent-real.test.mjs` provisions Compose-plus-k3d and
Kubernetes-only stacks through public Local Setup. Hosted jobs prepare
[current-source images](ci.md); local runs build by default. Only the Compose file
accepts `OCC_TEST_LOCAL_FIRST_AGENT_CONTROLLER_IMAGE` for a verified development
controller, paired with `OCC_KUBERNETES_RUNTIME_IMAGE`.
Installer tests use `OPENAI_API_KEY` and verify exact CredentialSource access.
The first run checks a nonce and custom prompt. Reuse checks a new nonce
without that prompt or helper-environment credentials, retaining the exact Agent,
revision, Namespace, and model. [CI results](ci/openshell-execution.md#interpret-timing-and-proof)
retain stage timings.

After checking Local Setup's ready default Namespace, the test runs distinct
Codex and native Agents concurrently with separate `openai` sources using
`OPENAI_API_KEY`. Native OpenClaw uses the pinned runtime,
and production Drivers without the k3d helper's compatibility bridge. Both
operations drain before shared denial checks and teardown.

For a custom service, set
`OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE` to a private JSON file containing
`baseUrl`, `api` (`openai-responses` or `openai-completions`), and native `models`
metadata. The first model selects the native Agent and can differ from Codex.
Supply that service's key as
`OPENAI_API_KEY`; this custom-provider case requires a separate
`CODEX_ACCESS_TOKEN` and `codex-pat` source for Codex.
Configure the Installation `runtime.modelProvider` with that URL and API first.
The native source authorizes that destination. Provisioning, model-and-exec,
and retained-session assertions still run;
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

- First-Agent and QA Compose fixtures avoid occupied Docker ranges without
  reserving subnets or checking host routes. On overlap, clean owned resources
  with `dev-down`, select an unused `OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR`, and retry.
- If setup times out, inspect the Pods and events in `openshell-system` and
  `agent-sandbox-system`, then clean up the owned environment before retrying.
- If the model turn fails, check that the key can access the selected model and
  that provider egress is available. Do not print Secrets, provider files, Pod
  environments, or complete process arguments.
- An inactive direct Agent Service is expected for the provider-owned endpoint;
  inspect the OpenShell-advertised route instead.
