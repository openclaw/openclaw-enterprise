# DevDay demo verification

## Plugin configuration in the DevDay create flow

Current source serves a Storybook-only curated plugin catalog in the DevDay
create flow. It includes the 26 curated plugin suggestions, including Linear,
Slack, GitHub, Figma, Notion, and Sentry, plus the existing simulated Calendar
entry. The checkpoint now adds Linear, sets automatic review by default, and
requires approval for Create issue. This remains simulated UI evidence, not live
plugin access, credential readiness, or runtime policy enforcement.

The current DevDay Storybook fixture keeps that catalog available regardless of
the create path: Start without Preset, every DevDay Preset, both standard
Presets, new model Secret entry, and existing model Secret selection. The
checkpoint exercises the same Linear policy steps and reaches the Workspace tab.

Verified source `a27ec9ad9d032cba731b4703621a1dd44008f867`, rebased onto
`fbbc0e42`, in headed Chromium on macOS on September 24, 2026. The manual
segment 1 walkthrough selects SWE Agent with a fake newly entered service-account
token, loads the plugin catalog, adds Calendar, sets automatic review by default,
and requires approval for Create event. It then selects both repositories,
configures Slack, creates the simulated Agent, and opens the Admin UI.
Those media files are historical evidence for the earlier Calendar-based
walkthrough; the current checkpoint exercises Linear automatically.

- [Plugin catalog](plugins/01-plugin-catalog.png),
  [tool policy](plugins/02-tool-policy.png), and
  [configured selection](plugins/03-configured-plugin.png).
- [Connected walkthrough](plugins/console-walkthrough.webm): 13 seconds,
  1440 × 1000; 40 intercepted requests, no unhandled requests or browser errors.
- [Admin recording](plugins/admin-message.webm): 1.88 seconds; both recordings
  were opened and decoded in Chromium.
- Real-controller browser checks: 7 passed, zero skipped, covering plugin discovery,
  policy persistence, and preset credential selection/retry behavior.
- Preset conformance/controller integration: 16 passed, zero skipped.
  Typecheck, full lint, formatting, workspace boundaries, documentation checks
  (196 pages, 3325 links), and the isolated Storybook build passed.

Stories: **Flows / DevDay segment 1: create devday claw** and its deployed checkpoint.
This is simulated UI evidence, not live plugin access, credential readiness,
policy enforcement, deployment, model execution, or Slack delivery. Preset files
were unchanged. The rehearsal build on port 6011 was preserved; verification used
an isolated build on port 6012.

## All DevDay preset choices

Verified source `67c2d332af138b84e4295c11686da63c3162334f` in headed Chromium on September 24, 2026.
Segment 1 includes SWE Agent, Q&A Agent, and Oncall Agent alongside both standard
presets. Each custom preset was selected and applied using the real Console UI;
all retained `gpt-6-astra`, Codex service-account authentication, and the rendered
Agent name in `AGENTS.md`. No browser errors or unhandled fixture requests occurred.
The Installation example still comments out custom presets; Storybook includes
all three for rehearsal.
Current source also includes Community Agent. SWE Agent, Q&A Agent, and Oncall
Agent prefill `oce-feedback`, `oce-team`, `oce-feedback-test`, `oce-team-test`,
`oce-community`, and `oce-community-test`; Community Agent preconfigures
`oce-team`, `oce-team-test`, `oce-community`, and `oce-community-test`.
The older captures below predate those channel defaults.

- [SWE Agent](presets/11-swe-choice.png)
- [Q&A Agent](presets/12-qa-choice.png)
- [Oncall Agent](presets/13-oncall-choice.png)
- [All three selections and rendered drafts](presets/all-devday-presets.webm)

## Connected preset flow

Captured on September 24, 2026; connected walkthrough refreshed for source commit `df3dfc0a9637848f68869e2139617113e4b977aa`.
Existing-Secret and catalog-state captures retain matching UI from `3515dc6c`.
Rebased onto main `4373b6e3`, including its updated Console styles.
The Console uses the shipped `SWE Agent` JSON preset with editable model default
`gpt-6-astra`, Codex service-account authentication, existing/new model Secret
selection, prefilled Slack channel
`C0C43A2QA11`, and workspace-file overrides. The raw Secret bindings JSON editor
has been removed. DevDay preserves the supplied Ocalot instructions, including the draft-decision
section, with `You are {{vars.name}}` in the opening sentence. The walkthrough
checks the rendered `You are devday claw` sentence and exact remaining content
in the workspace editor before creation.

Environment: macOS, Node.js 24.15.0, pnpm 11.15.1, Storybook 10.6.0,
Playwright 1.63.0 with headed Chromium, 1440 × 1000 viewport. The static
Storybook was rebuilt from this source and served only on loopback.

- [SWE Agent preset and masked variables](presets/01-devday-preset.png)
- [Supplied Ocalot instructions](presets/07-ocalot-instructions.png)
- [Model and repository controls](presets/02-create.png)
- [Prefilled Slack channel and Secret selection](presets/03-prefilled-slack.png)
- [Simulated deployment success](presets/04-deployed.png)
- [Admin UI message and simulated reply](presets/05-admin-reply.png)
- [Rendered workspace overrides, including an empty file](presets/06-workspace-overrides.png)
- [Standard OpenClaw preset with native harness](presets/08-standard-openclaw.png)
- [Existing model Secret selection](presets/09-existing-model-secret.png)
- [Existing service account draft](presets/10-existing-secret-draft.png)
- [Secret metadata loading](presets/createPresetSecretsLoading.png)
- [Secret metadata denied](presets/createPresetSecretsDenied.png)
- [Empty Secret catalog](presets/createPresetSecretsEmpty.png)
- [Existing Secret and recovery recording](presets/existing-secret-walkthrough.webm)
- [Connected Console recording](presets/console-walkthrough.webm)
- [Admin UI message recording](presets/admin-message.webm)

This earlier connected recording selected SWE Agent with both standard presets
available. The newer recording above verifies all three custom presets. Custom
presets, including Community Agent, remain disabled in the Installation example.

The connected walkthrough selected SWE Agent, supplied fake credentials, verified
the channel prefill, selected both `openclaw/openclaw-enterprise` and
`openclaw/openclaw` with Contributor access and simulated Slack Secrets,
completed creation, returned to the same Agent list, opened `oceclaw`'s sandboxed
Admin UI popup, and sent a message. It made 37 intercepted fixture requests with
no unhandled requests or browser errors. The preset permits mentions by channel
members; the recording demonstrates narrowing this to fake sender `UDEMO123`.

The existing-Secret walkthrough completed creation with 23 intercepted requests
and zero Secret writes. Loading, denied, and empty catalogs kept existing mode
visible; explicitly switching to new mode opened a masked-token draft.

Both starting stories, both checkpoints, the workspace override story, and the
standard OpenClaw story reached their intended states. The latter verifies that
the native OpenClaw harness is selected. Reset story and Admin UI popup/Send passed in
the actual Storybook iframe. The Console recording played in Chromium at
1440 × 1000. The workspace example verifies a variable-expanded `IDENTITY.md`
and an explicitly empty `USER.md` while leaving omitted defaults intact.

This is simulated UI proof. Production Console modules run against fixtures;
the Admin UI is a schematic chat fixture. No real credentials, backend
persistence, GitHub grant, workload deployment, Slack delivery, native gateway,
or model response was exercised. The requested channel ID is real input;
credentials, sender identity, messages, and responses are demo values.

## Replay

Follow the [storyboard](../../devday-storyboard.md). With Storybook running,
open these story paths:

- `/?path=/story/flows--devday-create-flow`: start Agent creation.
- `/?path=/story/flows--devday-admin-flow`: start Admin UI messaging.
- `/?path=/story/flows--devday-create-checkpoint`: deployed creation checkpoint.
- `/?path=/story/flows--devday-admin-checkpoint`: Admin UI launch checkpoint.
- `/?path=/story/pages-create-agent--create-preset-workspace-files`: workspace override example.
- `/?path=/story/pages-create-agent--create-standard-openclaw-preset`: native OpenClaw preset.
- `/?path=/story/pages-create-agent--create-preset-existing-secret`: existing Codex service account Secret.
- `/?path=/story/pages-create-agent--create-preset-secrets-loading`: pending Secret metadata.
- `/?path=/story/pages-create-agent--create-preset-secrets-denied`: denied metadata read.
- `/?path=/story/pages-create-agent--create-preset-secrets-empty`: empty Secret catalog.

## Historical evidence

Files under `current/` were captured for source
`ca25228f678140837f03cc6f005cdc7d20b266b7` on Linux. Despite the directory name,
they predate the preset changes and removal of the Secret bindings JSON editor.
They do not verify the current implementation.

The root-level [earlier walkthrough](walkthrough.mp4) and PNGs were captured
from source `19c5184ed827e093dcf2b2cecde8753bc3f8d028` on macOS. They also remain
historical. Use the `presets/` captures above for the current UI.
