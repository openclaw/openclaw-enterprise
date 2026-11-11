---
kind: reference/ci
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# QA Matrix Advisory

## Overview

Scheduled QA runs Console Secret management on Compose/Kubernetes, OpenShell
security and lifecycle files, local installation, and OIDC Agent chat. Jobs use
real dependencies on disposable installations. Results are advisory, not merge
or publication gates.

<a id="when-it-runs"></a>

## Trigger

| Trigger                                            | Jobs selected                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Schedule on `main`, every 6 hours at minute 17 UTC | All four groups                                                              |
| Manual run of `qa-advisory.yml` on `main`          | All four groups                                                              |
| Eligible PR with `full-qa`                         | All four groups                                                              |
| Eligible PR with only `qa-openshell-compose`       | Compose OpenShell first-Agent job only                                       |
| Eligible PR with `qa-keycloak-installation`        | Keycloak installation shard only                                             |
| Eligible PR with `qa-openclaw-model-ui`            | Kubernetes / OpenClaw / `model-ui` only                                      |
| Push to `main`, when `QA_ADVISORY_ON_PUSH=true`    | QA matrix, OIDC Agent chat and all OpenShell jobs; no local installation job |

PRs must come from this repository and must not be authored or triggered by
Dependabot. A maintainer adds the label to a reviewed PR; create it first if
absent. Narrow labels select their union. `full-qa` overrides all narrow labels
and preserves the default Codex / `console-secrets` cells; it does not select
OpenClaw `model-ui`. The focused Compose job checks native redeployment and required-worker execution on Kubernetes workloads.

PR runs test the merge commit. New commits replace opted-in runs; unrelated
labels cannot restart or cancel them. Remove labels before pushing unreviewed
code; removal stops future selection but does not cancel active runs. Eligible
main pushes finish independently. The author of a breaking change owns triage.

Keycloak needs no model credential and allows 180 minutes; OpenClaw allows 120.
Together they allow 300 runtime runner-minutes per attempt, plus selection—not
a duration or billing estimate. Both require sandboxed packaged Chrome.

OpenClaw requires `OPENAI_API_KEY` and nonblank `OCC_TEST_OPENAI_MODEL` in
`integration-qa-pr`, mapped to `OCC_TEST_QA_OPENAI_MODEL`. Missing inputs fail
before the lane. Each cell materializes only its provider credential, removed
after success or failure.

Push execution is opt-in through `QA_ADVISORY_ON_PUSH`; the schedule does not
require that variable. Credentialed QA and OpenShell jobs use
[`integration-qa-pr`](configuration.md#environments). Dependabot cannot start a
manual advisory run.

## Scenarios

The [QA matrix](../../../scripts/ci/test-suites/qa-matrix.json) creates separate
Agents on disposable control planes with Kubernetes compute, preserving existing
clusters and kubeconfig. Both Plugin catalogs stay enabled across presets; setup
checks Google Workspace for OpenClaw and Linear for Codex.

| Scenario                | In advisory          | Presets         | Checks                                                                                                                                                               |
| ----------------------- | -------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox-policy`        | Yes — OpenShell jobs | Codex           | Discover and preview configuration, then apply, update, and withdraw OpenShell network policy in a prepared environment.                                             |
| `plugin-install`        | Yes — OpenShell jobs | Codex           | Install a dedicated Codex plugin, find it after the Codex process restarts, then remove it from the Agent selection.                                                 |
| `model-ui`              | Focused label only   | OpenClaw        | Real model turn and native browser response.                                                                                                                         |
| `oidc-agent-chat`       | Yes, separate job    | OpenClaw        | Explicitly attached Default users, signed admission claims, Keycloak sign-in, owner creation and deployment, browser reply, administrative and sibling-Agent denial. |
| `console-secrets`       | Yes (Codex)          | OpenClaw, Codex | Create and manage Console Secrets referenced by Agent drafts. Refusing Namespace deletion identifies the deployed Agent and links to its cleanup controls.           |
| `git-write`             | No                   | OpenClaw, Codex | Clone, edit, commit, push to the run's granted branch, dispose credentials.                                                                                          |
| `git-push-denied`       | No                   | Codex           | Reject a push to any other branch and dispose credentials.                                                                                                           |
| `slack`                 | No                   | Codex           | Threaded reply and new root message.                                                                                                                                 |
| `openshell-linear-read` | No                   | Codex           | Opt-in shipped OpenShell setup, Linear installation and verified native read.                                                                                        |
| `codex-search-config`   | No                   | Codex           | API-key Agent user configuration with omitted, false and true capability declarations; persistence after supported stop/deploy.                                      |

[QA matrix](../../../tests/integration/qa-matrix-real.test.mjs) and
[scenario selection](../../../tests/helpers/qa-selection.mjs) own these checks.

### Scenario details

The OpenShell jobs cover `sandbox-policy` and `plugin-install` automatically.
To select these scenarios locally through the QA matrix, prepare their OpenShell
fixtures: [network policy](../openshell-coverage.md#qa-matrix-selector) or
[plugin installation](../openshell.md#codex-plugin-installation).

The OpenClaw `model-ui` case checks the example Console theme through sign-in
and Agent use. It also redeploys the Agent with a provider alias, the existing OCC
Secret, and `OCE_MODEL_API_KEY`, then requires a real model turn.

### Harness destination overrides

The explicit `harness-overrides` QA scenario runs dedicated Codex and OpenClaw
through an installed Kubernetes/OpenShell workflow. It deploys two Agents with
distinct authorized destinations and a third inheriting the default, performs real
model turns, restarts the controllers with changed and removed defaults, and
withdraws one Agent's source while the other Agents continue serving.

Select `OCC_TEST_QA_INSTALLATION=kubernetes`, `OCC_TEST_QA_PRESET=all`, and
`OCC_TEST_QA_SCENARIOS=harness-overrides`. Provide two authorized HTTPS port-443
endpoints in `OCC_TEST_QA_HARNESS_ENDPOINT_A` and `_B`, protected API-key file paths
in `OCC_TEST_QA_HARNESS_KEY_FILE_A` and `_B`, and a model authorized at both endpoints
in `OCC_TEST_QA_HARNESS_MODEL`. Use the normal source-built QA images and disposable
cluster prerequisites. Missing inputs fail before setup. This scenario is explicit
until hosted credentials for both destinations are configured; ordinary PR checks
run HTTP and PostgreSQL override coverage. The scenario does not collect independent
upstream access logs.

### OpenShell file coverage

OpenShell requires the Linux Landlock security feature, which the Blacksmith
runners used for the QA matrix do not provide. Each OpenShell file therefore runs
on its own Ubuntu 24.04 VM, with a Landlock check, Docker daemon, cluster, and
private state. Jobs are named
`QA advisory (OpenShell / <test-file-basename>)`.

Each [OpenShell manifest](../../../scripts/ci/test-suites/openshell.json) file gets a
`run-ci-lane` job with `lane: openshell` and its selected `test-file`. The
`qa-openshell-compose` label selects only the first row below.

| Test (source)                                                                                       | Coverage                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Compose first Agent](../../../tests/integration/local-first-agent-openshell-real.test.mjs)         | Compose control plane with Kubernetes workloads: Agent deployment and reuse, key replacement denial, native redeployment, retained session/files, and required-worker execution. |
| [OpenShell installation](../../../tests/integration/dev-up-openshell-k3d-real.test.mjs)             | Pinned OpenShell installation with Kubernetes-only and Compose control planes.                                                                                                   |
| [Gateway tool policy](../../../tests/integration/openshell-gateway-tool-policy-real.test.ts)        | Gateway model tool restrictions, positive administrator controls, and policy replacement.                                                                                        |
| [Namespace isolation](../../../tests/integration/namespace-driver-openshell-k3d-real.test.ts)       | Bootstrap gateways and Workspaces before Agents, then run Agents in both Namespaces.                                                                                             |
| [Credential lifecycle](../../../tests/integration/openshell-credentials-real.test.ts)               | Credential routing, replacement, non-model sources, and absence from Agent material.                                                                                             |
| [Live credential withdrawal](../../../tests/integration/openshell-withdrawal-real.test.ts)          | Credential update, revocation without restarting the Harness, embedded refusal, and authenticated native policy scopes.                                                          |
| [Upstream outages](../../../tests/integration/openshell-upstream-real.test.ts)                      | Untrusted model TLS, tool outages, and model provider outages with recovery.                                                                                                     |
| [Gateway and OAuth recovery](../../../tests/integration/openshell-refresh-real.test.ts)             | Gateway restart, fresh OAuth minting, rotation, revocation, expiry, and source deletion.                                                                                         |
| [Sandbox enforcement](../../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)        | Provider credential delivery, authenticated Codex access, filesystem enforcement, and Agent network policy.                                                                      |
| [Kubernetes first Agent](../../../tests/integration/local-first-agent-openshell-k3d-real.test.mjs)  | The first-Agent and native redeployment workflow with the control plane in Kubernetes.                                                                                           |
| [Codex plugin installation](../../../tests/integration/openshell-plugin-install-real.test.ts)       | Selected Codex plugin installation and retention through the OpenShell Agent workflow.                                                                                           |
| [Finite repository retention](../../../tests/integration/openshell-git-retention-real.test.ts)      | Natural expiry and a separate two-Agent withdrawal: B reads before worker replacement; A remains denied afterward.                                                               |
| [Single-Agent finite removal](../../../tests/integration/openshell-git-finite-removal-real.test.ts) | Before-deadline removal, ordered supervisor denial after worker replacement, same-runtime conversation, and actual retirement after model-authority withdrawal.                  |

For finite Git conversation checks, `persisted reply; read=…` means the model
returned the expected nonce. The readback category identifies the failed check.
For example, `answer_missing` means the reader found the prompt but no matching
assistant answer in its bounded transcript window. The prompt and terminal answer
must belong to the logical run returned by the Gateway. Codex can finish that run
on a new native turn after an internal retry.
The check sends each authenticated nonce prompt once.

The runner requires the selected files' credentials, expected tests, and cleanup.
Local installation also uses one runner per manifest file: input and network-policy
refusals, Kubernetes and Compose profiles, and Keycloak sign-in and recovery.
The six original installation cases remain required.
A failed job does not cancel its peers. Hosted preparation builds first-Agent
images from the current checkout using read-only caches. Local Setup then creates
and cleans up each installation without duplicate clusters. See
[OpenShell CI preparation and timing](openshell-execution.md) for image selection,
runner requirements, and interpretation of setup and model-execution timings.

[Full Integration](full-integration.md) can also run this suite with
`lane=openshell` or `lane=all`; that workflow runs the same files serially.
The separately prepared [OAuth and Linear tests](../manual-tests.md) are not
included in advisory coverage.

<a id="run-it"></a>

## Execution

To run the same coverage as the schedule, configure the
[hosted credentials](configuration.md#environments), then start the workflow:

```sh
gh workflow run qa-advisory.yml --repo openclaw/openclaw-enterprise --ref main
```

For only OpenShell, use [Full Integration](full-integration.md#run-a-protected-integration-lane)
with `lane=openshell`.

Local instructions run the **QA matrix only**. For other suites, follow
[OpenShell setup](../openshell.md#openshell-sandbox) or
[local installation tests](../kubernetes.md#local-kubernetes-installation).

### Select scenarios

`OCC_TEST_QA_INSTALLATION` accepts `all` (default), `compose`, `kubernetes`;
`OCC_TEST_QA_PRESET` accepts `all` (default), `OpenClaw`, `Codex`.
`OCC_TEST_QA_SCENARIOS` accepts `all` (default) or comma-separated selectors.
`all` excludes the explicit `sandbox-policy`, `plugin-install`,
`openshell-linear-read`, `codex-search-config`, `harness-overrides` and
`oidc-agent-chat` selectors.
Invalid or wholly inapplicable selections fail before provisioning; missing
inputs fail selected checks. Omitting `OCC_TEST_QA_MATRIX=1` skips the suite.

Select `oidc-agent-chat` alone with `kubernetes` and `OpenClaw`. It uses the
`gateway-routing` lane to prepare Keycloak, PostgreSQL, native routing and
runtime images. Follow the [native browser proof](../native-agent-browser.md)
for inputs, execution and proof limits. It does not use the ordinary matrix's
installation launcher.

Select `codex-search-config` alone. It requires `OCC_TEST_QA_CODEX_MODEL_BASE_URL`,
`OCC_TEST_QA_CODEX_MODEL`, and an API key through `OCC_TEST_QA_MODEL_API_KEY` or
`OCC_TEST_QA_OPENAI_KEY_FILE`. Environment keys are redacted and excluded from
launcher children; key files must be private regular files, not symlinks. This
scenario checks configuration persistence and native startup, not live web-search
results. Its API-key setup differs from the scheduled account-login tests.

Ordinary matrix cells check startup and authenticated console login. Only Git
scenarios start the broker. `openshell-linear-read` instead starts its own
OpenShell stack and needs a connected identity and
[Linear read fixture](../openshell.md#linear-tool-use-qualification).
`OCC_TEST_QA_CONCURRENCY=1..4` selects workers (default `2`); installations and
Slack run sequentially. Allow up to 4 GiB per gateway beyond shared services.

### Local inputs

Prepare [Kubernetes](../kubernetes.md) and [Compose](../../guides/deploy/local-compose-kubernetes.md):
workspace dependencies, Docker, k3d, kubectl, Helm, Go, OpenSSL, Chromium/Playwright,
and `certutil`. Store selected inputs in a private environment file. Credential
files must be regular files without group/other permissions. Hosted settings
are under [integration environments](configuration.md#environments).

| Scenario/preset | Inputs                                                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw model  | `OCC_TEST_QA_OPENAI_KEY_FILE`                                                                                                                                                          |
| Codex           | `OCC_TEST_QA_CODEX_TOKEN_FILE`: authorized service-account PAT                                                                                                                         |
| Git             | `OCC_TEST_QA_REPOSITORY_AUTHORIZED=1`, `OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY`, and `OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE` or absolute managed `OCC_TEST_QA_GITHUB_OBSERVER_BINARY` |
| Slack           | `OCC_TEST_QA_SLACK_APP_TOKEN_FILE`, `OCC_TEST_QA_SLACK_BOT_TOKEN_FILE`, `OCC_TEST_QA_SLACK_SENDER_TOKEN_FILE`, `OCC_TEST_QA_SLACK_CHANNEL_ID`                                          |

Slack sender and gateway bot must be distinct channel members; the sender needs
post/history/reply access. Reserve the Socket Mode app for this run.

Git's private input directory contains `registry.json`, `private-key.pem`, and
`upstream-cidrs.json`. Follow [fixture setup](../../guides/deploy/local-repository-credentials.md):
exactly one authorized repository, `${OCC_INITIAL_NAMESPACE_ID}`, approved IPv4 `/32`
endpoints, and run-branch push permissions. The run grants `git-write` with `git-only`
transport on one branch, `oce-qa-<run>`, and opens no PR. The run generates the
worker's custody key.
`OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY` instead supplies an isolated
observer App's `registry.json` and `private-key.pem`. Observer credentials stay outside Agents and clean
only verified run-owned refs.

`OCC_TEST_QA_ARTIFACTS` selects private results; otherwise the runner prints its
temporary path. Set `OCC_TEST_QA_CONTROLLER_IMAGE` and `OCC_TEST_QA_RUNTIME_IMAGE`
together to reuse [prebuilt images](#prebuild-local-qa-images); `OCC_TEST_QA_REPOSITORY_IMAGE` selects the
broker. Model defaults are in [shared configuration](configuration.md#environments); the [manifest](../../../scripts/ci/test-suites/qa-matrix.json)
lists overrides.

### Prebuild local QA images

For Kubernetes QA, prebuild a clean checkout's controller/runtime pair. The
[image selection contract](../../reference/settings/development.md) requires
immutable references and matching source-commit labels.

Before building, use a local Unix-socket Docker endpoint with the containerd image
store, Buildx, and Node.js 24+. Docker CLI and daemon must support
[`docker image save --platform`](https://docs.docker.com/reference/cli/docker/image/save/) (API 1.48+). Keep this Docker context for QA.
The commands derive a native Linux `amd64` or `arm64` platform from the daemon.

In a fresh Bash shell at the repository root, replace the builder name with an
existing builder you own. No QA credentials are needed.

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
qa_source="$(node scripts/lib/openclaw-source.mjs build-args)"
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

Failed digest resolution or inspection stops the procedure. Do not substitute tags
or invent digests. These images omit publication attestations; source labels prove
consistency, not provenance. Retain metadata through qualification.
Keep `CONTROLLER_IMAGE` and `RUNTIME_IMAGE` unchanged. In the
[image checks](../docker.md#check-published-images), skip both pulls and run the
command starting with `OCC_TEST_PRODUCTION_IMAGE=`. After all required cases pass
without skips, select the pair:

```bash
export OCC_TEST_QA_CONTROLLER_IMAGE="$CONTROLLER_IMAGE"
export OCC_TEST_QA_RUNTIME_IMAGE="$RUNTIME_IMAGE"
```

Reuse the builder's intermediate cache, including Node compilation, with consistent
platform and build arguments. Loading final images does not restore intermediate
cache. For portability, use Docker's [cache export/import options](https://docs.docker.com/build/cache/backends/);
`mode=max` includes intermediate stages. Hosted CI cache is separate. These commands
do not export cache, change networking, or select a global builder.

### Run local QA

After preparing those inputs, run from the repository root:

```sh
pnpm cli:build
OCC_TEST_QA_MATRIX=1 node --env-file="$TEST_ENV_FILE" \
  --test tests/integration/qa-matrix-real.test.mjs
```

`TEST_ENV_FILE` is the private environment file described above.

## Results and limits

Check the tested commit, selected scenarios, failed or skipped tests, and cleanup.
Missing, filtered, or interrupted tests are not passes. The selection summary
records the run, attempt and tested SHA. Focused PR runs also verify and record
the merge ref and ordered base/head parents before starting jobs. Compare the
leaf result's `sourceSha` with that merge SHA; a passing earlier head is not proof
of the current composition.

For focused Keycloak, require both manifest cases and their cleanup to pass.
For OpenClaw, inspect `matrix.json`: one `kubernetes/OpenClaw` cell with only
`model-ui`, successful real model/browser stages, and Agent/installation cleanup.
Its `partial:selected` scope is intentional; missing stages or artifacts leave
verification incomplete. Preserve the job link and attempt-specific results.

| Results                                             | Where to look                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| QA matrix stages (`passed`, `failed`, or `blocked`) | `matrix.json` in `qa-advisory-<installation>-<run-id>-<attempt>`              |
| OpenShell tests                                     | `qa-advisory-<test-file-basename>-openshell` (omit `.test.mjs` or `.test.ts`) |
| Local installation tests                            | `qa-advisory-local-installation-<test-file-basename>-dev-up-k3d`              |

Startup command failures report elapsed time, the configured limit, and the observed
exit code or signal. `timed out` means the command deadline fired; a following
`SIGPIPE` can result from timeout teardown closing the output pipes. It does not
by itself identify a spontaneous CLI crash. Command arguments and protected output
remain private; the existing redacted failure detail is unchanged. The startup
limit remains 1,100,000 ms.

When available, `startup timings` in the failure message names a JSON file in the
same artifact. It retains the last 64 recognized CLI timing records: stage,
elapsed milliseconds, and failure status, plus the number of older records omitted.
These describe completed commands, including commands that failed; they do not
identify an unfinished command. Durations can overlap, so do not sum them as wall
time. Unknown or malformed records and other stdout remain private. Commands with
protected output produce no timing artifact.

Artifacts expire after seven days. Each OpenShell job reports `scope: focused`
because it runs one file; complete advisory OpenShell coverage requires every
manifest file to pass.

In `matrix.json`, `scope: full` means both installations and presets with the
`all` scenarios; advisory QA has narrower coverage. See
[Select scenarios](#select-scenarios) for the exclusions from `all`.

[First-Agent timing results](openshell-execution.md#interpret-timing-and-proof)
include overlapping stages; do not sum them as elapsed time. A Codex timeout
alone does not permit a retry: the client must report model capacity exhaustion
before any action started.

Cleanup stops the Agents and installations created by the run. If credential disposal is uncertain, cleanup keeps the installation and reports the required recovery.
Keep its broker until sessions are `DISPOSED` without active uses or pending,
uncertain or auxiliary cleanup. Preserve other runs' resources. For Git TLS
errors, compare broker DNS with approved endpoints/NetworkPolicy,
[refresh approved inputs](../../guides/deploy/local-repository-credentials.md#prepare-the-approved-inputs),
complete disposal, then recreate only this run's installation.

## Files

- [Advisory workflow](../../../.github/workflows/qa-advisory.yml): eligibility, parallel OpenShell runners, and artifact names.
- [QA manifest](../../../scripts/ci/test-suites/qa-matrix.json) and [OpenShell manifest](../../../scripts/ci/test-suites/openshell.json): exact files and requirements.
- [QA matrix test](../../../tests/integration/qa-matrix-real.test.mjs): Agent scenarios.
- [Scenario selection](../../../tests/helpers/qa-selection.mjs): presets, selectors, and required inputs.
- [Hosted credentials](../../../scripts/ci/qa-matrix-credentials.mjs): environment preparation.
