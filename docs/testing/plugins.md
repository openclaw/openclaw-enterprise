# Agent plugin testing

Use these checks when verifying Agent-owned plugin selections, PluginDriver
translation, and native runtime behavior. Run commands from the repository root.
The [Agent plugin reference](../reference/agent-plugins.md) owns supported API
behavior; this page owns contributor setup, fixture inputs, and proof notes.

## Local and integration suites

| Check                          | Command or file                                                                                                                                                     | Covers                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract and API behavior      | `pnpm test:conformance` and `node --test tests/integration/occ-api.test.mjs`                                                                                        | Plugin map schemas, exact-Agent authorization, omission/replacement/clear semantics, audit, deployment-status polling, and immutable requested-state snapshots.  |
| Driver translation and startup | `node --test tests/conformance/plugin-driver.test.mjs tests/integration/plugin-driver-startup.test.mjs`                                                             | Curated catalog projection, selected-only Codex defaults, unsupported-policy startup failure, and native configuration rendering.                                |
| Compute boundaries             | `node --test tests/conformance/plugin-compute.test.mjs tests/conformance/ssh-compute.test.mjs`                                                                      | Kubernetes preparation handoff, native install attribution, receipt latching, and SSH rejection before host effects for nonempty plugin maps.                    |
| PostgreSQL persistence         | `node --test tests/integration/postgres-restart-recovery.test.mjs tests/integration/postgres-worker-agent-revision.test.mjs` with [PostgreSQL setup](postgresql.md) | Terminal deployment outcomes, plugin `data.pluginId`, receipt acknowledgment, claim fencing, stale recovery, and active-pointer recovery.                        |
| Controlled receipt boundary    | `node --test tests/integration/kubernetes-plugin-receipt-real.test.mjs`                                                                                             | Real Kubernetes Compute, Pod finalizers, receipt ConfigMaps, runtime gate/latch behavior, and PostgreSQL claim fencing with controlled plugin-failure producers. |
| Native runtime proof           | `node --test tests/integration/plugin-driver-real.test.mjs`                                                                                                         | Opt-in Kubernetes proof against real OpenClaw or Codex runtimes, including selected Codex install/auth failures.                                                 |

Skipped infrastructure or native-runtime cases are not evidence. Record the exact
commit, selected suite, nonsecret image references, native runtime versions,
model, pass/fail/skip counts, and relevant sanitized log path for every claimed
proof.

Plugin installation failure proof has three layers. Conformance checks prove
native operation classification without transport or text matching. PostgreSQL
worker checks prove one safe terminal deployment outcome and post-commit receipt
acknowledgment. Real native proof must run through Kubernetes with real runtime
images and existing authorized credentials; it must show a selected plugin
failure or authentication requirement keeps the candidate nonserving while other
Agent/workspace state remains intact.

Kubernetes receipt proof must also cover the durable handoff. The controlled
receipt suite uses real Kubernetes Compute resources, real Pod finalizers, real
receipt ConfigMaps, and PostgreSQL queue state, but its runtime process is a
controlled native producer. It verifies that a receipt survives a failed runtime
restart until OCC observes it, later readiness cannot erase the failure,
malformed and truncated evidence stays generic, success acknowledgment releases
the Pod finalizer, and a lost worker claim before terminal commit cannot
acknowledge or erase the receipt. These receipt cases prove Kubernetes Compute
and OCC persistence; they do not prove provider-owned Harness behavior or native
Codex/OpenClaw install behavior.

Run the controlled receipt boundary suite against the same disposable Kubernetes
cluster and imported fixture image used for Kubernetes fixture tests:

```sh
node --test tests/integration/kubernetes-plugin-receipt-real.test.mjs
node --test \
  --test-name-pattern 'PostgreSQL queue rejects stale controlled receipt commits' \
  tests/integration/kubernetes-plugin-receipt-real.test.mjs
```

Set `OCC_TEST_KUBERNETES_KUBECONFIG`, `OCC_TEST_KUBERNETES_CONTEXT`,
and `OCC_TEST_KUBERNETES_IMAGE` for the imported fixture image. The fixture image
may be a local tag; native runtime proof still requires immutable image
references. The PostgreSQL claim-fencing case also requires `OCC_TEST_DATABASE_URL`
pointing at a dedicated migrated `openclaw_k8s_*` database.

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
`OCC_TEST_KUBERNETES_GATEWAY_IMAGE`, and a scenario-specific database such as
`OCC_TEST_PLUGIN_DRIVER_OPENCLAW_DATABASE_URL` or
`OCC_TEST_PLUGIN_DRIVER_CODEX_CALENDAR_DATABASE_URL`. The Codex failure scenario
requires its own distinct `OCC_TEST_PLUGIN_DRIVER_CODEX_FAILURE_DATABASE_URL`.
The OpenClaw scenario also requires `OPENAI_API_KEY` in the process environment.

Codex scenarios additionally need a Codex runtime image via
`OCC_TEST_KUBERNETES_AGENT_IMAGE` or `OCC_TEST_KUBERNETES_CODEX_IMAGE`, an
injected `CODEX_ACCESS_TOKEN` for the existing designated test account, and a
runtime image that supports `OPENCLAW_STATE_DIR` for OpenClaw state writes when
the test starts without a useful `HOME`. Set `OCC_TEST_OPENAI_MODEL` to a model
supported by that Codex path; the existing acceptance fixture uses `gpt-5.6-sol`.
The Calendar proof also needs `OCC_TEST_CODEX_CALENDAR_TOOL_NAME` and
`OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT`, and must show a model-chosen
`list_calendars(max_results:1)` read during a normal Agent turn.

The Codex failure proof uses
`--test-name-pattern 'curated Codex plugin failure'`. It selects a successful
native Codex plugin from the live catalog or `OCC_TEST_CODEX_SUCCESS_PLUGIN_ID`,
then selects a failure candidate from newline-delimited
`OCC_TEST_CODEX_FAILURE_PLUGIN_IDS` or the default GitHub, Linear, and Slack
candidate list. It proves the failed candidate reports `PLUGIN_AUTH_REQUIRED` or
`PLUGIN_INSTALL_FAILED`, remains nonserving, preserves the sibling Agent Pod and
workspace file, and exposes only the admitted plugin ID through deployment
status. It is the native proof layer; it does not replace the controlled receipt
boundary suite above.

The Calendar fixture uses a narrow test-only ServiceAccount import that preserves
the designated existing account token from a private service-account environment
file, binds it to the matching Provider, and then runs normal Agent
create/deploy/API checks. It does not prove native ChatGPT account creation,
upstream credential issuance, workspace administrator credentials, or creation of
a new upstream account. Never print credential values or resolved account
identifiers.

## Current proof notes

The target port is based on branch `dev/kevinlin/plugin-driver-port`; the initial
port commit was `185afba1608260adfa5b1fe9bda9ee700a4d9fee` in
[PR #121](https://github.com/openclaw/openclaw-enterprise/pull/121).

Current target-port evidence recorded for that port:

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
