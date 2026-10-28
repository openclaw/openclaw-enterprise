# OCE managed plugin packages

The [OCE marketplace index](./marketplace.json) lists packages by name and relative directory.
Each package has a [plugin.json](./oce-google-workspace/plugin.json) at its root. The
`ai.openclaw.oce` extension points to the release that OCE deploys.

- [Google Workspace](./oce-google-workspace/ai.openclaw.oce/release.json) pins the ClawHub skill and Linux `gog` binaries.
- [Slack Search](./oce-slack-search/ai.openclaw.oce/release.json) pins the OCE worker command and its Gateway skill. Its account slot declares the public-channel message search request. Slack documents the user scope and app eligibility in its [Real-time Search API guide](https://docs.slack.dev/apis/web-api/real-time-search-api/).

The Plugin Driver registers each package by version. Publish changed release bytes under a new version so existing Agent selections continue to identify the reviewed release.

The package’s OCE extension declares `policyScope: "enablement_only"`. The Plugin Driver advertises this scope for the versioned plugin ID so the Console can render the same enable switch as a Codex plugin before catalog discovery completes. OCC refuses tool approvals, reviewers, and per-tool overrides for the CLI.

Each release declares the `account` credential slot for a future binding. It names
the worker environment variable and lists the HTTPS requests that may use the
account. Google’s public discovery request takes no credential. The installer reads the
package without binding this slot. A binding implementation must give the Harness
an opaque placeholder and check its request against the release before substituting
a bearer at egress. An absent binding grants no credentialed route.

The package follows the Agent Plugins JSON schema and keeps skills beside the manifest.
For the packaging conventions, see the [OpenAI plugin structure](https://developers.openai.com/plugins/build/plugins#plugin-structure)
and [Anthropic plugin layout](https://code.claude.com/docs/en/plugins-reference#standard-layout).
