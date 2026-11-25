---
status: Proposed
implementation_status: Partially implemented
author: stevenlee-oai
---

# Configure custom MCP plugins on dedicated OpenClaw Agents

- **ID** RFC-20261105-dedicated-openclaw-plugin-import
- **Implementation plan** [Deliver custom plugins](../plans/20261105-dedicated-openclaw-plugin-import.md)

## Decision

An Agent owner adds a custom hosted Model Context Protocol (MCP) server in **Agent → Plugins**, either by entering its HTTPS URL or by loading a plugin package and choosing a server from its manifest. The owner selects or creates an approved Connection Template and Credential Source, discovers tools, selects the permitted tools and approval policies, then deploys the Agent. The custom MCP instance belongs to that Agent's draft and revisions. A reusable Namespace plugin marketplace is separate work.

The [OpenClaw Plugin Driver](../../docs/reference/drivers/plugin.md) owns package inspection, the custom instance's catalog entry, connection compatibility, tool filtering, policy validation, and deployment description. OpenClaw Control Plane (OCC) owns Agent authorization, configuration persistence, Source admission, and revision creation. The existing credential and MCP transport implementations remain independent of the plugin catalog.

## Load a package or enter a URL

Retain the existing Agent Plugins 1.0 and Claude package reader. It inspects a tar or tar.gz archive, its root manifest, and MCP declarations such as `mcp.json` or `.mcp.json`. When the archive contains a marketplace, the user can choose one locally resolved package entry. Inspection does not execute package code or retain the archive. Before accepting or parsing the body, OCC authorizes Namespace-scoped `agent:create` for a new Agent, or read and update access on the exact saved Agent. The selected Driver inspects the bounded archive and returns a preview of supported servers and omitted components. Neither path requires Namespace publication permission. Enforce archive, expansion, entry, file, and path-safety limits before extracting or accepting content.

Preview each declared server's name, fixed HTTPS Streamable HTTP endpoint, and credential requirement. If a manifest has several servers, the owner may choose servers individually; each selected server becomes a distinct Agent-owned MCP instance. Preview also identifies skills, local stdio servers, hooks, installers, Gateway-native code, and other components that this milestone cannot deploy. A package containing unsupported components can still provide a supported hosted MCP server when that server is selected explicitly. Imported skill deployment remains dependent on [OpenClaw #203881](https://github.com/openclaw/openclaw/pull/203881).

Entering an MCP URL directly creates the same Agent-owned instance as selecting that URL from a manifest. Neither input grants network or credential authority. OCE does not retain or run arbitrary uploaded package code in this MCP milestone.

## Agent configuration and credential ownership

Store each instance under a stable Agent-local plugin ID in the existing `Agent.plugins` selection map. Its Driver-owned configuration carries a display name, the resolved canonical MCP endpoint, the canonical Source ID, and selected upstream tool names. The selected upstream names are the enabled set; existing per-tool overrides carry human-approval settings. Agent update permission governs edits; Source attachment requires the exact Source operate permission. Deployment requires Agent deploy permission. Removing the instance takes effect on redeployment and does not revoke or delete its Source.

Connection Templates and Sources remain authorized Namespace resources. For an OAuth MCP Source, use the Template's server URL and protected resource, and retain the original consent issuer/resource checks. For a static Bearer Source, require the configured URL to fit the qualified Template's approved destinations and methods. Token Service owns token custody and renewal; the selected Credential Proxy and Sandbox own credential delivery and enforcement. An uploaded placeholder name cannot overwrite another instance's credential projection.

## Driver contract and deployment

Add `inspectPackage?(archive: Uint8Array, marketplaceEntry?: string): Promise<InspectedPluginPackage>` as an optional Plugin Driver capability; OCC hides or rejects package inspection when the selected Driver does not support it. OCC exposes only its bounded control-plane preview and does not return or store package code. Pass the saved or authorized draft `PluginDesiredSelection` to `getCatalogPlugin` and `credentials.mcpToolDiscovery` so the selected Driver can describe the instance and return its qualified endpoint. Supply Agent selections to `credentials.choices` when constructing instance-specific slots, without replacing its approved Template map. If Agent catalog listing includes these instances, supply that same selection context to `discoverCatalog`; pre-Agent global catalog discovery remains unchanged. Existing `selectedBindings`, policy validation, credential validation, placement validation, and `describeDeployment` already receive selections and must apply their ordinary checks to custom instances. No token values enter this Driver context.

For discovery, OCC qualifies the Source and current approved Template, asks the selected Driver for the endpoint, calls the generic authenticated `tools/list` transport, and passes raw upstream names back to the Driver. Use upstream names as policy keys; reject names or instance collisions the runtime cannot represent. At save and admission, the Driver validates the configured endpoint against the qualified Template; for OAuth it resolves the Template’s canonical server URL. Admission freezes that resolved endpoint, the selected upstream names, and the credential policy in the Agent revision. Recovery does not resolve a new endpoint from mutable Template state. The Driver describes an existing `hosted-mcp` installation with `configuration.kind: inline`. On launch and recovery, the OpenClaw Plugin Driver reconstructs this descriptor solely from the immutable selection saved in the Agent revision; Kubernetes Compute uses that same Driver-owned projection rather than interpreting `driverPolicy` or reading an archive. Compute stages the descriptor on the dedicated Harness and adds the selected tools to the Gateway allowlist. The selected Credential Proxy and Sandbox enforce MCP tool selection before credential injection where supported. Native human approvals remain a Gateway policy; direct scripts can bypass approval for an enabled tool.

A missing or unauthorized Source, incompatible Template, disallowed endpoint, unsupported transport, undeployable tool name, or incapable enforcement implementation prevents deployment. Recovery uses the configuration saved in the Agent revision and does not require the original archive or publisher.

## Verification

Through the Console, upload a package, preview and select a hosted MCP server, bind an approved Source, discover and select tools, save and deploy a disposable Agent, obtain a successful native tool result, and verify that a direct script cannot invoke a disabled tool. Exercise the direct-URL path and distinct instances separately. Test the production Fastify/PostgreSQL caller through discovery, selection, admission, and deployment policy; record the actual Console interaction and live tool result.
