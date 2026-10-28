# OCE managed plugin packages

The [OCE marketplace index](./marketplace.json) lists packages by name and relative directory.
Each package has a [plugin.json](./oce-google-workspace/plugin.json) at its root. The
`ai.openclaw.oce` extension points to the release that OCE deploys.

```text
plugins/
├── marketplace.json
└── oce-google-workspace/
    ├── plugin.json
    ├── skills/oce-google/SKILL.md
    └── ai.openclaw.oce/release.json
```

The [release](./oce-google-workspace/ai.openclaw.oce/release.json) declares a Gateway
skill and a dedicated OpenClaw worker CLI. It pins the ClawHub skill and the Linux
CLI artifacts independently. The bundled Plugin Driver registers this version as
`occ-plugin:google@1.0.0`. Publish changed release bytes under a new package version
so existing Agent selections continue to identify the reviewed release.

The package’s OCE extension declares `policyScope: "enablement_only"`. The Plugin Driver advertises this scope for the versioned plugin ID so the Console can render the same enable switch as a Codex plugin before catalog discovery completes. OCC refuses tool approvals, reviewers, and per-tool overrides for the CLI.

The optional `account` slot refers to a credential attached to the Agent.
OpenShell supplies the worker with a placeholder. The request guard checks the
[pinned operation map](./oce-google-workspace/ai.openclaw.oce/operations.json) and the source’s host, path and scope limits before
OpenShell substitutes the bearer. The Agent can also attach credentials for use
outside the plugin. The [operator guide](../../../docs/guides/credential-proxy.md#enable-google-workspace-requests-from-a-dedicated-worker)
describes registration and verification. See the [operation map generator](../../../scripts/google-operation-map/README.md) for coverage and regeneration.

The package follows the Agent Plugins JSON schema and keeps skills beside the manifest.
For the packaging conventions, see the [OpenAI plugin structure](https://developers.openai.com/plugins/build/plugins#plugin-structure)
and [Anthropic plugin layout](https://code.claude.com/docs/en/plugins-reference#standard-layout).
