# Agent plugin proof notes

These notes record what the [Agent plugin testing](plugins.md) suites have and
have not proven on real runtimes, and the historical evidence behind the plugin
port.

The nested policy contract and translation changes have not been verified in a
real Kubernetes Agent deployment. This includes default/tool overrides, Codex
`all_actions` and `write_actions` review, reviewer selection, and destructive
defaults with explicit tool exceptions. Contract/API/startup-fixture checks prove
their own boundaries;
older model-turn results below do not prove these new policies. In particular,
explicit `reviewer:"auto"` must reach native automatic review, which can deny;
omission must retain the effective Harness reviewer.

Native proof needs a runtime containing OpenClaw
[#151260](https://github.com/openclaw/openclaw/pull/151260) and
[#152085](https://github.com/openclaw/openclaw/pull/152085), support for
`plugins install --no-enable`, plus the cluster, database, image, and credentials in
[native runtime prerequisites](plugins.md#native-runtime-prerequisites). Verify effective native app/tool configuration, session approval and
permission profile, and a real normal Agent turn before claiming approval
enforcement. A session using `never` with permissive permissions can bypass MCP
review unless strict review applies; an app-level review default alone is not proof.
Startup now checks explicit app reviewers against effective app/link settings,
allowed reviewers, current approval policy, and managed current-model requirements.
That check does not establish future turn routing, session/model changes, or the
turn's strict-review flag. Startup fixtures check app/global fields, unselected
apps, nested tools, and account/link approval against the requested policy. They
reject an inherited `default_tools_enabled:true` that bypasses destructive
denial and include project overrides through `config/read.cwd`. Native defaults,
nulls, and omitted reviewer inheritance remain valid. Codex 0.156 readback omits
managed app/tool requirements applied during execution. Native effective-policy
introspection, later workspace/session changes, and live reviewer availability
remain acceptance gates. For `write_actions`, verify that a native read-only
action runs without added review while a non-read-only action requests review
through a normal Agent turn. Confirm a disabled plugin remains blocked despite
an enabled tool override, and a tool exception preserves native
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

## Historical port evidence

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
