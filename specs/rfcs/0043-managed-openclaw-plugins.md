---
status: Proposed
implementation_status: Partially implemented
author: stevenlee-oai
---

# RFC-0043: Managed OpenClaw plugins

- **Created:** 2026-10-21
- **Last updated:** 2026-11-18
- **RFC PR:** [#3142](https://github.com/openclaw/openclaw-enterprise/pull/3142)
- **Implementation plan:** [Managed OpenClaw plugins](../plans/0043-managed-openclaw-plugins.md)

## Decision

OpenClaw Enterprise (OCE) lets an administrator select reviewed plugins, connect accounts through the existing credential system, and choose which tools an Agent can use before deployment. The Plugin Driver describes the plugin and its requested permissions. OpenClaw Control Plane (OCC) admits the selection only when the selected credential and execution stack can enforce its request policy. The Credential Proxy authorizes credentialed requests, and the Sandbox prevents the Harness from bypassing that path. A separate Gateway policy can require human approval for native MCP invocations; that approval does not constrain scripts that use the same credential.

## Plugins and deployment

A plugin is a reviewed, versioned catalog entry with one or more components:

- **Skill:** Instructions and resources that OpenClaw makes available to the model. The Gateway prepares the selected skill context for delegated turns.
- **CLI:** An executable or script that runs on the dedicated Harness worker. Google Workspace uses [gog](https://github.com/openclaw/gogcli), the OpenClaw project's CLI for Gmail, Calendar, Drive, and other Google services. Compute delivers and verifies the reviewed artifact or selects a compatible runtime image.
- **Hosted MCP:** A remote Model Context Protocol server. The OpenClaw node host on the Harness worker runs the MCP client. It advertises selected tool descriptors to the Gateway, which applies its tool policy for the turn. The remote server executes the tool.

The Plugin Driver supplies catalog entries, checks compatible Harness placement, and validates requested plugin policy. OCC records the selected release, owning Driver, account bindings, and policy in the Agent revision. Compute coordinates deployment, and OpenClaw activates the selected skill or worker component. Selecting an entry does not run arbitrary package installation code in the Gateway.

Reviewed uploads admit skills and hosted MCP descriptors. CLI executables come from an operator-pinned runtime artifact or image. A future import from a registry such as ClawHub must use the same admission boundary: OCC pins the admitted artifact and its dependencies, and publisher updates require a new admission and deployment. Channels, providers, hooks, and other Gateway integrations remain platform-managed. Codex has its own Plugin Driver and approval behavior; see [multiple Plugin Drivers](0029-multiple-plugin-drivers.md) and [plugin policy enforcement](0014-plugin-policy-enforcement.md).

For Codex, OCC discovers plugins through the authenticated hosted catalog so the list reflects the selected account. The Codex Plugin Driver needs no catalog configuration: remove the bundled `openai-curated` static catalog and the unused controller-side Codex reader and its settings. Keep `discoverCatalog` and `getCatalogPlugin` for discovery. Codex continues to install plugins from its native `openai-curated-remote` marketplace on the Harness.

## Credentials and account bindings

OAuth setup belongs to OCC's credential system, independently of any Plugin Driver. An administrator configures a connection template and an OAuth client registration in **Credentials**. The template defines its issuer, scope limits, and credential destinations; an MCP template can be created from the server URL and its authorization metadata. OCC stores confidential client material through the Secret Driver. A user completes the same OCC consent flow whether they start from Credentials or a plugin's account picker. Token Service owns the saved grant, access-token resolution, and renewal. See [OAuth connections](0027-agent-oauth-connections/index.md) and [Credential Proxy and credential lifecycle](0023-egress-proxy-credential-lifecycle/index.md).

A plugin that needs credentials declares a named account requirement. An Agent binds each selected plugin instance and account slot to an authorized saved connection. The binding identifies the account and intended endpoint; the endpoint need not be fixed in the plugin release when the template admits different service instances. Multiple accounts or instances retain separate identities and grants, even when they use the same server URL. Native invocations select an account-qualified MCP server, and admitted scripts select a binding-specific placeholder or equivalent protected route. The trusted egress path must resolve that selector to the exact binding before authorization; it rejects an ambiguous request. OCC checks the caller's authority, the Agent grant, issuer, protected resource, and destination before accepting the binding. Actual granted scopes bound credential use; the selected enforcer checks them when a connector policy requires particular operation scopes. The Plugin Driver receives credential metadata, not client secrets or tokens.

Authenticated MCP discovery resolves a usable token through the credential lifecycle and returns candidate upstream tool names. Discovery does not itself authorize those tools. Removing a plugin selection removes that selection on redeployment; independently attached credentials and Agent grants require explicit removal. Disconnecting a saved account ends that account's lifecycle for its consumers. Custom OAuth scopes require a corresponding approved endpoint allowlist and an enforceable request policy; adding a scope cannot extend the destination envelope by itself.

## Policy capabilities and admission

The Plugin Driver declares policy requirements in implementation-neutral terms for each account binding: the approved destination and requested operations, such as upstream MCP tool names or connector-defined API actions. Its policy capabilities describe the settings the plugin understands. The Credential Proxy Driver advertises the operation policies that its implementation can enforce and validates the requested policy. For MCP, that capability means inspecting `tools/call` and matching the upstream tool name; support for MCP transport alone is insufficient. The Sandbox must separately prevent bypass. The Plugin Driver does not need the Credential Proxy implementation name or its configuration format.

The Plugin Driver describes static request matches for the selected account and tool names. Compute uses those matches to prepare network access and a separate `CredentialInjectionPolicy.allowedRequests` for each binding. An MCP match identifies the endpoint path, JSON-RPC method, and, for `tools/call`, the upstream `toolName`. The selected Credential Proxy checks that binding’s allowed requests before injection; the Sandbox applies network access and prevents direct bypass. These contracts are defined in [#6396](https://github.com/openclaw/openclaw-enterprise/pull/6396); plugin deployment descriptions are proposed in [#6399](https://github.com/openclaw/openclaw-enterprise/pull/6399).

OCC checks compatibility when an administrator saves the credential binding and again when it admits a deployment. The admitted policy can narrow the connection template and credential grant, but cannot expand either. OCC does not offer an enforcement setting that the selected stack cannot implement. OpenClaw can still filter the tools visible to the model, but that filter is not an execution-wide credential restriction. If a saved policy cannot be enforced at deployment, OCC rejects the candidate before releasing it to serve. The execution stack must verify that the admitted enforcement is installed; failure or an unavailable authorizer denies credentialed traffic.

For hosted MCP, the concrete Credential Proxy inspects the actual JSON-RPC request before credential injection. It authorizes required protocol traffic separately from `tools/call`, and permits a call only when `params.name` is in the selected set for that account binding and endpoint. Model-facing aliases and untrusted server annotations are not authorization keys. The worker's `toolFilter` and the Gateway's tool allowlist expose the same selection to the model, but they do not replace request authorization: a script can construct an MCP request without going through native tool dispatch. The Sandbox routes both callers through the same protected egress path and prevents direct bypass.

For selected MCP tools, the Plugin Driver accepts the existing `tools[id].approval` setting. An omitted setting or `none` adds no approval; `all_actions` requires human approval for every native invocation of that tool. Tool IDs must resolve to the selected plugin instance, account-qualified server, and upstream tool name. A disabled tool remains disabled through the existing tool selection and credential policy. The Driver must report approval support per plugin so enabling MCP approval does not advertise it for unsupported plugins such as Diffs.

OpenClaw provides the Gateway approval infrastructure. Compute installs one trusted OCE Gateway extension that registers a node-command policy for `mcp.tools.call.v1`, separate from the selected catalog plugins. OpenClaw admits an enabled tool without an approval requirement for same-node Harness execution when other policy permits it. It routes an approval-required tool through the Gateway policy, which identifies the server and tool to an Agent-wide approver and invokes the MCP client on the Harness only after an allow-once decision. The pilot approves the tool invocation without displaying its arguments; full argument review is later work. Denied or expired approval, changed arguments, and stale turn authority must block the native call. OCC freezes the selected approval settings in the Agent revision; Compute renders its Gateway policy and tool placement for that revision on deployment.

OpenClaw can continue startup after an extension load or registration error. The pilot validates the packaged extension and configuration but cannot guarantee approval if its policy fails to register. An OpenClaw fast follow must reject native MCP execution when its required policy is absent, so a packaging or startup defect cannot silently allow an Ask tool.

This approval covers native Gateway dispatch only. A script can call the same enabled upstream tool through its credential placeholder without that approval: [#4450](https://github.com/openclaw/openclaw-enterprise/pull/4450) demonstrated a direct Node script invoking an enabled Slack tool. Enforcing human approval on direct credentialed requests is later work; disabled-tool request denial still applies to scripts.

For a CLI or custom script calling an API, the connector supplies the reviewed operation definitions. The shared static HTTP policy matches the method and path; it does not inspect query fields, request bodies, or granted scopes. A Google operation that requires those checks needs an enforcement capability specific to that connector. OCC must not present that stronger restriction as enforced when the selected implementation cannot apply it. If an account is bound more narrowly than its saved grant, authorization must enforce the narrower binding. A broader independent route to the same credential must not defeat a restriction presented as enforceable. When the execution stack cannot distinguish overlapping bindings, OCC rejects that configuration.

The proposed flow uses the selected Credential Proxy and Sandbox; it does not add another plugin-specific request filter, listener, or service. Dashed arrows show the proposed neutral policy handoff and request authorization.

```mermaid
---
config:
  theme: base
  htmlLabels: true
  themeVariables:
    fontSize: 14px
    lineColor: "#8B949E"
    edgeLabelBackground: "#FFFFFF"
  flowchart:
    curve: linear
    nodeSpacing: 24
    rankSpacing: 30
    padding: 12
    subGraphTitleMargin:
      top: 10
      bottom: 14
---
flowchart TB
  Driver["<b>Plugin Driver</b><br/>Catalog and policy"] -->|selection| OCC
  Driver -.->|neutral policy intent| OCC
  Account["<b>Connection</b><br/>Account and approved endpoint"] -.->|binding| OCC
  OCC["<b>OCC</b><br/>Check support and admit"] --> Revision["<b>Agent revision</b><br/>Release, binding, tools"]
  Revision --> Compute["<b>Compute Driver</b><br/>Prepare deployment"]
  Compute --> Gateway["<b>OpenClaw Gateway</b><br/>Skill and tool allowlist"]
  Compute --> Worker
  Compute -.->|per-binding injection policy| Proxy
  subgraph Sandbox["Harness Sandbox"]
    Worker["<b>Harness worker</b><br/>CLI, MCP client, scripts"] --> Egress["<b>Protected egress</b><br/>No direct bypass"]
  end
  Worker -->|tool descriptors| Gateway
  Egress -.->|actual request| Proxy["<b>Credential Proxy</b><br/>Authorize and inject"]
  Proxy -.->|approved request| External["<b>External endpoint</b><br/>API or MCP server"]
  classDef input fill:#F1EEF5,stroke:#A091AD,color:#3A3243,stroke-width:1px
  classDef state fill:#EDF2F7,stroke:#879AB0,color:#25364A,stroke-width:1px
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  class Driver,Account,External input
  class OCC,Revision,Gateway state
  class Compute,Worker,Egress operation
  class Proxy operation
  style Sandbox fill:#FAFBFC,stroke:#D8DEE6,stroke-width:1px
```

## Acceptance criteria

- **AC-1 — Deployment:** An administrator selects a reviewed skill, CLI, or hosted MCP release for a dedicated OpenClaw Agent. The correct Gateway context and worker artifact become available after deployment; an incompatible placement is rejected before cutover.
- **AC-2 — Accounts:** A user connects an account through OCC, grants an Agent access, and binds the account to a plugin instance. Discovery and execution use the authorized account and Token Service renewal without exposing tokens to the Plugin Driver or Harness. Withdrawing one Agent's grant leaves other grants usable.
- **AC-3 — Enforcement:** With an account that can read and write, a selected MCP read tool succeeds through native dispatch and a direct script. A disabled write tool reaches neither the upstream server nor a credential-bearing alternate route. Unsupported policy or ambiguous account routing is rejected before deployment.
- **AC-4 — Native human approval:** With the managed policy registered, an enabled MCP tool without an approval requirement uses same-node execution when eligible. An approval-required native call reaches the server only after a human permits that invocation. Rejection, timeout, or stale authority prevents it. Direct scripts are outside this approval guarantee; missing-policy rejection is a fast follow.

Detailed delivery steps and verification evidence belong in the [implementation plan](../plans/0043-managed-openclaw-plugins.md). Current supported behavior belongs in [Agent plugins](../../docs/reference/agent-plugins.md).

## Changelog

- 2026-11-17: Separate plugin, account, and request-enforcement ownership; move delivery status to the implementation plan.
- 2026-11-18: Scope human approval to native managed MCP invocations, with selective Gateway routing, tool-name approval prompts, and the explicit direct-script gap.
- 2026-11-18: Renumber the proposal to RFC-0043 and align static MCP request-policy ownership with the merged credential contracts.
