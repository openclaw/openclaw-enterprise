# Namespace plugin releases

A Namespace or Installation administrator with `namespace:publish_plugins` can inspect and publish a package in that Namespace. OCC retains the reviewed content under an immutable digest. An Agent owner needs `namespace:read` to select a published release. See [Import a plugin](../guides/topics/plugins-configure.md#import-a-plugin-for-a-dedicated-openclaw-agent).

## Package contents

The importer accepts an Agent Plugins package, a Claude plugin directory, or one named marketplace entry whose source is present in the archive. It previews skill files, fixed HTTPS Streamable HTTP MCP servers, and excluded declarations. Hooks, commands, provider-specific agents, and local MCP launch commands are excluded. Import never runs package code. Unsafe archive paths and package size limits apply to the entire upload. Publication requires at least one supported declaration.

A published release retains `SKILL.md`, supporting files, and executable modes. The release also retains the exact manifest name and endpoint of each supported hosted MCP server. An Agent draft selects the release by digest. Repacked archives with the same release digest cannot replace the original published archive. When Namespace deletion reaches its terminal transaction after every Agent is gone, OCC removes retained release archives before marking the Namespace deleted.

## Runtime dependencies

Deployment admission refuses an enabled imported release before creating a revision. Dedicated imported skill delivery requires Gateway support that preserves the reviewed skill source against workspace precedence and rejects native skill installation in managed mode. The pinned Gateway does not yet provide those controls.

A hosted server descriptor can be inspected and selected, but credentialed discovery and execution require the canonical Source and Connection Template association, Token Service acquisition, and Credential Proxy dispatch and withdrawal. Saved OAuth accounts also require the Agent grant workflow. These integrations remain pending. Publication alone does not create credentials or authorize an Agent to use them.

Each API replica permits 20 preview or publication requests in a burst. The shared budget replenishes one request every three seconds. On HTTP 429, wait for `Retry-After`.
