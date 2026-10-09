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
repository broker. Within a preset, two scenario workers run concurrently by
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
cleanup. Compose does not claim integrated shared-session native tabs.

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
  The default `all` covers both; CI forces `all`. A partial run is labeled in
  `matrix.json` and cannot establish a full matrix pass.
- `OCC_TEST_QA_ARTIFACTS`: output directory; otherwise a private temporary directory
  is allocated and printed.

Missing prerequisites fail their selected stages. An opt-out skip from running
without `OCC_TEST_QA_MATRIX=1` is not a matrix pass.

## CI, evidence, and recovery

The `qa-matrix` lane runs only when **Full Integration** is dispatched with
`lane: qa-matrix`; `all` and the `full` group exclude it until the protected
`integration-qa` environment and its QA secrets exist. That environment needs
independent reviewers and the approved main branch before dispatch.
The workflow materializes file-backed credentials in runner temporary storage and
uploads only the outcome/evidence JSON files. It does not upload private state or
raw command logs. The job is ordered after the focused Slack job so they
cannot compete for Socket Mode delivery once `all` includes it.
`scripts/ci/test-suites/qa-matrix.json` owns lane registration.

Replay through the credentialed runner with the same environment:

```sh
node --env-file="$TEST_ENV_FILE" scripts/ci/prepare.mjs --lane qa-matrix \
  --state /tmp/qa-matrix-state.json
node --env-file="$TEST_ENV_FILE" scripts/ci/run-tests.mjs run qa-matrix \
  --state /tmp/qa-matrix-state.json --results /tmp/qa-matrix-results.json
```

### Read scenario outcomes

The test runner prints named subtests. `matrix.json` records completed stage
callbacks with `cell`, `stage`, `outcome`, `startedAt`, and `durationMs`.
Worker stages also include `scenario`; failures include a redacted `reason`:

- `passed`: the stage completed its assertions.
- `failed`: execution or an assertion failed.
- `blocked`: the stage reported a prerequisite failure, such as unavailable
  installation setup or Agent deployment.

Installation setup uses `compose` or `kubernetes` as its cell; preset stages use
names such as `compose/Codex`. Completed stages enter the report in completion
order. Writes are serialized and published atomically, so simultaneous workers
do not overwrite outcomes or expose partial JSON. Earlier outcomes remain
available when a later stage fails. The workflow retains these files in
its `qa-matrix-<run-id>-<attempt>` artifact for seven days.

A grouped stage has one outcome: clone, commit, push, and PR creation are not
separate result rows. Cell evidence adds Agent/revision/Pod identities, nonce
results, remote SHAs, credential disposal, and Slack timestamps. The summary
has per-stage wall-clock durations, excluding queue time and report writes, but
no explicit `not run`/`not applicable` rows. Parallel durations overlap; adding
them does not give the overall run duration.
Filtered, unentered, or interrupted stages can be absent; absence is not a pass.
Inspect runner failures and cleanup results alongside the JSON.

`scope: full` identifies the selected installations, not a successful run.
`partial:*` identifies installation selection or test-name filtering. Exclusions
remain explicit. A successful static check or parent setup does not establish
that every live scenario passed.

Ordinary cleanup stops agents and calls `scripts/dev-down` with each owned state
directory. If repository disposal is uncertain, the fixture retains its
installation and reports the recovery path. Keep that broker alive until its
sessions are `DISPOSED`, with zero active uses, active/pending/uncertain cleanup,
and no auxiliary cleanup pending. Do not delete another run's resources.

### Intermittent Git connection failures

If native Git reports `GnuTLS recv error` or an unexpectedly closed TLS
connection, check the broker's upstream connectivity before changing certificate
trust or command deadlines. An upstream connection failure can cause the broker
to close the Agent connection without returning an HTTP error.

Verify the addresses resolved for both `github.com` and `api.github.com` from
the broker Pod against the private `upstream-cidrs.json` fixture and installed
NetworkPolicy. DNS answers can rotate: an allowed address may succeed while a
different address is refused on the next clone or fetch. A successful API call
does not prove Git egress, and a single successful DNS lookup is insufficient.
Use the [local repository input procedure](../guides/deploy/local-repository-credentials.md#prepare-the-approved-inputs)
to refresh the approved endpoints. After confirming session disposal, recreate
only the run-owned installation and rerun the affected scenarios. Keep the Git,
sandbox, and disposal assertions intact; retries do not correct a missing
egress destination.

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
