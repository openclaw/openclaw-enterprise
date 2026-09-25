# Slack reply default verification

Source revision: `ec913c80` on September 25, 2026. Built with
`pnpm storybook:build` and inspected in headless Chromium on Linux at 1440 × 1000.

Stories under **Components/Channels**:

- **Slack threaded default** (`slackThreadedDefault`): configure a new Slack
  channel, select channel sender access, save, and open **Configuration → View
  native Configuration**. The saved document contains `replyToMode: "all"`.
  [Drawer](all-drawer.png) · [Saved default](all-saved.png).
- **Slack non-threaded override** (`slackReplyOverride`): edit and save an existing
  Slack configuration. Its explicit `replyToMode: "off"` remains unchanged.
  [Drawer](off-drawer.png) · [Saved override](off-saved.png).

[Watch both workflows](walkthrough.webm).

These are real console components with simulated API state and synthetic data.
The new-channel flow also shows missing Slack Secret bindings. This evidence
proves UI configuration construction and preservation, not backend persistence,
credential delivery, deployment, or live Slack messages. Separate focused browser
and API integration tests cover persistence; a Compute conformance check covers
native gateway document rendering. No live Slack messages were sent.
