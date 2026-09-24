# DevDay demo verification

## Current preset flow

Captured on September 24, 2026 from source commit `31da33ee2fafbf273556950b1ead2d69be07e53e`.
The Console uses the shipped `devday` JSON preset, prefilled Slack channel
`C0C43A2QA11`, and workspace-file overrides. The raw Secret bindings JSON editor
has been removed. DevDay's custom `AGENTS.md` is pending user-supplied content.

Environment: macOS, Node.js 24.15.0, pnpm 11.15.1, Storybook 10.6.0,
Playwright 1.63.0 with headed Chromium, 1440 × 1000 viewport. The static
Storybook was rebuilt from this source and served only on loopback.

- [DevDay preset and masked variables](presets/01-devday-preset.png)
- [Model and repository controls](presets/02-create.png)
- [Prefilled Slack channel and Secret selection](presets/03-prefilled-slack.png)
- [Simulated deployment success](presets/04-deployed.png)
- [Admin UI message and simulated reply](presets/05-admin-reply.png)
- [Rendered workspace overrides, including an empty file](presets/06-workspace-overrides.png)
- [Connected Console recording](presets/console-walkthrough.webm)
- [Admin UI message recording](presets/admin-message.webm)

The connected walkthrough selected DevDay, supplied fake credentials, verified
the channel prefill, selected repository access and simulated Slack Secrets,
completed creation, returned to the same Agent list, opened `oceclaw`'s sandboxed
Admin UI popup, and sent a message. It made 36 intercepted fixture requests with
no unhandled requests or browser errors. The preset permits mentions by channel
members; the recording demonstrates narrowing this to fake sender `UDEMO123`.

Both starting stories, both checkpoints, and the workspace override story
reached their intended states. Reset story and Admin UI popup/Send passed in
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

## Historical evidence

Files under `current/` were captured for source
`ca25228f678140837f03cc6f005cdc7d20b266b7` on Linux. Despite the directory name,
they predate the preset changes and removal of the Secret bindings JSON editor.
They do not verify the current implementation.

The root-level [earlier walkthrough](walkthrough.mp4) and PNGs were captured
from source `19c5184ed827e093dcf2b2cecde8753bc3f8d028` on macOS. They also remain
historical. Use the `presets/` captures above for the current UI.
