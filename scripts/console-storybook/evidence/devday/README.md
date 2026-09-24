# DevDay demo verification

Captured from source commit `84032b03a076f773218d0a6e3339d06237a4b93d` on
September 23, 2026. Later evidence-only commits do not change the demonstrated UI.

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

## Visual evidence

[Watch the 29-second walkthrough](walkthrough.mp4). The video joins the Console
capture and the newly opened Admin UI window in chronological order.

| Capture                                             | Visible state                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Agents](00-agents.png)                             | The starting Console with deployed `oceclaw`.                                         |
| [Codex Preset](00-codex-preset.png)                 | Codex selected and `devday claw` entered.                                             |
| [Model credential](01-codex-configuration.png)      | Codex harness and masked fake API key.                                                |
| [Model](01-model.png)                               | Selected `gpt-6-astra`. Repository selection is shown in the video.                   |
| [Channels and Secrets](02-channels-and-secrets.png) | Fake OpenClaw channel IDs and pre-existing simulated Slack app/bot Secret selections. |
| [Deployment progress](03-deployment-progress.png)   | Waiting for deployment activation.                                                    |
| [Deployment success](04-deployment-succeeded.png)   | `devday claw`, admitted revision, and `succeeded` deployment.                         |
| [Admin UI launch](05-oceclaw-admin-launch.png)      | Deployed `oceclaw` and **Open native admin UI**.                                      |
| [Existing message](06-admin-existing-message.png)   | Seeded `#openclaw-feedback` conversation.                                             |
| [New reply](07-admin-reply.png)                     | Submitted message and visible simulated response.                                     |

## Checks and limits

- Storybook build, lint, formatting, workspace boundary, documentation build/link
  checks, and `git diff --check` passed.
- The complete manual browser walkthrough made 37 intercepted fixture requests,
  with no unhandled requests or browser errors.
- Both primary stories and both checkpoints reached their expected setup state.
  The generic native-admin boundary story remains separate.
- Reset story and the sandboxed Admin UI popup/Send action passed in the actual
  Storybook iframe. The MP4 opened in Chromium at 1440 × 1000, duration 28.8 seconds.
- Independent code review reported no P1/P2 findings.

This is simulated UI proof. The Console uses production modules; the Admin UI
is a schematic chat fixture rather than the bundled OpenClaw Control UI.
No real model credential, backend persistence, GitHub grant, workload deployment,
Slack delivery, native gateway, or model response was exercised. All displayed
Secrets and channel IDs are seeded fake values. No product runtime code changed,
so no backend or cluster integration tests were run for these demo fixtures.
