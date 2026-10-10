# Run the shipped installation QA matrix

Run this credentialed suite to verify the two development installation paths with
real Standard OpenClaw and Standard Codex agents:

```sh
pnpm cli:build
OCC_TEST_QA_MATRIX=1 node --env-file="$TEST_ENV_FILE" \
  --test tests/integration/qa-matrix-real.test.mjs
```

The suite calls `scripts/dev-up` for Compose OCC + Kubernetes compute and
Kubernetes OCC + Kubernetes compute. Both use Sandbox Driver `none`. Each
installation runs its two presets sequentially, selecting the appropriate Plugin
Driver and stopping the prior agents before switching. It creates unique clusters,
Compose projects, ports, and private state directories. It does not select an
existing cluster or change the default kubeconfig.

## Parallel scenarios on shared setup

Each installation creates one k3d cluster and reuses its control plane and
repository broker when Git is selected. Within a preset, two scenario workers run concurrently by
default. Each owns a fresh Agent, configuration, credentials, and workspace:

- `model-ui`: model and native browser assertions, in that order.
- `git-full`: native checkout/edit/commit/push/PR and credential disposal.
- `calendar`: Codex Calendar reads and approval-policy transitions.
- `git-read`: Codex read-only push denial and credential disposal.

The steps inside each scenario stay sequential. Separate chat sessions on one
Agent would still share its policy, deployment, and workspace. Calendar and Git
therefore use different Agents. There is one browser scenario at a time, so the
Compose TLS relay cannot switch targets during another browser test.

After those workers finish and stop their Agents, the Codex `slack` scenario
runs on its own Agent. Slack setup can restart shared services; its Socket Mode
consumer is disabled before the next installation starts. Installations stay
sequential to avoid competing for the same Slack app credentials.

Set `OCC_TEST_QA_CONCURRENCY` to an integer from `1` to `4` (default `2`). Use `1`
for a serial diagnostic replay. Increase it only with sufficient cluster memory
and model-service capacity; each gateway has a 4 GiB memory limit, in addition to
any dedicated Agent and shared services. This is scenario concurrency, not a
request to create more clusters or reuse an existing external installation.

Teardown waits for all workers. Every repository worker tracks its own pending
credential disposal; one successful cleanup cannot release another worker's
unresolved session or allow its broker to be removed.

## Select scenarios

`OCC_TEST_QA_SCENARIOS` accepts `all` (the default) or a comma-separated list of
`model-ui`, `calendar`, `git-full`, `git-read`, and `slack`.
`OCC_TEST_QA_INSTALLATION` accepts `all`, `compose`, or `kubernetes`;
`OCC_TEST_QA_PRESET` accepts `all`, `OpenClaw`, or `Codex`.
For example, run model/UI and Calendar checks in both installations:

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_SCENARIOS=model-ui,calendar \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/qa-matrix-real.test.mjs
```

Selection includes installation startup, preset preparation, Agent deployment,
and cleanup. Browser login runs for `model-ui`; repository setup runs only for
Git scenarios. Presets without an applicable selected scenario do not deploy an
Agent. Invalid names and wholly inapplicable selections fail before provisioning.
Only selected model credentials and scenario inputs from the table below are
required: Calendar needs the Codex token and its tool/result settings; Git needs
repository authorization, inputs, and observer; Slack needs its tokens/channel.
A selected check with missing credentials fails rather than becoming a skip.

## Coverage and applicability

The named stages below are implemented in
[`qa-matrix-real.test.mjs`](../../tests/integration/qa-matrix-real.test.mjs).
Installation setup runs once before its two preset cells; the remaining stages
run for each applicable cell.

| Scenario                                                                           | Compose OpenClaw | Compose Codex | Kubernetes OpenClaw | Kubernetes Codex |
| ---------------------------------------------------------------------------------- | ---------------- | ------------- | ------------------- | ---------------- |
| Shipped startup, ready default Namespace, shipped presets                          | Shared setup     | Shared setup  | Shared setup        | Shared setup     |
| Authenticated console login                                                        | Shared setup     | Shared setup  | Shared setup        | Shared setup     |
| Repository broker setup                                                            | Shared setup     | Shared setup  | Shared setup        | Shared setup     |
| Preset deployment and supported authentication                                     | Yes              | Yes           | Yes                 | Yes              |
| Real model nonce, unauthenticated denial, exact Agent/revision/Pod                 | Yes              | Yes           | Yes                 | Yes              |
| Trusted native UI and live WebSocket model response                                | Yes              | Yes           | Yes                 | Yes              |
| Native repository clone/edit/commit/push/PR, independent remote readback, disposal | Yes              | Yes           | Yes                 | Yes              |
| Read-only repository push rejected and session disposed                            | —                | Yes           | —                   | Yes              |
| Calendar read, allow-once, subsequent denial, automatic review, disabled tool      | —                | Yes           | —                   | Yes              |
| Single Slack ingress, one threaded reply, native outbound root                     | Unsupported      | Yes           | Unsupported         | Yes              |
| Ordinary Agent cleanup, when an Agent remains running                              | Yes              | Yes           | Yes                 | Yes              |

Linear READ is explicitly excluded because the provider is currently broken.
Calendar must perform a successful harmless read before approval denial can pass.
A provider error does not establish denial. Allow-once and the subsequent denial
share a session; the observer correlates native call/result identities. Explicitly
disabled tools must remain unavailable even when their approval policy permits use.

Compose native UI access uses the documented gateway password through a
loopback TLS relay. Kubernetes native access uses the console's authenticated
native-admin endpoint with the documented [per-Agent native-admin opt-in](../guides/deploy/native-admin.md). The suite installs only its uniquely named CA trust entry,
keeps browser certificate verification enabled, and removes that trust entry at
cleanup. Compose does not claim integrated shared-session native tabs. Its private routing
files retain mode `0600` and use the controller image’s UID/GID so hosted runner
identity differences do not prevent controller startup.

Slack applies only to Codex. The sender and gateway bot must be distinct members
of the authorized channel. The sender credential must permit posting plus
`conversations.history` and `conversations.replies` reads for that channel. There is exactly one initial send per applicable cell,
no send retry, and at least 60 seconds of observation after the first response.
History and thread reads are paginated; the observer requires the expected bot,
channel, original `thread_ts`, exact nonce, and native Codex turn evidence. A
separate native-tool task sends one new root message, also checked against its
actual tool result and observed for duplicates. A competing Socket Mode consumer
can cause a failure; the suite does not stop it or resend to compensate. Run with an app reserved for this proof.

## Prerequisites and credentials

Follow the [Kubernetes prerequisites](kubernetes.md) and the
[Compose with Kubernetes compute procedure](../guides/deploy/local-compose-kubernetes.md).
Docker, k3d, kubectl, Helm, Go, OpenSSL, Chromium/Playwright, `certutil`, and a matching
installed workspace dependency graph are required. Allow enough disk and memory
for the images, OCC, PostgreSQL, Envoy, and the agent workloads.

Set these values in a private environment file. Credential paths must name
regular files with no group/other permissions. Do not put secret values in command
arguments or commit the environment file.

| Variable                                                               | Required value                                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_QA_OPENAI_KEY_FILE`                                          | Authorized OpenClaw model API key file.                                                                                                        |
| `OCC_TEST_QA_CODEX_TOKEN_FILE`                                         | Authorized Codex service-account PAT file, admitted as `codex_pat`.                                                                            |
| `OCC_TEST_QA_OPENAI_MODEL`, `OCC_TEST_QA_CODEX_MODEL`                  | Optional authorized model overrides; both default to `gpt-6-luna` when unset or empty.                                                         |
| `OCC_TEST_QA_REPOSITORY_AUTHORIZED`                                    | `1`, authorizing disposable branches and PRs in the registry repository.                                                                       |
| `OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY`                               | Private directory containing `registry.json`, `private-key.pem`, and `upstream-cidrs.json`, as described below.                                |
| `OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE`                               | Independent GitHub observer/cleanup credential. Alternatively select an absolute managed gh wrapper with `OCC_TEST_QA_GITHUB_OBSERVER_BINARY`. |
| `OCC_TEST_CODEX_CALENDAR_TOOL_NAME`                                    | Exact native transcript name of an available harmless Calendar read tool.                                                                      |
| `OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT`                                | Pattern establishing a genuine successful Calendar read.                                                                                       |
| `OCC_TEST_QA_SLACK_APP_TOKEN_FILE`, `OCC_TEST_QA_SLACK_BOT_TOKEN_FILE` | Approved Socket Mode app and gateway bot token files.                                                                                          |
| `OCC_TEST_QA_SLACK_SENDER_TOKEN_FILE`                                  | Distinct approved sender token file with channel and thread read access.                                                                       |
| `OCC_TEST_QA_SLACK_CHANNEL_ID`                                         | Authorized channel joined by both bots.                                                                                                        |

The repository input uses the [development repository registry](../guides/deploy/local-repository-credentials.md)
with exactly one authorized repository, the `${OCC_INITIAL_NAMESPACE_ID}` placeholder,
and `git-read` and `git-full` profiles. Upstream CIDRs must be approved IPv4 `/32`
endpoints. The runner never gives its observer token to an agent. Git commands and
PR creation execute through the real native agent and repository broker; the
observer reads independent remote state and cleans up only verified owned refs.
Transcript completion uses a separate plain token so formatting the PR body's
HTML comment cannot obscure a completed native turn.
The native sandbox probe runs a fixture script from the read-only plugin mount;
it must write inside the workspace, report denial outside it, and preserve the
outside sentinel. Its exact command and result must appear in the native turn
and gateway transcript. The probe reports the expected write denial as success;
repository operations must continue afterward.
A private registry copy restricts pushes to this run’s exact branch names. Any
existing push allowlist must permit those names. The repository stage enables
native command tools explicitly; initial model/UI checks retain the preset tool
policy. Read-only rejection uses a fresh Agent workspace.

Optional settings:

- `OCC_DEVELOPMENT_K3S_IMAGE`: explicitly select an available K3s image for the
  Compose launcher to avoid release-channel resolution during replay.
- `OCC_DEVELOPMENT_K3D_DNS_RESOLVER`: the approved upstream resolver when the host
  resolver is unreachable from the disposable cluster.

- `OCC_TEST_QA_CONTROLLER_IMAGE` and `OCC_TEST_QA_RUNTIME_IMAGE`: select together;
  immutable locally available references whose source revision matches the checkout.
- `OCC_TEST_QA_REPOSITORY_IMAGE`: an immutable broker image from the same checkout.
  Without selected images, the launcher and fixture build from source.
- `OCC_TEST_BROWSER_EXECUTABLE`: an existing Chromium executable.
- `OCC_TEST_CODEX_CALENDAR_PLUGIN_ID`, `OCC_TEST_CODEX_CALENDAR_PROMPT`, and
  `OCC_TEST_CODEX_CALENDAR_EXPECT`: existing Calendar fixture overrides.
- `OCC_TEST_QA_INSTALLATION`: `compose` or `kubernetes` for a partial local replay.
  The default `all` covers both; Full Integration forces `all`. A partial run is labeled in
  `matrix.json` and cannot establish a full matrix pass.
- `OCC_TEST_QA_ARTIFACTS`: output directory; otherwise a private temporary directory
  is allocated and printed.

Missing prerequisites fail their selected stages. An opt-out skip from running
without `OCC_TEST_QA_MATRIX=1` is not a matrix pass.

## CI, evidence, and recovery

[QA Matrix Advisory](../../.github/workflows/qa-advisory.yml) runs `model-ui`
and `calendar` in both Codex cells on every trusted
same-repository PR. Compose and Kubernetes run in separate jobs. The same workflow also runs the
[full OpenShell lane](#automatic-openshell-coverage) in a third job. Failures remain
visible, but these jobs are outside `CI Required` and must not be configured as
required branch checks. New pushes cancel superseded runs. Fork and Dependabot
PRs report that a trusted run is needed; they do not receive model credentials.

The advisory workflow uses `integration-qa-pr`: no required reviewers, deployment
branch policies allowing `refs/pull/*/merge` and `main`, and the
`CODEX_ACCESS_TOKEN` and `OPENAI_API_KEY` secrets. The OpenShell job uses
`OPENAI_API_KEY` with `OCC_TEST_OPENAI_MODEL`; the two QA matrix jobs use
`CODEX_ACCESS_TOKEN`. Set the Codex model and Calendar
variables from the table above; the Codex account must have Calendar connected.
These credentials are available to trusted PR code. Manual dispatch on `main`
can replay the same selection. Runner resources are disposable; always-run steps
attempt owned cleanup and remove temporary credential files.

OpenClaw, Git and Slack scenarios remain manual. Adding OpenClaw to the PR
selection requires an OpenAI API key accepted from hosted runners; a successful
devbox request alone does not prove that access.

**Full Integration**, dispatched with `lane: qa-matrix`, retains the complete
selection and protected `integration-qa` approval. The `all` dispatch and `full`
group exclude this lane. Its job runs after the focused Slack job to avoid
competing Socket Mode consumers. Both workflows materialize only selected
credentials and upload outcome JSON, not private state or raw command logs. Failed commands include bounded, redacted stderr for diagnosis.
OpenClaw authentication failures also report credential-delivery equality and a
bounded provider result from the Agent Pod, without exposing the credential.
`scripts/ci/test-suites/qa-matrix.json` owns lane registration.

The dispatch input `qa_repository_fixture` selects the repository credential
fixture. Keep the default `default` value to use the existing
`REPOSITORY_OBSERVER_TOKEN`, `REPOSITORY_REGISTRY_JSON`, and
`REPOSITORY_APP_KEY` secrets. Select `isolated` to use a separate repository
fixture. Configure `QA_ISOLATED_REPOSITORY_OBSERVER_TOKEN`,
`QA_ISOLATED_REPOSITORY_REGISTRY_JSON`, and
`QA_ISOLATED_REPOSITORY_APP_KEY` as environment secrets in the protected
`integration-qa` environment, never as repository-level secrets. Configure
`QA_ISOLATED_REPOSITORY_FULL_NAME` as an `integration-qa` environment variable
so it is protected by the same independent reviewer gate. That variable must
name the one approved isolated fixture repository as lowercase
`owner/repository`. The isolated path checks the registry's repository target
before materializing credential files: the registry must contain exactly one
repository, that repository must match `QA_ISOLATED_REPOSITORY_FULL_NAME`, and
it must not be the workflow repository. The isolated path still shares the
approved model, Codex, Slack, Calendar, and upstream CIDR settings from
`integration-qa`. If any isolated repository secret or target is missing or
mismatched, credential materialization fails; the workflow does not fall back to
the default repository secrets.

Replay through the credentialed runner with the same environment:

```sh
node --env-file="$TEST_ENV_FILE" scripts/ci/prepare.mjs --lane qa-matrix \
  --state /tmp/qa-matrix-state.json
node --env-file="$TEST_ENV_FILE" scripts/ci/run-tests.mjs run qa-matrix \
  --state /tmp/qa-matrix-state.json --results /tmp/qa-matrix-results.json
```

### Read scenario outcomes and recover failures

Use the [QA matrix results and recovery guide](qa-matrix-results.md) to read
`matrix.json`, interpret partial or absent stages, preserve repository cleanup
evidence, and debug intermittent Git connection failures without weakening Git,
sandbox, or disposal assertions.

## Extend the scenarios

Add a named `stage(...)` in
[`qa-matrix-real.test.mjs`](../../tests/integration/qa-matrix-real.test.mjs), using
an existing helper or a focused helper under `tests/helpers/`. Keep its
assertions about observable behavior and add its applicability to the table
above. See [fixture and scenario conventions](fixtures-and-scenarios.md).

- Reuse installation setup. State the prerequisites and report unavailable
  prerequisites as blocked instead of passing an empty scenario.
- Add independent cases to the named scenario list; each worker receives its
  own Agent and must clean up only that Agent. Keep dependent steps sequential
  within the worker. Installation-wide changes belong before or after the
  joined worker group, never inside a parallel scenario.
- Register cleanup with the fixture, preserve uncertain credential-disposal
  recovery, and record only nonsecret evidence.
- For new required inputs, update
  [`qa-matrix.json`](../../scripts/ci/test-suites/qa-matrix.json), the protected
  workflow credential setup when needed, and this page's prerequisites.
- Before moving an existing scenario here, retain its unique failure and
  security assertions. Share setup rather than duplicating an entire suite.

The installation and preset choices are explicit in the runner. Adding a new
compute driver or topology also requires fixture support; adding one stage does
not automatically qualify another deployment mode.

## Consolidated coverage

| Previous owner                                                        | Canonical or retained owner                                                                                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native Git/PR journeys in `repository-credentials-k3d-real.test.mjs`  | Shared `repository-native-journey.mjs`, executed in all four matrix cells. Installed credential isolation and sandboxed read-only denial remain focused cases.                               |
| Retrying Slack delivery in `harness-topology-k3d-slack-real.test.mjs` | `slack-delivery.mjs` single-send proof in both Codex cells and the focused Slack lane until hosted qualification. Credential placement, proxy denial, and Socket Mode checks remain focused. |
| Browser chat helpers in `native-admin-k3d-real.test.mjs`              | Shared `native-ui-chat.mjs`. Native access boundaries, session isolation, drift, and lifecycle cases remain focused.                                                                         |
| `dev-up-k3d-real.test.mjs` and topology model suites                  | Retain launcher rejection, teardown, sandbox, and topology/isolation contracts. The matrix adds the exact four shipped combinations.                                                         |

Shared fixture extraction does not imply that a live run passed. Consult the
specific run's outcome and evidence files.
The direct installed repository suite retains its pre-existing safety guard
pending qualification of that entry point's remote cleanup; its retained cases
are not claimed as runnable acceptance coverage.

## Automatic OpenShell coverage

The [QA advisory workflow](../../.github/workflows/qa-advisory.yml) runs the full
`openshell` lane on trusted same-repository PRs, alongside the Compose and
Kubernetes Codex checks. Fork and Dependabot PRs require trusted execution.
The OpenShell job uses GitHub Ubuntu with an early Landlock ABI check; the
Blacksmith kernel cannot enforce its sandbox filesystem policy. It is outside
`CI Required`: failures remain visible without
blocking merges. Its result artifact is `qa-advisory-openshell`.

The [lane manifest](../../scripts/ci/test-suites/openshell.json) selects five
real-runtime scenarios: installation with each control-plane mode, sandbox
policy and credential enforcement, and first-Agent deployment and reuse with
each mode. One job runs all four files, rejecting skips and cleaning up its
owned clusters and databases. It builds runtime images from the tested revision
and covers credential projection. The `integration-qa-pr` environment
supplies `OPENAI_API_KEY` and `OCC_TEST_OPENAI_MODEL`; the existing protected
manual OpenShell environment remains available for targeted dispatch.
