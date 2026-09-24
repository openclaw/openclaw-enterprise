# DevDay demo verification

## Current Console refresh

Refreshed against main `5ebd7305b0876db33276a249934bc82073b63424`.
Source `ca25228f678140837f03cc6f005cdc7d20b266b7` preserves the production
Console from main, including Advanced settings and manual Secret binding edits.
The walkthrough exercises the same UI as this source; its final cleanup removes
an unused fixture option without changing the rendered states.

Environment: Linux, Node.js 24.20.0, pnpm 11.15.1, Storybook 10.6.0,
Playwright 1.63.0, headless Chromium 151.0.7922.34, 1440 × 1000 viewport.
The rebuilt static Storybook uses only a loopback server and fake fixture data.

- [Current model and repository controls](current/01-create.png)
- [Slack sender access and Secret selection](current/02-slack.png)
- [Simulated deployment success](current/03-deployed.png)
- [Admin UI message and simulated reply](current/04-admin-reply.png)
- [Connected Console walkthrough](current/console-walkthrough.webm)
- [Admin UI message recording](current/admin-message.webm)

Both starting stories and both checkpoints loaded without browser errors or
unhandled fixture requests. The connected walkthrough used the actual Storybook
iframe, created the Agent, returned to the same seeded list, opened the sandboxed
Admin UI popup, sent a message, and verified Reset story. These are simulated UI
checks, not deployed runtime qualification.

## Earlier capture environment

Captured from source commit `19c5184ed827e093dcf2b2cecde8753bc3f8d028` on
September 24, 2026, after reconciling main at `f23f7f4d`. Later evidence-only
commits originally changed evidence only. These captures are historical: the current Console has built-in model choices and retains Secret bindings under Advanced settings. They are not verification of the refreshed source.

Environment: macOS, Node.js 24.15.0, pnpm 11.15.1, Storybook 10.6.0,
Playwright 1.63.0 with headed Chromium, 1440 × 1000 viewport. Static Storybook
was rebuilt from this checkout and served only on loopback.

## Replay

Follow the [storyboard](../../devday-storyboard.md). With Storybook running,
open these story paths:

- `/?path=/story/flows--devday-create-flow`: **Flows / DevDay segment 1: create devday claw**.
- `/?path=/story/flows--devday-admin-flow`: **Flows / DevDay segment 2: oceclaw Admin UI**.
- `/?path=/story/flows--devday-create-checkpoint`: deployed creation checkpoint.
- `/?path=/story/flows--devday-admin-checkpoint`: Admin UI launch checkpoint.

The recording follows both segments in one fixture: create `devday claw`, wait
for deployment success, choose **← Agents**, open `oceclaw`, launch its Admin UI,
and send a new message. Checkpoint stories offer a resettable fallback.

## Historical visual evidence

[Watch the 29-second walkthrough](walkthrough.mp4). The video joins the Console
capture and the newly opened Admin UI window in chronological order.

| Capture                                             | Visible state                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Agents](00-agents.png)                             | The starting Console with deployed `oceclaw`.                                     |
| [Codex Preset](00-codex-preset.png)                 | Codex selected and `devday claw` entered.                                         |
| [Model credential](01-codex-configuration.png)      | Codex harness and masked fake API key.                                            |
| [Model](01-model.png)                               | Selected `gpt-6-astra`. Repository selection is shown in the video.               |
| [Channels and Secrets](02-channels-and-secrets.png) | Fake channel IDs, allowed user `UDEMO123`, and simulated Slack Secret selections. |
| [Deployment progress](03-deployment-progress.png)   | Waiting for deployment activation.                                                |
| [Deployment success](04-deployment-succeeded.png)   | `devday claw`, admitted revision, and `succeeded` deployment.                     |
| [Admin UI launch](05-oceclaw-admin-launch.png)      | Deployed `oceclaw` and **Open native admin UI**.                                  |
| [Existing message](06-admin-existing-message.png)   | Seeded `#openclaw-feedback` conversation.                                         |
| [New reply](07-admin-reply.png)                     | Submitted message and visible simulated response.                                 |

The historical [form capture](01-create-options.png) predates the current Advanced settings editor. The refresh preserves that editor and its manual-binding safeguards.

## Historical checks and limits

- Storybook build, lint, formatting, workspace boundary, documentation build/link
  checks, and `git diff --check` passed.
- The complete manual browser walkthrough made 37 intercepted fixture requests,
  with no unhandled requests or browser errors.
- Both primary stories and both checkpoints reached their expected setup state.
  The generic native-admin boundary story remains separate.
- Reset story and the sandboxed Admin UI popup/Send action passed in the actual
  Storybook iframe. The MP4 opened in Chromium at 1440 × 1000, duration 29 seconds.
- All 19 focused Console browser tests passed, with no failures or skips, covering
  Secret creation, regular/provisioning creation, Preset retries, standard Codex
  password Presets, provider/runtime controls, and Slack sender access.
- Independent source review reported no P1/P2 findings. PNG/MP4 evidence was
  excluded from automated source review and inspected through browser playback.

This is simulated UI proof. The Console uses production modules; the Admin UI
is a schematic chat fixture rather than the bundled OpenClaw Control UI.
No real model credential, backend persistence, GitHub grant, workload deployment,
Slack delivery, native gateway, or model response was exercised. All displayed
Secrets and channel IDs are seeded fake values. The refreshed branch changes Storybook fixtures and instructions only; production Console behavior follows main.
