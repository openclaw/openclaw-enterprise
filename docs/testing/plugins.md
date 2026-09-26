# Agent plugin testing

Use these checks when verifying Agent-owned plugin selections, PluginDriver
translation, and native runtime behavior. Run commands from the repository root.
The [Agent plugin reference](../reference/agent-plugins.md) owns supported API
behavior; this page owns contributor setup, fixture inputs, and proof notes.

## Local and integration suites

| Check                          | Command or file                                                                                                                                                                          | Covers                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract and API behavior      | `pnpm test:conformance` and `node --test tests/integration/occ-api.test.mjs`                                                                                                             | Plugin map schemas, exact-Agent authorization, omission/replacement/clear semantics, audit, deployment-status polling, and immutable requested-state snapshots. |
| Driver translation and startup | `node --test tests/conformance/plugin-driver.test.mjs tests/integration/plugin-driver-startup.test.mjs`                                                                                  | Curated catalog projection, selected-only Codex defaults, unsupported-policy startup failure, and native configuration rendering.                               |
| Compute boundaries             | `node --test tests/conformance/plugin-compute.test.mjs tests/conformance/ssh-compute.test.mjs`                                                                                           | Native install classification, verified failed-plugin exclusion, current startup status, and SSH rejection before host effects.                                 |
| PostgreSQL persistence         | `node --test --test-concurrency=1 tests/integration/postgres-restart-recovery.test.mjs tests/integration/postgres-worker-agent-revision.test.mjs` with [PostgreSQL setup](postgresql.md) | Successful deployment warnings, exact status authorization, claim fencing, and recovery.                                                                        |
| Controlled status boundary     | `node --test tests/integration/kubernetes-plugin-status-real.test.mjs`                                                                                                                   | Real Kubernetes Compute status transport, workload identity, safe readiness and runtime restart behavior with controlled producers.                             |
| Native runtime proof           | `node --test tests/integration/plugin-driver-real.test.mjs`                                                                                                                              | Opt-in Kubernetes proof against real OpenClaw or Codex, including continued operation after a selected Codex install/auth failure.                              |

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

## Native runtime prerequisites

`tests/integration/plugin-driver-real.test.mjs` is opt-in. Set one scenario flag:

- `OCC_TEST_PLUGIN_DRIVER_OPENCLAW_REAL=1` for embedded OpenClaw with the bundled
  Diffs plugin.
- `OCC_TEST_PLUGIN_DRIVER_CODEX_CALENDAR_REAL=1` for dedicated Codex with Google
  Calendar.
- `OCC_TEST_PLUGIN_DRIVER_CODEX_FAILURE_REAL=1` for dedicated Codex with one
  successful selected install followed by one selected install or authentication
  failure.
- `OCC_TEST_PLUGIN_DRIVER_REAL=1` only when all scenario-specific environments
  and databases are prepared.

All native scenarios use Kubernetes. Provide
`OCC_TEST_KUBERNETES_KUBECONFIG`, `OCC_TEST_KUBERNETES_CONTEXT`,
`OCC_TEST_KUBERNETES_GATEWAY_IMAGE`,
`OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS`, and a scenario-specific database such as
`OCC_TEST_PLUGIN_DRIVER_OPENCLAW_DATABASE_URL` or
`OCC_TEST_PLUGIN_DRIVER_CODEX_CALENDAR_DATABASE_URL`. The Codex failure scenario
requires its own distinct `OCC_TEST_PLUGIN_DRIVER_CODEX_FAILURE_DATABASE_URL`.
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
The Calendar proof also needs `OCC_TEST_CODEX_CALENDAR_TOOL_NAME` and
`OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT`, and must show a model-chosen
`list_calendars(max_results:1)` read during a normal Agent turn.

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

The Calendar fixture uses a narrow test-only ServiceAccount import that preserves
the designated existing account token from a private service-account environment
file, binds it to the matching Backend, and then runs normal Agent
create/deploy/API checks. It does not prove native ChatGPT account creation,
upstream credential issuance, workspace administrator credentials, or creation of
a new upstream account. Never print credential values or resolved account
identifiers.

## Per-call approval acceptance

The Calendar scenario also redeploys the same Agent with
`toolDefaults: { approval: "prompt", reviewer: "human" }`. It connects an
operator approval client to the disposable Gateway, allows one read, then denies
the repeated read in the same session. Transcript evidence must contain no tool
result while approval is pending, a successful result after approval, and an
error without the provider result after denial.

It then redeploys with `reviewer: "auto"` and repeats the read twice in one
session. Each successful call must carry a distinct approved automatic-review ID.
Evidence is scoped to the marker-bearing user turn so an earlier successful call
cannot satisfy a later assertion.

Run with the Calendar prerequisites above and
`OCC_TEST_PLUGIN_DRIVER_CODEX_CALENDAR_REAL=1`. The five turns exercise native
approval once, human review twice, and automatic review twice. The fixture uses
the admitted nested policy through the normal API/deployment flow; it does not
patch the native runtime or change the fixture's existing session configuration.
Missing review, an incompatible runtime, or rejected deployment fails the selected
scenario. An unselected scenario is skipped and provides no enforcement proof.

## Tool override acceptance

The same Calendar scenario continues after per-call review with two deployments.
It binds the known harmless read's raw MCP name and connector owner from
`mcpServerStatus/list` to its app-scoped OCE tool ID. With
`toolDefaults: { enabled: false, approval: "prompt", reviewer: "human" }`, only
that tool receives `{ enabled: true, approval: "approve" }`. The read must execute
without a human approval client and return the expected provider result. A second
deployment enables tools by default but sets that tool's `enabled` to `false`
while retaining `approve`; a completed native turn must contain no call to the
previously working read.

Native configuration is checked for every app and observed sibling tool. The raw
MCP catalog is discovery metadata, not filtered model exposure: these assertions
prove configured defaults and exceptions, while transcript evidence proves the
selected read's execution or non-execution. The scenario never calls sibling write
or destructive tools. It does not prove title-alias collision handling, managed
requirements, or future session/model compatibility.

## Current proof notes

The nested policy contract and translation changes have not been verified in a
real Kubernetes Agent deployment. This includes default/tool overrides, Codex
per-call review and reviewer selection, and destructive defaults with explicit
tool exceptions. Contract/API/startup-fixture checks prove their own boundaries;
older model-turn results below do not prove these new policies. In particular,
explicit `reviewer:"auto"` must reach native automatic review, which can deny;
omission must retain the effective Harness reviewer.

Native proof needs a runtime containing OpenClaw
[#151260](https://github.com/openclaw/openclaw/pull/151260) and
[#152085](https://github.com/openclaw/openclaw/pull/152085), support for
`plugins install --no-enable`, plus the cluster, database, image, and credentials
above. Verify effective native app/tool configuration, session approval and
permission profile, and a real normal Agent turn before claiming approval
enforcement. A session using `never` with permissive permissions can bypass MCP
review unless strict review applies; app-level `prompt` alone is not proof.
Startup now checks explicit app reviewers against effective app/link settings,
allowed reviewers, current approval policy, and managed current-model requirements.
That check does not establish future turn routing, session/model changes, or the
turn's strict-review flag. Startup fixtures also exercise every nested tool's
enablement/approval and account/link approval defaults against the requested
policy, including unexpected exceptions that would otherwise pass subset
verification. Managed requirements beyond reviewer checks, workspace configuration,
and live reviewer availability remain draft acceptance gates. Confirm a disabled plugin remains
blocked despite an enabled tool override, and a tool exception preserves native
operator restrictions. Installation composition also remains unproven on a real
deployment.

Best-effort installation verification for
[PR #228](https://github.com/openclaw/openclaw-enterprise/pull/228) uses an isolated
Podman-backed, two-node k3d cluster and separately migrated PostgreSQL databases.
The current checks passed 54 PostgreSQL cases, all three standard Kubernetes
fixture cases, and both controlled status cases without skips. Native embedded
OpenClaw proof passed with OpenClaw `2026.9.1`, Codex `0.152.1`, and `gpt-4.1`:
the Diffs plugin installs and executes during a normal Agent turn while sibling
state remains unchanged. The exact runtime image is
`localhost/oce-spec25-runtime@sha256:f9f4c0a02ecb837c44cc8e21de460af228457e4bdc25149fa308fcd6d7bda43b`.
Native Codex proof also passed with `gpt-5.6-sol`: Google Calendar
remained usable, Outlook Calendar produced `PLUGIN_AUTH_REQUIRED`, and the
deployment succeeded with the failed bridge selection and failed-only apps
disabled. An Agent-only restart preserved the gateway Pod, refreshed its effective
configuration, and completed a real `codex_apps.google_calendar.list_calendars`
call. Requested selections and sibling Agent/workspace state were unchanged.
Both native scenarios passed without skips; the Codex proof passed again after
correcting initial gateway startup ordering, with zero initial gateway restarts.
These proofs do not establish
production Helm installation or shared-cluster admission guardrails.

### Historical port evidence

The target port is based on branch `dev/kevinlin/plugin-driver-port`; the initial
port commit was `185afba1608260adfa5b1fe9bda9ee700a4d9fee` in
[PR #121](https://github.com/openclaw/openclaw-enterprise/pull/121).

Evidence recorded for that port:

- Workspace, build, OpenAPI, format, docs, and flow validation passed.
- Baseline checks passed: 495 checks.
- Focused coverage passed API integration (17), contracts (7), plugin Compute
  plus SSH (34), Driver plus startup (14), and PostgreSQL (5 tests, zero skips;
  evidence `/tmp/plugin-driver-postgres-platform-state-port.log`).
- Full Kubernetes suite passed after one real activation regression was fixed: 89
  tests.
- Fresh OpenClaw Kubernetes plugin proof passed on commit
  `185afba1608260adfa5b1fe9bda9ee700a4d9fee`: one test, zero failures/skips,
  187.3 seconds, native OpenClaw `2026.9.1`, Codex `0.152.1`, evidence
  `/tmp/plugin-driver-openclaw-k8s-port-live-v6.log`.
- The latest target-port Codex Calendar attempt used Codex `0.152.1` and stopped
  before the normal Agent turn because the designated service-account
  authentication check returned `403`. Rerun before claiming current target
  Calendar acceptance.

Historical source-implementation evidence from PR #57 is useful provenance, but
it does not by itself prove this target port. In that source implementation,
Google Calendar normal-Agent acceptance passed with the designated service
account on Codex `0.149.0`, OpenClaw `1391f7c`, `gpt-5.6-sol`, and a successful
`list_calendars(max_results:1)` result; evidence was
`/tmp/plugin-driver-calendar-k8s-live.log`. Linear diagnostics remain historical
connector evidence and are not the current Codex acceptance target.

## Related

- [Agent plugins](../reference/agent-plugins.md)
- [PluginDriver](../reference/drivers/plugin.md)
- [Kubernetes testing](kubernetes.md)
- [PostgreSQL testing](postgresql.md)
- [ChatGPT service accounts](service-accounts.md)
