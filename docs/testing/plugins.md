# Agent plugin testing

Use these checks when verifying Agent-owned plugin selections, PluginDriver
translation, and native runtime behavior. Run commands from the repository root.
The [Agent plugin reference](../reference/agent-plugins.md) owns supported API
behavior; this page owns contributor setup and fixture inputs, and
[Agent plugin proof notes](plugins-proof-notes.md) own proof notes.

## Local and integration suites

| Check                          | Command or file                                                                                                                                                                          | Covers                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract and API behavior      | `pnpm test:conformance` and `node --test tests/integration/occ-api.test.mjs`                                                                                                             | Plugin map schemas, exact-Agent authorization, omission/replacement/clear semantics, audit, deployment-status polling, and immutable requested-state snapshots. |
| Driver translation and startup | `node --test tests/conformance/plugin-driver.test.mjs tests/integration/plugin-driver-startup.test.mjs`                                                                                  | Curated catalog projection, selected-only Codex defaults, unsupported-policy startup failure, and native configuration rendering.                               |
| Compute boundaries             | `node --test tests/conformance/plugin-compute.test.mjs tests/conformance/ssh-compute.test.mjs`                                                                                           | Native install classification, verified failed-plugin exclusion, current startup status, and SSH rejection before host effects.                                 |
| PostgreSQL persistence         | `node --test --test-concurrency=1 tests/integration/postgres-restart-recovery.test.mjs tests/integration/postgres-worker-agent-revision.test.mjs` with [PostgreSQL setup](postgresql.md) | Successful deployment warnings, exact status authorization, claim fencing, and recovery.                                                                        |
| Controlled status boundary     | `node --test tests/integration/kubernetes-plugin-status-real.test.mjs`                                                                                                                   | Real Kubernetes Compute status transport, workload identity, safe readiness and runtime restart behavior with controlled producers.                             |
| Native runtime proof           | `node --test tests/integration/plugin-driver-real.test.mjs`                                                                                                                              | Opt-in Kubernetes proof against real OpenClaw or Codex, including continued operation after a selected Codex install/auth failure.                              |

The `plugin-discovery-api` integration exercises the real HTTP and IAM path and
Codex Plugin Driver with simulated upstream responses and a test Secret Driver.
The Kubernetes provisioning fixture also exercises selected-PAT discovery using
the bundled Kubernetes Secret Driver and a real cluster, with simulated upstream
responses. Neither test verifies the live hosted provider.

Skipped infrastructure or native-runtime cases are not evidence. Record the exact
commit, selected suite, nonsecret image references, native runtime versions,
model, pass/fail/skip counts, and relevant sanitized log path for every claimed
proof.

Plugin warning proof has three layers. Conformance verifies native operation
classification and effective disabled configuration. PostgreSQL worker tests
verify successful deployment warnings and live-claim fencing. Real native proof
runs through the regular Agent workflow with pinned runtime images and existing
authorized credentials: plugin A remains usable when B fails, B is disabled in
both native app and gateway bridge configuration, and sibling Agent/workspace
state is unchanged.

For dedicated Codex removal, clear the last selection through the Agent API and
redeploy. Run a native shell command in both the existing conversation and a new
one, and check its tool result against an independent workspace read. Confirm
that native plugin features remain disabled and the packaged runtime is readable
without granting broad filesystem access. Configuration readback alone does not
prove that a command can execute inside the sandbox.

The controlled status suite verifies the private status handoff through real
Kubernetes and restart behavior; its controlled native producer does not establish
Codex/OpenClaw compatibility. Missing, malformed, or foreign reports must not make
a workload ready. A changed Agent startup result must invalidate stale gateway
configuration until it is refreshed. The suite no longer proves preservation of
the first failure after a crash: that behavior is deliberately removed.

Run against the disposable cluster and imported fixture image used for other
Kubernetes fixture tests:

```sh
node --test tests/integration/kubernetes-plugin-status-real.test.mjs
```

Set `OCC_TEST_KUBERNETES_KUBECONFIG`, `OCC_TEST_KUBERNETES_CONTEXT`,
`OCC_TEST_KUBERNETES_IMAGE`, and
`OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS` (comma-separated source CIDRs).
Use the actual API-server proxy source described in the
[networking reference](../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking).
The status suite requires a worker node and schedules its runtime there to prove
cross-node access. Fixture images may use a local tag; native proof
still requires immutable image references. PostgreSQL cases use a dedicated
migrated `openclaw_k8s_*` database via `OCC_TEST_DATABASE_URL`.

## Native startup metadata reads

`tests/integration/codex-plugin-startup-reads.test.mjs` normally runs controlled
protocol cases that verify read batching, error draining, and ordered writes.
The opt-in companion `codex-plugin-startup-reads-real.test.mjs`, registered in the
credentialed `plugin-model` lane, launches a disposable Docker container with Codex 0.163.0-alpha.2,
logs in using an authorized service-account token, and runs the generated
production client against the real authenticated app-server. It checks six
catalog reads in batches of at most four, ordered results, a native invalid-plugin
error followed by successful reads, and the full installer with four disabled
selections and effective app-policy readback.

After obtaining credential authorization under [the contribution policy](../../CONTRIBUTING.md),
inject `CODEX_ACCESS_TOKEN` without putting its value in a command or file, and
set `OCC_TEST_KUBERNETES_AGENT_IMAGE` to a locally available immutable runtime
image ID or digest containing Codex 0.163.0-alpha.2:

```sh
OCC_TEST_CODEX_STARTUP_READS_REAL=1 node --test \
  --test-name-pattern='native Codex app-server' \
  tests/integration/codex-plugin-startup-reads-real.test.mjs
```

The test passes the credential through stdin, creates no host mounts or published
ports, and removes its container. It does not call a model or connector tool.
This proves compatibility with the native metadata and configuration protocol;
it does not measure production latency or replace the separate Kubernetes
lifecycle and enabled-plugin install/auth proofs.

## Native runtime prerequisites

`tests/integration/plugin-driver-real.test.mjs` is opt-in. Set one scenario flag:

- `OCC_TEST_PLUGIN_DRIVER_OPENCLAW_REAL=1` for embedded OpenClaw with the bundled
  Diffs plugin.
- `OCC_TEST_PLUGIN_DRIVER_CODEX_LINEAR_REAL=1` for catalog-selected Linear in a
  normal dedicated Codex Agent turn.
- `OCC_TEST_PLUGIN_DRIVER_CODEX_FAILURE_REAL=1` for dedicated Codex with one
  successful selected install followed by one selected install or authentication
  failure.
- `OCC_TEST_PLUGIN_DRIVER_REAL=1` only when all scenario-specific environments
  and three separate scenario-specific databases are prepared. The fixture
  rejects missing URLs and duplicate host, port, and database combinations
  before provisioning resources; do not use different host aliases for one database.

All native scenarios use Kubernetes. Provide
`OCC_TEST_KUBERNETES_KUBECONFIG`, `OCC_TEST_KUBERNETES_CONTEXT`,
`OCC_TEST_KUBERNETES_GATEWAY_IMAGE`,
`OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS`, and a scenario-specific database such as
`OCC_TEST_PLUGIN_DRIVER_OPENCLAW_DATABASE_URL`. The Linear and Codex failure scenarios
require their own distinct `OCC_TEST_PLUGIN_DRIVER_CODEX_LINEAR_DATABASE_URL` and
`OCC_TEST_PLUGIN_DRIVER_CODEX_FAILURE_DATABASE_URL`.
The OpenClaw scenario also requires `OPENAI_API_KEY` in the process environment
and a runtime image with `plugins install --no-enable` support. The repository's
OpenClaw pin lacks that flag; select a compatible runtime before running this
scenario. It checks explicit tool allowlist composition, per-tool disable and
re-enable over opposite defaults, and preservation of operator tool denies on
redeploy. Prompt inventory and transcript evidence must exclude the disabled
Diffs tool. The final deployment checks a disabled selection alongside native
plugin deny and rejects a later conflicting enabled selection before the
replacement becomes ready.

Codex scenarios additionally need a Codex runtime image via
`OCC_TEST_KUBERNETES_AGENT_IMAGE` or `OCC_TEST_KUBERNETES_CODEX_IMAGE`, an
injected `CODEX_ACCESS_TOKEN` for the existing designated test account, and a
runtime image that supports `OPENCLAW_STATE_DIR` for OpenClaw state writes when
the test starts without a useful `HOME`. Set `OCC_TEST_OPENAI_MODEL` to a model
supported by that Codex path; the current source default is `gpt-6-astra`.
Prepare the reviewed [Codex sandbox profile](../guides/deploy/codex-sandbox.md)
on the test nodes and set `OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE` to its
kubelet-relative path. Codex fixtures use a 4 GiB Gateway limit and a 2 GiB
Harness limit; the namespace quota allows two Agent pairs and revision overlap.
Provide enough cluster memory for the selected scenario and its other workloads.
The [shipped QA matrix](qa-matrix.md) owns Calendar per-call approval and
disabled-tool coverage through both shipped installations. The focused
`plugin-model` lane retains plugin installation, isolation, and failure recovery;
it has no GitHub workflow entrypoint and is excluded from the `ci` and `full`
groups. Without an opt-in flag, the native scenarios skip. Neither a green
required CI run nor an unselected scenario proves live Calendar behavior.

The matrix and the retained Codex failure proof need `OCC_TEST_CODEX_CALENDAR_TOOL_NAME` and
`OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT`, and must show a model-chosen harmless
read during a normal Agent turn. Select an exact tool advertised by the connected
account; the historical `list_calendars` tool is not available in every catalog.
Set `OCC_TEST_CODEX_CALENDAR_PROMPT` when selecting a different read, such as
`codex_apps.google_calendar.get_profile`. Discovery alone does not prove execution.

The Linear catalog proof requires that the same authorized account has Linear
connected. Set `OCC_TEST_CODEX_LINEAR_PROMPT` to a harmless read request,
`OCC_TEST_CODEX_LINEAR_TOOL_NAME` to its exact transcript tool name, and
`OCC_TEST_CODEX_LINEAR_RESULT_EXPECT` to evidence in its result. The test
discovers Linear without a catalog credential, selects it through OCC, deploys
it, checks the native identity, and verifies the tool call in a normal turn.

The Codex failure proof uses
`--test-name-pattern 'curated Codex plugin failure'`. It selects plugin A
through OCC before the first deployment, then reads the actual native catalog
from A's enabled app-server. Plugin A defaults to
`codex-plugin:google-calendar@openai-curated-remote` and must already be
authenticated for the selected test account; override it with
`OCC_TEST_CODEX_SUCCESS_PLUGIN_ID` only for another connected app. Plugin B is
chosen from newline-delimited `OCC_TEST_CODEX_FAILURE_PLUGIN_IDS` or the default
Microsoft SharePoint, Outlook Calendar, and Financial Charts candidates. B must
produce a real native authentication or install failure; do not substitute a
synthetic or controlled producer for this proof. The test proves the admitted
A-before-B order, reports `PLUGIN_AUTH_REQUIRED` or `PLUGIN_INSTALL_FAILED` for
B as a warning on a successful deployment, verifies B's bridge entry and
failed-only native app bindings are disabled, preserves the requested revision
and sibling Agent Pod/workspace file, and proves A still works through a normal
Agent tool turn. It also restarts only the Codex Agent Pod and checks refreshed
effective configuration while preserving the gateway Pod. When exact Calendar
tool/result selectors are omitted for this failure scenario, transcript evidence
identifies the actual `list_calendars` call and requires its successful structured
result without printing calendar contents. This native proof does not replace
the controlled status boundary suite above.

The focused Codex fixtures import the designated existing ServiceAccount token
through their test fixture. The QA matrix uses the shipped Secret API and
supported `codex_pat` authentication instead. Neither path proves creation of a
new upstream account. Never print credential values or resolved account identifiers.

## Per-call approval acceptance

The Calendar scenario also redeploys the same Agent with
`toolDefaults: { approval: "all_actions", reviewer: "human" }`. It connects an
operator approval client to the disposable Gateway, allows one read, then denies
the repeated read in the same session. Transcript evidence must contain no tool
result while approval is pending, a successful result after approval, and an
error without the provider result after denial.

It then redeploys with `reviewer: "auto"` and repeats the read twice in one
session. Each successful call must carry a distinct approved automatic-review ID.
Evidence is scoped to the marker-bearing user turn so an earlier successful call
cannot satisfy a later assertion.

Run the [QA matrix](qa-matrix.md) with its Calendar prerequisites. The five turns exercise native
approval once, human review twice, and automatic review twice. The fixture uses
the admitted nested policy through the normal API/deployment flow; it does not
patch the native runtime or change the fixture's existing session configuration.
Missing review, an incompatible runtime, or rejected deployment fails the selected
scenario. An unselected scenario is skipped and provides no enforcement proof.

## Tool override acceptance

The same Calendar scenario continues after per-call review with two deployments.
It binds the known harmless read's raw MCP name and connector owner from
`mcpServerStatus/list` to its app-scoped OCE tool ID. With
`toolDefaults: { enabled: false, approval: "all_actions", reviewer: "human" }`, only
that tool receives `{ enabled: true, approval: "none" }`. The read must execute
without a human approval client and return the expected provider result. A second
deployment enables tools by default but sets that tool's `enabled` to `false`
while retaining `none`; a completed native turn must contain no call to the
previously working read.

Native configuration is checked for every app and observed sibling tool. The raw
MCP catalog is discovery metadata, not filtered model exposure: these assertions
prove configured defaults and exceptions, while transcript evidence proves the
selected read's execution or non-execution. The scenario never calls sibling write
or destructive tools. It does not prove title-alias collision handling, managed
requirements, or future session/model compatibility.

## Current proof notes

The nested plugin policy contract has not been verified in a real Kubernetes
Agent deployment. [Agent plugin proof notes](plugins-proof-notes.md) list the
remaining native acceptance gates, the latest installation proof, and
historical port evidence.

## Related

- [Agent plugins](../reference/agent-plugins.md)
- [Agent plugin proof notes](plugins-proof-notes.md)
- [PluginDriver](../reference/drivers/plugin.md)
- [Kubernetes testing](kubernetes.md)
- [PostgreSQL testing](postgresql.md)
- [ChatGPT service accounts](service-accounts.md)
