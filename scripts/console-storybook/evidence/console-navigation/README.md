# Console draft navigation evidence

Tested Console source: `0a5e27d68655ca96c8e5fc5a533110f925a2e71f`.
Environment: Linux, Node.js 26.5.0, Playwright 1.63.0, Chromium 153,
1280 × 900 viewport. Storybook was rebuilt from this source.

[Watch the 11-second walkthrough](walkthrough.mp4). It switches tabs and pages,
returns with Back/Forward, and exercises explicit Cancel, Save, and Reload.

| Story                                                                                                        | Screenshot                                        | Demonstrated result                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Pages / Agent detail / Keep Configuration edits (`pages-agent-detail--configuration-navigation`)             | [Configuration](configuration-restored.png)       | Unfinished JSON returns; deployment remains blocked.                                                            |
| Components / Workspace / Keep unsaved files (`components-workspace--workspace-navigation`)                   | [Workspace](workspace-restored.png)               | Text and an empty USER.md survive navigation; Save and Reload remain explicit.                                  |
| Components / Credentials / Keep authentication choices (`components-credentials--authentication-navigation`) | [Authentication](authentication-restored.png)     | Method and an existing Secret ID return; Reload discards the choice. The mask hides a metadata ID, not a token. |
| Components / Channels / Keep Slack edits (`components-channels--slack-navigation`)                           | [Slack](slack-restored.png)                       | Back/Forward reopens the drawer with edited channel IDs; Cancel discards them.                                  |
| Pages / Create Agent / Keep Preset variables (`pages-create-agent--preset-variable-navigation`)              | [Preset variables](preset-variables-restored.png) | Name and model return; the new-token input is empty.                                                            |

The [applied Preset walkthrough](../preset-navigation/README.md) covers the Create
Agent form, workspace inputs, and confirmed Start over at the same source revision.

These are simulated Storybook UI fixtures with synthetic data. They do not prove
backend persistence, Secret propagation, deployment, model execution, or a live
gateway. Separate browser regressions use the real Console, Fastify routes, and
IAM with in-memory platform storage; workspace transport uses Agent-scoped local
files. They check isolation, stale save baselines, explicit discard, and write
outcome recovery. Existing permission-denied, missing-file, and uncertain-write
Storybook previews were also checked in Chromium.

Story: **Pages / Create Agent / Keep repository choices through an outage**
(`pages-create-agent--repository-navigation-outage`).
The [6-second recovery walkthrough](repository-outage.mp4) selects a repository
and Contributor access, navigates away and back, then retries failed discovery.
[During the outage](repository-outage.png), the form reports retained selections
and blocks creation. [After retry](repository-recovered.png), the same repository
and access level return. The browser regression additionally navigates twice
through both 503 and 500 failures, then creates an Agent with its original bindings.
