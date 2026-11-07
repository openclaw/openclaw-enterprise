---
kind: reference/ci
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# QA Matrix Advisory

## Overview

QA Matrix Advisory is one workflow with three groups of test jobs:

- **QA matrix:** Console Secret management with Standard Codex Agents on Compose
  and Kubernetes installations.
- **OpenShell:** ten jobs with at most ten running at once for sandbox policy, credentials, plugins,
  installation, and Agent redeployment.
- **Local installation:** the hosted local setup tests.

The six-hour schedule starts all three groups in the same workflow run. They use
real dependencies on disposable installations. Results are advisory and do not
block merge or publication.

`openshell` is the test runner's name for a suite (a **lane**). Its jobs are part
of this workflow; they do not require another schedule or manual invocation.

<a id="when-it-runs"></a>

## Trigger

| Trigger                                            | Jobs selected                                               |
| -------------------------------------------------- | ----------------------------------------------------------- |
| Schedule on `main`, every 6 hours at minute 17 UTC | All three groups                                            |
| Manual run of `qa-advisory.yml` on `main`          | All three groups                                            |
| Eligible PR with `full-qa`                         | All three groups                                            |
| Eligible PR with only `qa-openshell-compose`       | Compose OpenShell first-Agent job only                      |
| Push to `main`, when `QA_ADVISORY_ON_PUSH=true`    | QA matrix and all OpenShell jobs; no local installation job |

PRs must come from this repository and must not be authored or triggered by
Dependabot. A maintainer adds the label to a reviewed PR; create it first if
absent. `full-qa` takes precedence when both labels are present. The focused
Compose job still uses Kubernetes workloads and checks native redeployment and
required-worker execution.

PR runs test the merge commit. While a qualifying label remains, a new commit
replaces the previous run. Removing the label stops future selection; cancel an
active run separately. Eligible pushes to `main` each finish independently.
The author of the change that first breaks a job owns triage.

Push execution is opt-in through `QA_ADVISORY_ON_PUSH`; the schedule does not
require that variable. Credentialed QA and OpenShell jobs use
[`integration-qa-pr`](configuration.md#environments). Dependabot cannot start a
manual advisory run.

## Scenarios

The matrix creates disposable Compose and Kubernetes control planes, both with
Kubernetes compute, and separate OpenClaw/Codex Agents for each scenario. Before the first preset, the matrix enables both Plugin Drivers and checks that OpenClaw offers Google Workspace and Codex offers Linear. The catalogs stay enabled across presets. The matrix does
not use existing clusters or change the default kubeconfig. The exact test list
is in the [QA manifest](../../../scripts/ci/test-suites/qa-matrix.json).

| Scenario                | In advisory          | Presets         | Checks                                                                                                                                                     |
| ----------------------- | -------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox-policy`        | Yes — OpenShell jobs | Codex           | Discover and preview configuration, then apply, update, and withdraw OpenShell network policy in a prepared environment.                                   |
| `plugin-install`        | Yes — OpenShell jobs | Codex           | Install a dedicated Codex plugin, find it after the Codex process restarts, then remove it from the Agent selection.                                       |
| `model-ui`              | No                   | OpenClaw        | Real model turn and native browser response.                                                                                                               |
| `console-secrets`       | Yes (Codex)          | OpenClaw, Codex | Create and manage Console Secrets referenced by Agent drafts. Refusing Namespace deletion identifies the deployed Agent and links to its cleanup controls. |
| `git-write`             | No                   | OpenClaw, Codex | Clone, edit, commit, push to the run's granted branch, dispose credentials.                                                                                |
| `git-push-denied`       | No                   | Codex           | Reject a push to any other branch and dispose credentials.                                                                                                 |
| `slack`                 | No                   | Codex           | Threaded reply and new root message.                                                                                                                       |
| `openshell-linear-read` | No                   | Codex           | Opt-in shipped OpenShell setup, Linear installation and verified native read.                                                                              |
| `codex-search-config`   | No                   | Codex           | API-key Agent user configuration with omitted, false and true capability declarations; persistence after supported stop/deploy.                            |

The [QA matrix test](../../../tests/integration/qa-matrix-real.test.mjs) implements
these selections; [scenario selection](../../../tests/helpers/qa-selection.mjs)
defines their applicability.

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
private state. These are parallel jobs within the same advisory run, named
`QA advisory (OpenShell / <test-file-basename>)`.

The selection job reads the ten files in the
[OpenShell manifest](../../../scripts/ci/test-suites/openshell.json). Each resulting
job calls `run-ci-lane` with `lane: openshell` and its selected `test-file`. The
`qa-openshell-compose` label selects only the first row below.

| Test (source)                                                                                      | Coverage                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Compose first Agent](../../../tests/integration/local-first-agent-openshell-real.test.mjs)        | Compose control plane with Kubernetes workloads: Agent deployment and reuse, key replacement denial, native redeployment, retained session/files, and required-worker execution. |
| [OpenShell installation](../../../tests/integration/dev-up-openshell-k3d-real.test.mjs)            | Pinned OpenShell installation with Kubernetes-only and Compose control planes.                                                                                                   |
| [Gateway tool policy](../../../tests/integration/openshell-gateway-tool-policy-real.test.ts)       | Gateway model tool restrictions, positive administrator controls, and policy replacement.                                                                                        |
| [Credential lifecycle](../../../tests/integration/openshell-credentials-real.test.ts)              | Credential routing, replacement, non-model sources, and absence from Agent material.                                                                                             |
| [Live credential withdrawal](../../../tests/integration/openshell-withdrawal-real.test.ts)         | Credential update, revocation without restarting the Harness, embedded refusal, and authenticated native policy scopes.                                                          |
| [Upstream outages](../../../tests/integration/openshell-upstream-real.test.ts)                     | Untrusted model TLS, tool outages, and model provider outages with recovery.                                                                                                     |
| [Gateway and OAuth recovery](../../../tests/integration/openshell-refresh-real.test.ts)            | Gateway restart, fresh OAuth minting, rotation, revocation, expiry, and source deletion.                                                                                         |
| [Sandbox enforcement](../../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)       | Provider credential delivery, authenticated Codex access, filesystem enforcement, and Agent network policy.                                                                      |
| [Kubernetes first Agent](../../../tests/integration/local-first-agent-openshell-k3d-real.test.mjs) | The first-Agent and native redeployment workflow with the control plane in Kubernetes.                                                                                           |
| [Codex plugin installation](../../../tests/integration/openshell-plugin-install-real.test.ts)      | Selected Codex plugin installation and retention through the OpenShell Agent workflow.                                                                                           |

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

This starts the QA matrix, all ten OpenShell jobs, and three local installation jobs.
For only OpenShell, use [Full Integration](full-integration.md#run-a-protected-integration-lane)
with `lane=openshell`.

The local instructions below run the **QA matrix only**. They do not run all
OpenShell files or the local installation suite. For those suites, follow
[OpenShell setup](../openshell.md#openshell-sandbox) or
[local installation tests](../kubernetes.md#local-kubernetes-installation).

### Select scenarios

`OCC_TEST_QA_INSTALLATION` accepts `all` (default), `compose`, `kubernetes`;
`OCC_TEST_QA_PRESET` accepts `all` (default), `OpenClaw`, `Codex`.
`OCC_TEST_QA_SCENARIOS` accepts `all` (default) or comma-separated selectors.
`all` excludes the explicit `sandbox-policy`, `plugin-install`,
`openshell-linear-read`, and `codex-search-config` selectors.
Invalid or wholly inapplicable selections fail before provisioning; missing
inputs fail selected checks. Omitting `OCC_TEST_QA_MATRIX=1` skips the suite.

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
together to reuse immutable builds; `OCC_TEST_QA_REPOSITORY_IMAGE` selects the
broker. Model defaults are in [shared configuration](configuration.md#environments); the [manifest](../../../scripts/ci/test-suites/qa-matrix.json)
lists overrides.

After preparing those inputs, run from the repository root:

```sh
pnpm cli:build
OCC_TEST_QA_MATRIX=1 node --env-file="$TEST_ENV_FILE" \
  --test tests/integration/qa-matrix-real.test.mjs
```

`TEST_ENV_FILE` is the private environment file described above.

## Results and limits

Check the tested commit, selected scenarios, failed or skipped tests, and cleanup.
Missing, filtered, or interrupted tests are not passes.

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
because it runs one file; complete advisory OpenShell coverage requires all ten
to pass.

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
