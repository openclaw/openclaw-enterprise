# Run the QA matrix

The matrix tests Compose and Kubernetes control-plane installations, both with Kubernetes compute, using OpenClaw and Codex Agents. It creates disposable clusters and private state; it does not use an existing cluster or change the default kubeconfig. A full run uses real model, GitHub, Calendar, and Slack services.

## Select scenarios

From the repository root, build the CLI and run the full matrix using a private environment file:

```sh
pnpm cli:build
OCC_TEST_QA_MATRIX=1 node --env-file="$TEST_ENV_FILE" \
  --test tests/integration/qa-matrix-real.test.mjs
```

Select a subset when needed:

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_SCENARIOS=model-ui,calendar \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/qa-matrix-real.test.mjs
```

`OCC_TEST_QA_INSTALLATION` accepts `all` (default), `compose`, or `kubernetes`. `OCC_TEST_QA_PRESET` accepts `all` (default), `OpenClaw`, or `Codex`. `OCC_TEST_QA_SCENARIOS` accepts `all` (default) or a comma-separated subset below. Invalid or wholly inapplicable selections fail before provisioning. Missing inputs fail selected checks; running without `OCC_TEST_QA_MATRIX=1` skips the suite and is not a pass.

## Coverage and applicability

| Scenario   | OpenClaw | Codex | Effect                                                                          |
| ---------- | -------- | ----- | ------------------------------------------------------------------------------- |
| `model-ui` | Yes      | Yes   | Real model turn and native browser response.                                    |
| `git-full` | Yes      | Yes   | Clone, edit, commit, push, open a PR, verify remotely, and dispose credentials. |
| `git-read` | —        | Yes   | Reject a read-only push and dispose credentials.                                |
| `calendar` | —        | Yes   | Read Calendar and check approval and tool restrictions.                         |
| `slack`    | —        | Yes   | Send and observe a threaded reply and a new root message.                       |

Both installation modes run shared startup and authenticated console login. Repository broker setup runs only when a Git scenario is selected. Linear is excluded. A successful Calendar read is required to prove approval behavior. The Slack sender and gateway bot must be distinct channel members; reserve the Socket Mode app for this run.

Scenarios run on separate Agents. Set `OCC_TEST_QA_CONCURRENCY` from `1` to `4` (default `2`); use `1` to diagnose serially. Installations and the Slack scenario run sequentially. Each gateway can use up to 4 GiB in addition to shared services.

## Prerequisites and credentials

Follow the [Kubernetes prerequisites](kubernetes.md) and [Compose with Kubernetes compute setup](../guides/deploy/local-compose-kubernetes.md). You need Docker, k3d, kubectl, Helm, Go, OpenSSL, Chromium/Playwright, `certutil`, and installed workspace dependencies. Provide enough disk and memory for the cluster and Agents.

Put inputs in a private environment file. Credential paths must point to regular files with no group or other permissions. Supply inputs only for selected scenarios and presets:

| Input                                                                                                                                         | Required for                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `OCC_TEST_QA_OPENAI_KEY_FILE`                                                                                                                 | OpenClaw model calls.                                                                                 |
| `OCC_TEST_QA_CODEX_TOKEN_FILE`                                                                                                                | Codex model calls, including Calendar. Use an authorized service-account PAT.                         |
| `OCC_TEST_QA_REPOSITORY_AUTHORIZED=1`, `OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY`                                                               | Git. Authorizes disposable branches and PRs in the fixture repository.                                |
| `OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE` or `OCC_TEST_QA_GITHUB_OBSERVER_BINARY`                                                              | Git. Independent observer and cleanup credential, or an absolute managed `gh` wrapper.                |
| `OCC_TEST_CODEX_CALENDAR_TOOL_NAME`, `OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT`                                                                  | Calendar. An available harmless read tool and a pattern proving its successful result.                |
| `OCC_TEST_QA_SLACK_APP_TOKEN_FILE`, `OCC_TEST_QA_SLACK_BOT_TOKEN_FILE`, `OCC_TEST_QA_SLACK_SENDER_TOKEN_FILE`, `OCC_TEST_QA_SLACK_CHANNEL_ID` | Slack. Sender must be distinct from the bot and be able to post and read channel history and replies. |

Git requires a [development repository registry](../guides/deploy/local-repository-credentials.md) with exactly one authorized repository, the `${OCC_INITIAL_NAMESPACE_ID}` placeholder, `git-read` and `git-full` profiles, and approved IPv4 `/32` upstream endpoints. The input directory contains `registry.json`, `private-key.pem`, and `upstream-cidrs.json`. Its push allowlist must permit the run's branch names. The observer token is not given to the Agent; the observer cleans only verified run-owned refs.

Optional model overrides are `OCC_TEST_QA_OPENAI_MODEL` and `OCC_TEST_QA_CODEX_MODEL` (both default to `gpt-6-luna`). `OCC_TEST_QA_ARTIFACTS` selects the result directory; otherwise the runner prints a private temporary directory. To reuse matching immutable local images, set `OCC_TEST_QA_CONTROLLER_IMAGE` and `OCC_TEST_QA_RUNTIME_IMAGE` together; `OCC_TEST_QA_REPOSITORY_IMAGE` selects the broker image. See the [lane definition](../../scripts/ci/test-suites/qa-matrix.json) for other overrides.

## CI, evidence, and recovery

[QA Matrix Advisory](../../.github/workflows/qa-advisory.yml) runs Codex `model-ui` and `calendar` in separate Compose and Kubernetes jobs, plus a separate credential-free `dev-up-k3d` job, for trusted same-repository PRs. These jobs are not required checks. Fork and Dependabot PRs need a trusted run; new pushes cancel superseded runs. `integration-qa-pr` supplies only the Codex token and Calendar configuration to trusted PR code.

For the complete matrix, dispatch [Full Integration](../../.github/workflows/full-integration.yml) on `main` with `lane: qa-matrix` and protected `integration-qa` approval. Full Integration serializes this lane with the focused Slack lane to avoid competing consumers. `all` does not select it. The default `qa_repository_fixture` uses the configured default repository secrets. `isolated` requires `QA_ISOLATED_REPOSITORY_OBSERVER_TOKEN`, `QA_ISOLATED_REPOSITORY_REGISTRY_JSON`, and `QA_ISOLATED_REPOSITORY_APP_KEY` as `integration-qa` environment secrets, and `QA_ISOLATED_REPOSITORY_FULL_NAME` as an environment variable. The registry must contain exactly that lowercase `owner/repository`, which must differ from the workflow repository. Missing or mismatched inputs fail; there is no fallback to default credentials.

### Read scenario outcomes and recover failures

`matrix.json` records completed stages as `passed`, `failed`, or `blocked`. Check the selection inventory and runner failures: an absent, filtered, or interrupted stage is not a pass. `scope: full` means all scenarios were selected, not that they passed. PR and manual workflows retain outcome JSON for seven days; inspect cleanup results as well.

Cleanup stops run-owned Agents and installations. If repository credential disposal is uncertain, the fixture retains its installation and reports a recovery path. Keep its broker alive until sessions are `DISPOSED` with no active uses or pending, uncertain, or auxiliary cleanup. Do not remove another run's resources.

For Git TLS failures, compare DNS answers for `github.com` and `api.github.com` from the broker Pod with the approved `upstream-cidrs.json` and NetworkPolicy. DNS can rotate; a successful API call does not prove Git egress. Refresh approved endpoints using the [repository input procedure](../guides/deploy/local-repository-credentials.md#prepare-the-approved-inputs). After disposal completes, recreate only the run-owned installation and retry.

## Extend the scenarios

Add a named stage in [`qa-matrix-real.test.mjs`](../../tests/integration/qa-matrix-real.test.mjs) and follow [fixture and scenario conventions](fixtures-and-scenarios.md). Each worker owns its Agent and cleanup; keep dependent steps sequential and installation-wide changes outside workers. Register new inputs in the [lane definition](../../scripts/ci/test-suites/qa-matrix.json), protected workflow setup, and this guide. Preserve existing failure, security, and disposal assertions.
