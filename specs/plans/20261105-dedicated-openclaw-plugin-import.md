---
rfc: ../rfcs/20261105-dedicated-openclaw-plugin-import.md
---

# Deliver imported plugins to dedicated OpenClaw Agents

- **ID** RFC-20261105-dedicated-openclaw-plugin-import
- **Delivery status** Partial
- **Source baseline** `516ee6d87`

## Implementation

1. Retain the bounded package reader for Agent Plugins and Claude archives. Add Agent-authorized preview through the selected Plugin Driver, let the owner select hosted HTTPS MCP servers, and treat direct URL entry as the same configuration path. Report unsupported package components without executing or retaining them.
2. Save each selected server as an Agent-owned plugin instance. Reuse the existing credential controls to bind an approved Source by ID and validate the endpoint against its Template. Avoid Namespace publishing or a separate credential attachment.
3. Discover authenticated MCP tools through the selected Driver, save the enabled upstream names and approval overrides, and admit the selected credential and network policy during Agent deployment. Reject an implementation that cannot enforce the requested restriction.
4. Deliver the inline MCP descriptor to the dedicated Harness and the enabled tools to OpenClaw's Gateway policy. Reconstruct the same descriptor from the immutable Agent revision on recovery.
5. Update Console stories, the operator guide, reference, and source-backed flow. Qualify the production Fastify/PostgreSQL path and the actual Console-to-worker flow.

## Dependencies and limits

The merged credential Source, Template, Token Service, Credential Proxy, and managed MCP paths supply the existing credential and enforcement primitives. This milestone owns integrating an Agent-configured endpoint with those paths. Reusable Namespace marketplace publication and imported skills are separate work; imported skill delivery depends on [OpenClaw #203881](https://github.com/openclaw/openclaw/pull/203881). Gateway code, local stdio, and package installers are not deployed.

## Verification

- Upload a supported archive in the Console, inspect its hosted server and unsupported components, save an Agent instance, bind a Source, discover tools, select a tool, deploy, and obtain a successful native result. Verify a script cannot invoke a disabled tool on the same credentialed route.
- Enter a URL directly, verify the same discovery and deployment path, and configure distinct instances without endpoint, credential, placeholder, or tool-name collisions. Restart from the saved revision without the archive and verify the same server is staged.
- Extend the production Fastify/PostgreSQL integration with a controlled MCP origin. Exercise authorization, Source and Template compatibility, discovery, Agent save, deployment admission, and denied tool policy through the real caller. Register the coverage in CI.
- Record the Console upload, selection, deployment, and actual tool result separately from fixture coverage. Record commit, runtime image, and launched binary version.

## Earlier qualification

The following record describes an earlier Namespace-release implementation and its recorded runtime. It is not qualification of the Agent-owned flow above.

Both dedicated Kubernetes cases passed on `cd62c0ed6`. The worker read and ran two skill releases, rejected a workspace conflict and recovered after its removal. The managed Gateway refused native install and upload. The hosted MCP case verified a successful native call, a proxy denial before provider access, account replacement and withdrawal. The [PR verification](https://github.com/openclaw/openclaw-enterprise/pull/4734) records the running image, source, Console walkthrough and results. The [plugin reference](../../docs/reference/agent-plugins.md) describes the supported workflow.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-05 04:37 UTC. Completed the dedicated Kubernetes verification on `cd62c0ed6`.

- 2026-11-05 01:55 UTC. Drafted against `516ee6d87` for Codex session `01a1a93c-472f-70c0-b038-f7f673ffdc1e`.
