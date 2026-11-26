---
kind: reference/ci
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# QA Matrix Advisory

## Overview

QA checks Console Secrets, OpenShell security and lifecycle, local installation,
OIDC Agent chat and native Agent browsing with real dependencies on disposable
Compose/Kubernetes installations. Results gate neither merge nor publication.

<a id="when-it-runs"></a>

## Trigger

| Trigger                                            | Jobs selected                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Schedule on `main`, every 6 hours at minute 17 UTC | All four groups                                                                   |
| Manual on `main` with blank `test_file` or `all`   | All four groups                                                                   |
| Manual on `main` with an exact `test_file`         | Jobs that run that file                                                           |
| Eligible PR with `full-qa`                         | All four groups                                                                   |
| Eligible PR with only `qa-openshell-compose`       | Compose OpenShell first-Agent job only                                            |
| Eligible PR with `qa-keycloak-installation`        | Keycloak installation shard only                                                  |
| Eligible PR with `qa-openclaw-model-ui`            | Kubernetes / OpenClaw / `model-ui` only                                           |
| Push to `main`, when `QA_ADVISORY_ON_PUSH=true`    | QA matrix, native Agent browser and all OpenShell jobs; no local installation job |

Maintainers label reviewed same-repository PRs. Dependabot authors and triggers
are ineligible. Narrow labels combine. `full-qa` runs `console-secrets` on Codex,
`agent-audit` on Compose and `http-chat` in both presets and placements. Compose
checks native redeployment and required Kubernetes workers.

New commits replace opted-in merge-commit runs. Unrelated labels change nothing.
Remove QA labels before pushing unreviewed code. Active runs and eligible main
pushes finish independently. Authors triage regressions.
[Verify PR source before labeling](configuration.md#verify-pr-source-before-labeling).

Keycloak allows 180 minutes without model credentials; OpenClaw allows 120. Both
require sandboxed packaged Chrome. The combined limit of 300 runner-minutes per
attempt, plus selection, predicts neither elapsed time nor cost.

OpenClaw requires `OPENAI_API_KEY` and nonblank `OCC_TEST_OPENAI_MODEL` in
`integration-qa-pr`, mapped to `OCC_TEST_QA_OPENAI_MODEL`. Missing inputs fail
before the lane. Cells prepare required scenario credentials and remove them after
success or failure.

Schedules do not require `QA_ADVISORY_ON_PUSH`. Credentialed QA and OpenShell
use [`integration-qa-pr`](configuration.md#environments).

## Scenarios

The [QA matrix](../../../scripts/ci/test-suites/qa-matrix.json) preserves clusters
and kubeconfig. Setup checks OpenClaw's Google Workspace and Codex's Linear.

| Scenario                               | In advisory          | Presets         | Checks                                                                                                                                                                           |
| -------------------------------------- | -------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox-policy`                       | Yes — OpenShell jobs | Codex           | Discover and preview configuration; apply, update and withdraw OpenShell network policy in a prepared environment.                                                               |
| `plugin-install`                       | Yes — OpenShell jobs | Codex           | Install a dedicated Codex plugin, find it after the Codex process restarts, then remove it from Agent selection.                                                                 |
| `model-ui`                             | Focused label only   | OpenClaw        | Real model turn and native browser response.                                                                                                                                     |
| `scratch-volume`                       | Yes — OpenShell job  | Codex           | Admitted scratch and workspace access through real tools, frozen selection, and missing/wrong-UID claim refusal.                                                                 |
| `oidc-agent-chat`                      | Yes, separate job    | OpenClaw        | First-login Default user enrollment, returning Keycloak sign-in, signed admission claims, owner creation and deployment, browser reply, administrative and sibling-Agent denial. |
| `console-secrets`                      | Yes (Codex)          | OpenClaw, Codex | Create and manage Console Secrets referenced by Agent drafts; Namespace deletion refusal identifies the deployed Agent and links its cleanup controls.                           |
| `agent-audit`                          | Yes (Compose)        | Codex           | Exact Agent grant; links to the deployed Agent's queue, claim and result records; record for a successful Agent read.                                                            |
| `git-write`                            | No                   | Codex           | Clone, edit, commit, push to the run's granted branch, dispose credentials.                                                                                                      |
| `git-push-denied`                      | No                   | Codex           | Reject pushes to every other branch; dispose credentials.                                                                                                                        |
| `slack`                                | No                   | Codex           | Threaded reply and new root message.                                                                                                                                             |
| `channel-egress-upgrade`               | No                   | Codex           | [One-off channel upgrade](../slack.md#one-off-channel-upgrade-proof).                                                                                                            |
| `openshell-linear-read`                | No                   | Codex           | Opt-in shipped OpenShell setup, Linear installation and verified native read.                                                                                                    |
| `codex-search-config`                  | No                   | Codex           | API-key Agent user configuration with omitted, false, true capability declarations; persistence after supported stop/deploy.                                                     |
| `openshell-template-resources`         | No                   | Codex           | [Template resource delivery](../openshell-managed.md#template-resource-delivery).                                                                                                |
| `openshell-provider-replacement`       | No                   | Codex           | [Managed Provider replacement](../openshell-managed.md#provider-replacement), network changes, model turns and peer isolation.                                                   |
| `openshell-git-replacement`            | No                   | Codex           | [Managed Git recovery](../openshell-git-replacement.md), workspace retention and revision-scoped repository grants.                                                              |
| `openshell-optional-plugin-withdrawal` | Yes — OpenShell job  | OpenClaw        | Withdraw optional Slack while preserving model access, Google, independent policy and Source custody.                                                                            |
| `openshell-token-service-agent`        | No                   | OpenClaw        | Run alone on Kubernetes for a dedicated Agent turn, rotation and withdrawal. The test replaces the key and deletes the [supplied disposable Source](../manual-tests.md).         |

Source: [QA matrix](../../../tests/integration/qa-matrix-real.test.mjs),
[scenario selection](../../../tests/helpers/qa-selection.mjs).

[HTTP chat verification](../agent-http-chat.md).

### Scenario details

Prepare local OpenShell fixtures:
[network policy](../openshell-coverage.md#qa-matrix-selector),
[scratch storage](../openshell.md#openshell-sandbox),
[plugin installation](../openshell.md#codex-plugin-installation).

`model-ui` checks Console sign-in and Agent use, then redeploys with a provider
alias, existing Secret and `OCE_MODEL_API_KEY` for a real model turn.

`openshell-optional-plugin-withdrawal` runs alone with Kubernetes and OpenClaw.
Set `OCC_TEST_OPENSHELL_HARNESS=openclaw` and use the prepared OpenShell fixture
with `OCC_TEST_OPENSHELL_K3D_REAL=1`, `OPENAI_API_KEY` and
`OCC_TEST_OPENAI_MODEL`. Provide the database, Kubernetes context, images, charts
and Gateway CA paths required by [scenario selection](../../../tests/helpers/qa-selection.mjs).
The advisory also selects its native test file independently.

### Harness destination overrides

`harness-overrides` runs dedicated Codex and OpenClaw on Kubernetes/OpenShell. It
deploys two Agents with distinct authorized model endpoints and a third that inherits
the default, runs real model turns, restarts controllers with changed and removed
defaults, then withdraws one Agent's source while peers serve.

Set `OCC_TEST_QA_INSTALLATION=kubernetes`, `OCC_TEST_QA_PRESET=all` and
`OCC_TEST_QA_SCENARIOS=harness-overrides`. Supply two authorized HTTPS port-443
endpoints (`OCC_TEST_QA_HARNESS_ENDPOINT_A` and `_B`), protected API-key paths
(`OCC_TEST_QA_HARNESS_KEY_FILE_A` and `_B`) and a model authorized at both
(`OCC_TEST_QA_HARNESS_MODEL`). Use normal source-built QA images and disposable
cluster prerequisites. Missing inputs fail before setup. Select explicitly until
both destinations have hosted credentials. PR checks cover HTTP and PostgreSQL
overrides; no independent upstream access logs are collected.

### OpenShell file coverage

OpenShell requires Landlock, unavailable on QA's Blacksmith runners. Each file runs
as `QA advisory (OpenShell / <test-file-basename>)` on an Ubuntu 24.04 VM with a
Landlock check, Docker daemon, cluster and private state.

`run-ci-lane` selects each [OpenShell](../../../scripts/ci/test-suites/openshell.json)
`test-file` separately (`lane: openshell`). `qa-openshell-compose` selects only the first row.

| Test (source)                                                                                              | Coverage                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Compose first Agent](../../../tests/integration/local-first-agent-openshell-real.test.mjs)                | Compose control plane with Kubernetes workloads: Agent deployment and reuse, key replacement denial, native redeployment, retained session/files, and required-worker execution. |
| [OpenShell installation](../../../tests/integration/dev-up-openshell-k3d-real.test.mjs)                    | Pinned OpenShell installation with Kubernetes-only and Compose control planes.                                                                                                   |
| [Gateway tool policy](../../../tests/integration/openshell-gateway-tool-policy-real.test.ts)               | Gateway model tool restrictions, positive administrator controls, policy replacement.                                                                                            |
| [Namespace isolation](../../../tests/integration/namespace-driver-openshell-k3d-real.test.ts)              | Bootstrap gateways and Workspaces before Agents; run Agents in both Namespaces.                                                                                                  |
| [Credential lifecycle](../../../tests/integration/openshell-credentials-real.test.ts)                      | Credential routing, replacement, non-model sources, absence from Agent material.                                                                                                 |
| [Live credential withdrawal](../../../tests/integration/openshell-withdrawal-real.test.ts)                 | Credential update, revocation without Harness restart, embedded refusal, authenticated native policy scopes.                                                                     |
| [Optional Plugin withdrawal](../../../tests/integration/openshell-optional-plugin-withdrawal-real.test.ts) | Optional Slack withdrawal preserves model access, Google, independent policy and Source custody.                                                                                 |
| [Upstream outages](../../../tests/integration/openshell-upstream-real.test.ts)                             | Untrusted model TLS, tool outages, and model provider outages with recovery.                                                                                                     |
| [Gateway and OAuth recovery](../../../tests/integration/openshell-refresh-real.test.ts)                    | Gateway restart, fresh OAuth minting, rotation, revocation, expiry, source deletion.                                                                                             |
| [Sandbox enforcement](../../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)               | Provider credential delivery, authenticated Codex access, filesystem enforcement, Agent network policy.                                                                          |
| [Scratch storage](../../../tests/integration/sandbox-driver-openshell-scratch-k3d-real.test.ts)            | Real scratch and workspace writes, immutable binding, missing/wrong-UID claim refusal.                                                                                           |
| [Kubernetes first Agent](../../../tests/integration/local-first-agent-openshell-k3d-real.test.mjs)         | First-Agent and native redeployment workflow with the Kubernetes control plane.                                                                                                  |
| [Codex plugin installation](../../../tests/integration/openshell-plugin-install-real.test.ts)              | Selected Codex plugin installation and retention through the OpenShell Agent workflow.                                                                                           |

Finite Git conversation checks are outside the advisory manifest. The check sends
each authenticated nonce prompt once. In `persisted reply; read=…`,
the model returned the expected nonce. The readback category identifies the failed
check. `answer_missing` means the prompt but no matching assistant answer appears in
the reader's bounded transcript window. Prompt and terminal answer must share the
Gateway's logical run; Codex can finish on a new native turn after an internal retry.

Credentials, expected tests and cleanup are required. Local installation
uses one runner per manifest file and requires six original cases: input and
network-policy refusals, Kubernetes and Compose profiles, and Keycloak sign-in and
recovery. Peer jobs continue after failure. Hosted preparation builds first-Agent
images from checkout with read-only caches. Local Setup creates and cleans each
installation without duplicate clusters.
[OpenShell CI preparation and timing](openshell-execution.md) covers images, runner
requirements, setup and model-execution timings.

[Full Integration](full-integration.md) runs these files serially with
`lane=openshell` or `lane=all`. Use the effective lane result and cleanup outcome.
Advisory excludes separately prepared
[OAuth and Linear tests](../manual-tests.md).

<a id="run-it"></a>

## Execution

Configure [hosted credentials](configuration.md#environments). Set `test_file` to
one exact catalog path. Omit it or use `all` for the full advisory. Invalid or
ambiguous paths stop selection.

```sh
gh workflow run qa-advisory.yml --repo openclaw/openclaw-enterprise --ref main \
  -f test_file=tests/integration/harness-topology-k3d-routing-real.test.mjs
```

For OpenShell only, use [Full Integration](full-integration.md#run-a-protected-integration-lane)
with `lane=openshell`.

For suites outside the **QA matrix**, use
[OpenShell setup](../openshell.md#openshell-sandbox) or
[local installation tests](../kubernetes.md#local-kubernetes-installation).

### Select scenarios

`OCC_TEST_QA_INSTALLATION` accepts `all` (default), `compose`, `kubernetes`;
`OCC_TEST_QA_PRESET` accepts `all` (default), `OpenClaw`, `Codex`.
`OCC_TEST_QA_SCENARIOS` accepts `all` (default) or comma-separated selectors.
`all` selects `http-chat`, `model-ui`, `console-secrets`, `agent-audit`,
`git-write`, `git-push-denied` and `slack`. Each cell runs only the scenarios its
Preset and installation support. Other scenarios, including `namespace-lifecycle`, require
explicit selection.
Invalid selections fail before provisioning; missing inputs fail selected checks.
Without `OCC_TEST_QA_MATRIX=1`, the suite skips.

`native-restart`: [recovery qualification](../harness-restart-recovery.md).

Select `agent-audit` with `compose` and `Codex`. It uses the standard Codex
deployment fixture and development audit settings; startup requires the Codex
credential file.

Select `oidc-agent-chat` alone with `kubernetes` and `OpenClaw`. Its
`gateway-routing` lane prepares Keycloak, PostgreSQL, native routing and runtime
images without the ordinary matrix launcher. See [native browser proof](../native-agent-browser.md)
for inputs, execution and limits.

Select `scratch-volume` with `kubernetes` and `Codex`. Its
[fixture](../openshell.md#openshell-sandbox) uses an OpenAI API key for
`https://api.openai.com/v1`. NVMe and node-loss recovery need separate proof.

Select `codex-search-config` alone with `OCC_TEST_QA_CODEX_MODEL_BASE_URL`,
`OCC_TEST_QA_CODEX_MODEL` and an API key through `OCC_TEST_QA_MODEL_API_KEY` or
`OCC_TEST_QA_OPENAI_KEY_FILE`. Environment keys are redacted and excluded from
launcher children. Key files must be private regular files, not symlinks. It checks
configuration persistence and native startup, not live web-search results.
Its API-key setup differs from the scheduled account-login tests.

Ordinary cells check startup and authenticated console login. Only Git
scenarios start the broker. `openshell-linear-read` starts its own OpenShell stack
and requires a connected identity and
[Linear read fixture](../openshell.md#linear-tool-use-qualification).
`OCC_TEST_QA_CONCURRENCY=1..4` selects workers (default `2`). Installations and
Slack run sequentially. Allow up to 4 GiB per gateway beyond shared services.

### Local inputs

Prepare [Kubernetes](../kubernetes.md) and
[Compose](../../guides/deploy/local-compose-kubernetes.md):
workspace dependencies, Docker, k3d, kubectl, Helm, Go, OpenSSL, Chromium/Playwright
and `certutil`. Use a private environment file and regular credential files without
group/other permissions. See hosted
[integration environments](configuration.md#environments).

| Scenario/preset | Inputs                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw model  | `OCC_TEST_QA_OPENAI_KEY_FILE`                                                                                                                                                           |
| Codex login     | `OCC_TEST_QA_CODEX_TOKEN_FILE`: authorized service-account PAT                                                                                                                          |
| Scratch storage | `OCC_TEST_QA_OPENAI_KEY_FILE`, `OCC_TEST_QA_OPENAI_MODEL`, and `OCC_TEST_QA_SANDBOX_ENV`: protected prepared OpenShell environment file, including its migrator connection.             |
| Git             | `OCC_TEST_QA_REPOSITORY_AUTHORIZED=1`, `OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY`; `OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE`, absolute managed `OCC_TEST_QA_GITHUB_OBSERVER_BINARY` or App |
| Slack           | `OCC_TEST_QA_SLACK_APP_TOKEN_FILE`, `OCC_TEST_QA_SLACK_BOT_TOKEN_FILE`, `OCC_TEST_QA_SLACK_SENDER_TOKEN_FILE`, `OCC_TEST_QA_SLACK_CHANNEL_ID`                                           |

Codex `http-chat` uses `OCC_TEST_QA_OPENAI_KEY_FILE`.

Use distinct Slack sender and gateway bot channel members. Grant the sender
post/history/reply access and reserve the Socket Mode app for this run.

Git requires a private directory with `registry.json`, `private-key.pem` and
`upstream-cidrs.json`;
[fixture setup](../../guides/deploy/local-repository-credentials.md)
requires exactly one authorized repository, `${OCC_INITIAL_NAMESPACE_ID}`, approved
IPv4 `/32` endpoints and run-branch push permissions. The run generates the worker's
custody key, grants `git-write` over `git-only` only on `oce-qa-<run>` and opens no PR.
For observer authentication, `OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY`
supplies the observer App’s `registry.json` and `private-key.pem`; isolated mode requires
it. Observer credentials stay outside Agents and clean only verified
run-owned refs.

`OCC_TEST_QA_ARTIFACTS` selects private results; otherwise the runner prints its
temporary path. Reuse [prebuilt images](#prebuild-local-qa-images) by setting both
`OCC_TEST_QA_CONTROLLER_IMAGE` and `OCC_TEST_QA_RUNTIME_IMAGE`.
`OCC_TEST_QA_REPOSITORY_IMAGE` selects the broker;
[shared configuration](configuration.md#environments) defines model defaults; the
[manifest](../../../scripts/ci/test-suites/qa-matrix.json) lists overrides.

### Prebuild local QA images

Build Kubernetes QA images from a clean checkout with immutable references and
matching [source labels](../../reference/settings/development.md). Build and QA must
use the same local Unix-socket Docker context and containerd image store. Require
Buildx, Node.js 24+, CLI/daemon support for
[`docker image save --platform`](https://docs.docker.com/reference/cli/docker/image/save/) (API 1.48+),
and the daemon's Linux `amd64` or `arm64` platform.

At the repository root, use a fresh Bash shell and your existing builder. Replace
the example builder name with the name of an existing builder you own. QA
credentials are unnecessary.

```bash
set -euo pipefail
umask 077
qa_builder="your-existing-builder"
qa_platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
[[ "$qa_platform" == linux/amd64 || "$qa_platform" == linux/arm64 ]]
unset OCC_TEST_QA_CONTROLLER_IMAGE OCC_TEST_QA_RUNTIME_IMAGE
qa_commit="$(git rev-parse HEAD)"
qa_status="$(git status --porcelain --untracked-files=all)"
[[ -z "$qa_status" ]]
qa_metadata="$(mktemp -d)"
qa_prefix="localhost/oce-qa-$(date +%s)-$$"
qa_node_base="$(node -p 'require("./scripts/ci/test-suites/images-packaging.json").prepare.defaultEnv.NODE_BASE_IMAGE')"
qa_source="$(node scripts/lib/openclaw-source.ts build-args)"
qa_runtime_args=()
while IFS= read -r argument; do
  qa_runtime_args+=(--build-arg "$argument")
done <<< "$qa_source"
docker buildx inspect "$qa_builder"

for role in controller runtime; do
  qa_recipe=(--target runtime)
  if [[ "$role" == runtime ]]; then
    qa_recipe=(-f deploy/runtime/Dockerfile "${qa_runtime_args[@]}")
  fi
  docker buildx build --builder "$qa_builder" --platform "$qa_platform" \
    --load --provenance=false --sbom=false "${qa_recipe[@]}" \
    --build-arg NODE_BASE_IMAGE="$qa_node_base" \
    --build-arg OCC_BUILD_REVISION="$qa_commit" \
    --label "org.opencontainers.image.revision=$qa_commit" \
    --metadata-file "$qa_metadata/$role.json" \
    --tag "$qa_prefix/$role:source" .
  qa_digest="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1]))["containerimage.digest"]' "$qa_metadata/$role.json")"
  [[ "$qa_digest" =~ ^sha256:[a-f0-9]{64}$ ]]
  qa_ref="$qa_prefix/$role@$qa_digest"
  [[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$qa_ref")" == "$qa_platform" ]]
  [[ "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$qa_ref")" == "$qa_commit" ]]
  if [[ "$role" == controller ]]; then
    CONTROLLER_IMAGE="$qa_ref"
  else
    RUNTIME_IMAGE="$qa_ref"
  fi
done
qa_status="$(git status --porcelain --untracked-files=all)"
qa_final_commit="$(git rev-parse HEAD)"
[[ "$qa_final_commit" == "$qa_commit" && -z "$qa_status" ]]
printf 'Build metadata: %s\n' "$qa_metadata"
```

Stop if digest resolution or inspection fails. Never substitute tags or invent
digests. Images lack publication attestations; source labels prove consistency,
not provenance. Retain metadata through qualification and keep `CONTROLLER_IMAGE`
and `RUNTIME_IMAGE` unchanged. In the [image checks](../docker.md#check-published-images),
skip both pulls and run the command starting with `OCC_TEST_PRODUCTION_IMAGE=`.
Select after all required cases pass without skips.

```bash
export OCC_TEST_QA_CONTROLLER_IMAGE="$CONTROLLER_IMAGE"
export OCC_TEST_QA_RUNTIME_IMAGE="$RUNTIME_IMAGE"
```

Reuse intermediate cache with consistent platform and build arguments; loading
final images cannot restore it. Docker's
[cache export/import options](https://docs.docker.com/build/cache/backends/)
provide portability. `mode=max` includes intermediate stages. Hosted CI cache is
separate. These commands do not export cache, change networking or select a global
builder.

### Run local QA

Set `TEST_ENV_FILE` to the private file’s path. At the repository root, run:

```sh
pnpm cli:build
OCC_TEST_QA_MATRIX=1 node --env-file="$TEST_ENV_FILE" \
  --test tests/integration/qa-matrix-real.test.mjs
```

## Results and limits

Selected tests and cleanup must pass for the tested commit. Selection records run,
attempt and SHA. For focused PRs, match `sourceSha` to the merge SHA; its parents
must match the recorded base then head.

Focused Keycloak requires both manifest cases and cleanup to pass. Focused OpenClaw
requires one `kubernetes/OpenClaw` `matrix.json` cell with only `model-ui`, passing
real model/browser stages and Agent/installation cleanup. `partial:selected` is
intentional. Missing stages or artifacts leave verification incomplete. Preserve the job
link and attempt-specific results.

| Results                                             | Where to look                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| QA matrix stages (`passed`, `failed`, or `blocked`) | `matrix.json` in `qa-advisory-<installation>-<preset>-<run-id>-<attempt>`                                                                   |
| OpenShell tests                                     | `qa-advisory-<test-file-basename>-openshell` (omit `.test.mjs` or `.test.ts`)                                                               |
| Native Agent browser                                | `qa-advisory-oidc-agent-chat-gateway-routing`; [browser media and review procedure](../native-agent-browser.md#collect-ci-browser-evidence) |
| Local installation tests                            | `qa-advisory-local-installation-<test-file-basename>-dev-up-k3d`                                                                            |

Startup failures report elapsed time, the 1,100,000 ms limit and observed exit
code or signal. `timed out` means deadline expiry; teardown can close output pipes
and cause a later `SIGPIPE`. Failure detail is redacted; command arguments and
protected output stay private.

`startup timings` names a JSON file with up to 64 recognized CLI timings and the
omitted older-record count. Each timing gives the finished command’s stage, elapsed
milliseconds and failure status. Durations can overlap. Protected output,
unrecognized records and other stdout stay private.

Artifacts expire after seven days. OpenShell jobs report per-file `scope: focused`;
complete OpenShell coverage requires every manifest file to pass.

In `matrix.json`, `scope: full` requires both installations and presets, the default
scenario set and no permission-profile exclusions. Advisory QA is narrower;
[Select scenarios](#select-scenarios) lists the default scenarios.

[First-Agent timing results](openshell-execution.md#interpret-timing-and-proof)
can overlap; do not sum them as elapsed time. A Codex timeout permits no retry
unless the client reports model capacity exhaustion before any action started.

Cleanup stops run-created Agents and installations. If credential disposal is
uncertain, cleanup retains the installation and reports required recovery. Keep
its broker until sessions are `DISPOSED` with no active uses or pending, uncertain
or auxiliary cleanup. Preserve other runs' resources. For Git TLS errors, compare
broker DNS with approved endpoints/NetworkPolicy,
[refresh approved inputs](../../guides/deploy/local-repository-credentials.md#prepare-the-approved-inputs),
complete disposal, then recreate only this run's installation.

## Files

- [Advisory workflow](../../../.github/workflows/qa-advisory.yml): eligibility, parallel OpenShell runners, artifact names.
- [QA manifest](../../../scripts/ci/test-suites/qa-matrix.json) and [OpenShell manifest](../../../scripts/ci/test-suites/openshell.json): files and requirements.
- [QA matrix test](../../../tests/integration/qa-matrix-real.test.mjs): Agent scenarios.
- [Scenario selection](../../../tests/helpers/qa-selection.mjs): presets, selectors, required inputs.
- [Hosted credentials](../../../scripts/ci/qa-matrix-credentials.mjs): preparation.
