---
kind: reference/ci
tags: [human_verified]
---

# QA Matrix Advisory

## Overview

Use QA Matrix Advisory to test Agent workflows with real provider credentials
on disposable Compose and Kubernetes installations. It also runs the OpenShell
lane and, for selected triggers, the hosted local installation tests. Its
results are advisory; they do not block merge or publication.

<a id="when-it-runs"></a>

## Trigger

When `QA_ADVISORY_ON_PUSH=true`, each push to `main` runs the marked Codex scenarios
on Compose and Kubernetes, and the complete OpenShell lane. Each push has its own concurrency group so a later
merge cannot cancel the result. The author of the change that first breaks a lane owns triage;
use the failed run's commit and retained results.
Push runs are paused until the `integration-qa-pr` credentials work again. To start them again,
set the repository variable `QA_ADVISORY_ON_PUSH` to `true`.

For changes to OpenShell, image pins, Helm installation or another live integration, a maintainer
can add the `full-qa` label to a reviewed, same-repository pull request. Create that repository
label once before enabling this workflow. Adding it starts the Compose and Kubernetes QA jobs, all OpenShell file jobs,
and the hosted local installation tests on GitHub's PR merge commit. A manual dispatch on `main` and the
schedule (every 6 hours, at minute 17) also run both QA installation jobs, all OpenShell file jobs, and the local installation tests. Check
the run's commit and results before merging; skipped jobs provide no live QA result.
As long as the label remains, pushing a new commit replaces the previous run. Removing
it stops selection on future pushes; cancel an active run separately. Forks and Dependabot PRs are
ineligible. This is trusted code with real credentials, under the [existing environment policy](configuration.md#environments).

For the Compose OpenShell first-Agent workflow alone, add `qa-openshell-compose`
to a reviewed, same-repository PR. Create that label once if it is absent. The job
uses `integration-qa-pr` and runs only
`tests/integration/local-first-agent-openshell-real.test.mjs`, including its native
worker and redeployment cases. Its control plane runs in Compose; its workloads
still use Kubernetes Compute. `full-qa` takes precedence when both labels exist.
The focused run skips the other advisory jobs, keeps manifest case requirements
and cleanup, and records `scope: focused`. It does not count as a complete OpenShell lane run.
Inspect `qa-advisory-local-first-agent-openshell-real-openshell` and its attempt-specific artifacts.

## Scenarios

The matrix creates disposable Compose and Kubernetes control planes, both with
Kubernetes compute, and separate OpenClaw/Codex Agents for each scenario. It does
not use existing clusters or change the default kubeconfig. The exact test list
is in the [QA manifest](../../../scripts/ci/test-suites/qa-matrix.json).

| Scenario                | In advisory             | Presets         | Checks                                                                                                                                                     |
| ----------------------- | ----------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox-policy`        | Separate OpenShell lane | Codex           | Discover and preview configuration, then apply, update, and withdraw OpenShell network policy in a prepared environment.                                   |
| `plugin-install`        | Separate OpenShell lane | Codex           | Install a dedicated Codex plugin, find it after the Codex process restarts, then remove it from the Agent selection.                                       |
| `model-ui`              | Yes (Codex)             | OpenClaw, Codex | Real model turn and native browser response.                                                                                                               |
| `console-secrets`       | Yes (Codex)             | OpenClaw, Codex | Create and manage Console Secrets referenced by Agent drafts. Refusing Namespace deletion identifies the deployed Agent and links to its cleanup controls. |
| `git-write`             | No                      | OpenClaw, Codex | Clone, edit, commit, push to the run's granted branch, dispose credentials.                                                                                |
| `git-push-denied`       | No                      | Codex           | Reject a push to any other branch and dispose credentials.                                                                                                 |
| `calendar`              | Yes (Codex)             | Codex           | Successful Calendar read, approvals and tool restrictions.                                                                                                 |
| `slack`                 | No                      | Codex           | Threaded reply and new root message.                                                                                                                       |
| `openshell-linear-read` | No                      | Codex           | Opt-in shipped OpenShell setup, Linear installation and verified native read.                                                                              |
| `codex-search-config`   | No                      | Codex           | API-key Agent user configuration with omitted, false and true capability declarations; persistence after supported stop/deploy.                            |

The [QA matrix test](../../../tests/integration/qa-matrix-real.test.mjs) implements
these selections; [scenario selection](../../../tests/helpers/qa-selection.mjs)
defines their applicability.

### Scenario details

The explicit `sandbox-policy` selector exercises shared configuration discovery,
preview, and the real OpenShell network-policy lifecycle. It requires a prepared
OpenShell file environment; see [policy proof setup](../openshell-coverage.md#qa-matrix-selector).
The OpenShell advisory job covers the same workflow automatically. The separate
`plugin-install` selector installs a dedicated Codex plugin, checks that it is
available after the Codex process restarts, and removes it from the Agent selection; see
[plugin installation proof](../openshell.md#codex-plugin-installation).

The `model-ui` scenario mounts the example console theme on Compose or Kubernetes
and checks its branding through sign-in and the Agent workflow. For Dedicated Agents
on Kubernetes, it provisions with `nativeAdmin: true`, checks Configuration
generation 1 and one revision, then exercises native browser chat. Its OpenClaw
cell also redeploys the same Agent with an explicitly configured provider alias,
the existing OCC Secret, and `OCE_MODEL_API_KEY`, then requires a real model turn.
This stage runs wherever the OpenClaw `model-ui` cell is selected; the Codex-only
advisory selection does not cover it. Other scenarios do not require the theme or
an extra API rollout.

### OpenShell file coverage

The advisory workflow and Full Integration select files from the same
[OpenShell manifest](../../../scripts/ci/test-suites/openshell.json). The Compose-only
label selects the first row. The separately prepared OAuth and Linear lanes
[listed in the lane guide](run-lanes.md#manually-selected-lanes-without-github-workflows) are not included.

| Integration test file                                                                                                     | Coverage                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [local-first-agent-openshell-real.test.mjs](../../../tests/integration/local-first-agent-openshell-real.test.mjs)         | Compose control plane with Kubernetes workloads: Agent deployment and reuse, key replacement denial, native redeployment, retained session/files, and required-worker execution. |
| [dev-up-openshell-k3d-real.test.mjs](../../../tests/integration/dev-up-openshell-k3d-real.test.mjs)                       | Pinned OpenShell installation with Kubernetes-only and Compose control planes.                                                                                                   |
| [sandbox-driver-openshell-k3d-real.test.mjs](../../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)       | Provider credential delivery, authenticated Codex access, and Gateway tool policy during normal Agent work.                                                                      |
| [local-first-agent-openshell-k3d-real.test.mjs](../../../tests/integration/local-first-agent-openshell-k3d-real.test.mjs) | The first-Agent and native redeployment workflow with the control plane in Kubernetes.                                                                                           |
| [openshell-plugin-install-real.test.ts](../../../tests/integration/openshell-plugin-install-real.test.ts)                 | Selected Codex plugin installation and retention through the OpenShell Agent workflow.                                                                                           |

Full advisory OpenShell runs use one Ubuntu 24.04 runner per file from the
[OpenShell manifest](../../../scripts/ci/test-suites/openshell.json). The files run in
parallel across separate VMs. The two first-Agent files provision and clean up
through Local Setup. Their focused lane preparation records selection and state
without building images or creating a second cluster, database, routing setup,
OpenShell installation, or Keycloak instance. Other files retain their lane
preparation. The runner enforces both lane-wide and per-file `requiredEnv`
inputs, expected cases, and cleanup. A failed shard does not cancel the
others. Each result has `scope: focused`; require every shard to pass before
claiming full advisory OpenShell coverage. The manual Full Integration lane
continues to run the full manifest serially and prepares the shared resources
needed by its other files. First-Agent files do not request a separate CI database
in either mode.

First-Agent stage measurements appear in `files[].measurements`: Local Setup,
initial deployment and model calls, reuse after changing only the request nonce, native deployment, native
model execution, native redeployment, resumed model execution, and cleanup.
Each record contains only a fixed stage, outcome, and elapsed milliseconds.
The parent test duration includes its native subtest; do not add them together.

Configure the [advisory environment](configuration.md#environments) before selecting these jobs.
See [CI resource preparation](../../flows/github-actions-testing/preparation.md)
for the OpenShell browser setting and sandbox checks.

Codex timeout diagnostics from `tests/helpers/openshell-kubernetes-real.mjs` report the client phase, pending method names, message and command counts, and whether an action started. They exclude prompts, request identifiers, and payloads. A timeout does not permit a retry. The client must first report that the model was at capacity and that the turn had not started any action.

<a id="run-it"></a>

## Execution

### Select scenarios

`OCC_TEST_QA_INSTALLATION` accepts `all` (default), `compose`, `kubernetes`;
`OCC_TEST_QA_PRESET` accepts `all` (default), `OpenClaw`, `Codex`.
`OCC_TEST_QA_SCENARIOS` accepts `all` (default) or comma-separated selectors.
`all` excludes the explicit `sandbox-policy`, `plugin-install`,
`openshell-linear-read`, and `codex-search-config` selectors.
Invalid or wholly inapplicable selections fail before provisioning; missing
inputs fail selected checks. Omitting `OCC_TEST_QA_MATRIX=1` skips the suite.

`codex-search-config` requires an exclusive explicit scenario selection. It changes
only its disposable Installation, uses dedicated Codex API-key authentication,
and needs `OCC_TEST_QA_CODEX_MODEL_BASE_URL`. Supply the model key through
`OCC_TEST_QA_MODEL_API_KEY` in the consuming test process, or the existing private
`OCC_TEST_QA_OPENAI_KEY_FILE` input. Environment injection is registered for error
redaction and excluded from launcher children. Existing file inputs still require
private regular files and reject symlinks. Set `OCC_TEST_QA_CODEX_MODEL` to an
available model. The scenario proves generated configuration and native startup;
it does not prove live web-search results. It is excluded from `all` and advisory
jobs because its explicit endpoint and API-key inputs differ from account-login QA.

All combinations check startup and authenticated console login. Git alone starts
the broker. Linear reads use the explicit `openshell-linear-read` scenario,
which boots a separate shipped OpenShell stack and requires a connected Codex
identity plus the read fixture described in [OpenShell testing](../openshell.md#linear-tool-use-qualification).
`OCC_TEST_QA_CONCURRENCY=1..4` selects workers
(default `2`); installations and Slack run sequentially. Each gateway can use
4 GiB beyond shared services.

### Local inputs

Prepare [Kubernetes](../kubernetes.md) and [Compose](../../guides/deploy/local-compose-kubernetes.md):
workspace dependencies, Docker, k3d, kubectl, Helm, Go, OpenSSL, Chromium/Playwright,
and `certutil`. Store selected inputs in a private environment file. Credential
files must be regular files without group/other permissions. Hosted settings
are under [integration environments](configuration.md#environments).

| Scenario/preset           | Inputs                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw model            | `OCC_TEST_QA_OPENAI_KEY_FILE`                                                                                                                                                          |
| Codex, including Calendar | `OCC_TEST_QA_CODEX_TOKEN_FILE`: authorized service-account PAT                                                                                                                         |
| Git                       | `OCC_TEST_QA_REPOSITORY_AUTHORIZED=1`, `OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY`, and `OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE` or absolute managed `OCC_TEST_QA_GITHUB_OBSERVER_BINARY` |
| Calendar                  | `OCC_TEST_CODEX_CALENDAR_TOOL_NAME`, `OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT`: harmless read and successful-result pattern                                                              |
| Slack                     | `OCC_TEST_QA_SLACK_APP_TOKEN_FILE`, `OCC_TEST_QA_SLACK_BOT_TOKEN_FILE`, `OCC_TEST_QA_SLACK_SENDER_TOKEN_FILE`, `OCC_TEST_QA_SLACK_CHANNEL_ID`                                          |

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

`TEST_ENV_FILE` is the private environment file described above. For a hosted run,
use the trusted-PR labels described under [Trigger](#trigger), or dispatch
`qa-advisory.yml` from `main` after configuring the required environment.

## Results and limits

`matrix.json` records completed stages as `passed`, `failed`, or `blocked`.
Inspect selections, runner failures and cleanup: absent, filtered or interrupted
stages are not passes. `scope: full` means both installations and presets were selected
with the default `all` scenario set; it does not include the four explicit selectors.
The hosted Codex advisory selection is narrower than that full matrix. Hosted
outcomes expire after seven days. Local installation results use
`qa-advisory-local-installation-dev-up-k3d`; each OpenShell shard uses
`qa-advisory-<test-file-basename>-openshell` (omit `.test.mjs` or `.test.ts`).

Cleanup stops the Agents and installations created by the run. If credential disposal is uncertain, cleanup keeps the installation and reports the required recovery.
Keep its broker until sessions are `DISPOSED` without active uses or pending,
uncertain or auxiliary cleanup. Preserve other runs' resources. For Git TLS
errors, compare broker DNS with approved endpoints/NetworkPolicy,
[refresh approved inputs](../../guides/deploy/local-repository-credentials.md#prepare-the-approved-inputs),
complete disposal, then recreate only this run's installation.

Add stages in [qa-matrix-real.test.mjs](../../../tests/integration/qa-matrix-real.test.mjs),
following [fixture conventions](../fixtures-and-scenarios.md); register inputs in
the manifest and workflow. Workers create Agents and clean them up; keep dependent steps
sequential and installation-wide changes outside workers. Preserve failure,
security and disposal assertions.

## Files

- [Advisory workflow](../../../.github/workflows/qa-advisory.yml): eligibility, parallel OpenShell runners, and artifact names.
- [QA manifest](../../../scripts/ci/test-suites/qa-matrix.json) and [OpenShell manifest](../../../scripts/ci/test-suites/openshell.json): exact files and requirements.
- [QA matrix test](../../../tests/integration/qa-matrix-real.test.mjs): Agent scenarios.
- [Scenario selection](../../../tests/helpers/qa-selection.mjs): presets, selectors, and required inputs.
- [Hosted credentials](../../../scripts/ci/qa-matrix-credentials.mjs): environment preparation.
