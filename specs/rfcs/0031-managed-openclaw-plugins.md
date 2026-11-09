---
status: Proposed
implementation_status: Partially implemented
author: stevenlee-oai
---

# RFC-0031: Managed OpenClaw plugins

- **Created:** 2026-10-21
- **RFC PR:** [#3142](https://github.com/openclaw/openclaw-enterprise/pull/3142)
- **Implementation plan:** [Managed OpenClaw plugins](../plans/0024-managed-native-openclaw-plugins.md)

## Decision

An operator in OpenClaw Enterprise (OCE) selects a reviewed plugin, connects an account, and selects allowed tools for hosted Model Context Protocol (MCP) servers before deploying an Agent. OpenClaw Control Plane (OCC) records the release, credential binding, and policy in the Agent revision. The Harness runs CLI commands or MCP clients inside its Sandbox; the egress path authorizes credential use before injection. Platform integrations that change Gateway behavior remain operator-managed.

Dedicated OpenClaw Agents can use Google Workspace and Slack MCP with attached credential sources. OCE also supports saving and renewing a Namespace OAuth account. The remaining P0 work lets an operator grant an Agent access to that saved account from a plugin slot and use it on a deployed Agent. See [current plugin support](../../docs/reference/managed-openclaw-plugins.md) and the [delivery plan](../plans/0024-managed-native-openclaw-plugins.md).

## Plugins and execution placement

OpenClaw uses “plugin” for several kinds of integration. An OCE catalog entry describes which components a reviewed release contains and where each runs.

| Component                    | Placement and responsibility                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill                        | Instructions and resources made available to the model. The Gateway prepares the selected skill context for delegated turns.                                                                                  |
| CLI (command-line interface) | The Harness worker executes a reviewed binary. Google uses [gog](https://github.com/openclaw/gogcli), the OpenClaw project's Google Workspace CLI for Gmail, Calendar, Drive, and other Google services.      |
| Hosted MCP                   | The OpenClaw node host in the Harness pod runs the MCP client. The remote server executes its tools. The node advertises selected tool descriptors to the Gateway; the Gateway admits their use for the turn. |
| Gateway extension            | Code loaded into the Gateway process, such as Diffs. Channels, model providers, hooks, services, and changes to platform controls require separate platform-managed admission.                                |

The Google and Slack managed packages do not enter the native Gateway extension installer. The Gateway loads Google's skill and knows the MCP tool descriptors; the Harness performs credentialed CLI and MCP calls. Assets can be present in a shared runtime image without being activated in both processes. Gateway-native tools that require renewable credentials remain separate work, alongside channel credential delivery.

A plugin catalog entry grants neither credentials nor installation authority. The selected [Plugin Driver](../../docs/reference/drivers/plugin.md) supplies catalog metadata and validates compatible placement and supported policy. OCC authorizes the selection. Compute prepares the admitted runtime. The current `occ-plugin` catalog supports dedicated OpenClaw managed packages and curated embedded extensions. An Installation can select both bundled Drivers. OCC routes the catalog by Harness and records the owning Driver on the Agent revision. [Multiple Plugin Drivers](0029-multiple-plugin-drivers.md)

## From selection to deployed policy

The current OpenShell path compiles policy during deployment. Editing a plugin selection changes desired state; redeployment applies it to a replacement runtime. A credential slot is a named requirement declared by a release, such as Google’s `account` slot. The Agent binds that slot to an authorized source.

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
    nodeSpacing: 24
    rankSpacing: 30
    padding: 12
---
flowchart TB
  Driver["<b>Plugin Driver</b><br/>Catalog and validation"] -->|validate selection| Revision
  Source["<b>Credential source</b><br/>Ready attached source"] -->|bind by reference| Revision
  Revision["<b>OCC Agent revision</b><br/>Release, bindings, tools"] -->|prepare| Compute
  Compute["<b>Compute Driver</b><br/>Coordinate deployment"] -->|attach selected sources| Attachment
  Attachment["<b>Credential attachment</b><br/>Provider reference and scope"] --> Sandbox
  Compute -->|revision| Sandbox
  Connector["<b>Connector metadata</b><br/>API map or MCP server"] -->|reviewed constraints| Sandbox
  Sandbox["<b>OpenShell Sandbox adapter</b><br/>Compile and apply policy"] --> Policy
  Policy["<b>Per-placeholder policy</b><br/>Destination, executable,<br/>operations and injection"]
  classDef state fill:#EDF2F7,stroke:#879AB0,color:#25364A
  classDef input fill:#F1EEF5,stroke:#A091AD,color:#3A3243
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038
  class Revision,Attachment,Policy state
  class Driver,Source,Connector input
  class Compute,Sandbox operation
```

This diagram describes the implemented OpenShell handoff. Compute asks the existing `CredentialGatewayDriver` adapter for source attachments, then calls `SandboxDriver.provisionHarness`. That legacy attachment interface is distinct from `CredentialProxyDriver`. The Plugin Driver has no generic install or policy-translation RPC; the Sandbox implementation owns conversion to OpenShell policy. See the [deployment flow](../../docs/flows/agent-plugins.md).

Each binding joins a release digest and credential slot to a source reference. The source attachment supplies its destination and scope restrictions; the reviewed release and Installation policy constrain executables. The Sandbox derives routes and credential injection from those inputs, plus the release's operation map or selected upstream MCP tool names. “Per-placeholder policy” describes this association; OpenShell represents it with provider attachments, network rules, and, for Google, middleware configuration.

Compute sends nonsecret package descriptors to the Gateway and worker. The runtime image contains the reviewed artifacts; startup verifies their release and executable bytes and activates the selected skill, CLI, or MCP descriptor. The worker receives the admitted placeholder and CA settings through normal startup. A CLI dependency requires a compatible image release; selecting it does not run an arbitrary package installer in a live Gateway. Multiple managed packages can coexist on one Agent.

## Credentials and connection ownership

The proposal builds on the [plugin tool policy](0014-plugin-policy-enforcement.md) and [credential lifecycle](0023-egress-proxy-credential-lifecycle/index.md) designs. The [saved OAuth account design](0027-agent-oauth-connections/index.md) separates account setup from the grant an Agent needs to use it.

| Object                    | Owner and role                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection template       | Administrator-approved issuer, OAuth endpoints, destination/resource envelope, scope limits, and Installation or Namespace availability.                                                            |
| OAuth client registration | The operator's client ID, authentication method, and private client secret. OCC manages multiple registrations and stores confidential client secrets through the selected Secret Driver.           |
| Saved account             | A Namespace connection created by user consent. OCC records references and requested/granted scopes; Token Service owns the reusable grant and token renewal through private Secret Driver storage. |
| Agent/plugin binding      | A release declares a named slot for an attached source. Saved OAuth accounts additionally require the per-Agent grant in the proposed delivery path.                                                |

Installation administrators can configure templates and client registrations in **Credentials**. A signed-in user with Namespace credential creation permission can start browser consent through the connections API. OCC validates the callback and exchanges the code. The Token Service stores the grant and renews the access token. [Connection templates and accounts](../../docs/reference/connection-templates.md)

The proposed plugin-slot workflow lets an operator select or connect a saved account on an Agent. OCC must check the issuer, the intended recipient, and the caller’s authority before committing the binding. An MCP account authorized for a different resource requires consent for the intended server. The template supplies the endpoint, so the same plugin can target different approved service instances when its release supports them.

Today the bundled Google and Slack slots accept compatible attached Credential Gateway sources. For Slack discovery, OCC reads the attached bearer through the Secret Driver. In the proposed saved-account path, authorized discovery and delivery resolve the access token through Token Service. The sender checks the Agent grant and request policy before injection. The [P0 plan](../plans/0024-managed-native-openclaw-plugins.md#p0-complete-the-connected-account-workflow) tracks that handoff.

Credentials can be attached independently of plugins. Removing a plugin selection removes its configuration on redeployment. Independently retained attachments keep their own policy. For shared saved accounts, the proposed delivery must let an operator withdraw one Agent’s grant while other authorized Agents continue to work. Disconnecting the account ends its lifecycle for every consumer.

Custom scopes do not add destinations or authorize new operations. They require a corresponding approved endpoint allowlist and enforceable request policy before the Agent can use them. Product-grouped Google scope selection and an effective credential-access view remain follow-ups; the current connection work supports scope selection within the template's envelope.

## Tool selection and request enforcement

### Hosted MCP

OCC calls `tools/list` using an authorized credential before deployment. The operator selects upstream tool names. Discovery results are candidates, not grants; server annotations do not establish trusted read-only classifications.

The saved selection drives three controls: the worker's `toolFilter`, the Gateway's admitted tools, and OpenShell's MCP request rules. Policy keys are the managed server binding and upstream tool name, because model-facing aliases can change on collision. OpenShell checks the actual `tools/call` name before injection, including calls made by an admitted script executable. A disabled tool cannot be reached by constructing the same MCP HTTP request manually. Native rules handle required protocol traffic without granting arbitrary tool calls. General argument restrictions require additional enforcement.

### Google CLI and scripts

The Google Workspace connector owns the reviewed operation inventory, scope requirements, and provider-specific request evaluation. The Sandbox uses that inventory to build coarse routes and configures a shared request guard with the release digest and binding restrictions. The guard authenticates the Sandbox request, resolves the reviewed connector, and delegates semantic checks before OpenShell injects the bearer. Google-specific behavior stays in the connector directory; the shared guard owns transport, authentication, and dispatch. The guard runs in the execution cluster, keeping OCC off this request path.

A destination or HTTP method alone is insufficient. For example, Google message reads with `format=metadata` and `format=full` can use the same URL but require different authority. The connector checks relevant method, path, query, body, and scope constraints. It refuses unsupported operations instead of inferring permission from a GET or POST classification. Public schema retrieval uses no credential.

The current Google binding admits the pinned gog executable, which scripts can invoke. Extending access to direct HTTP scripts requires an approved executable and equivalent request checks. The [qualification plan](../plans/0024-managed-native-openclaw-plugins.md#verification) covers both callers.

### Enforcement boundary

CLI and MCP traffic leave through the same Harness Sandbox. Google uses the shared guard for provider semantics; MCP uses native OpenShell protocol rules. Both authorize before credential injection. Hiding tools from the model is a usability control, not the credential boundary. A binding does not identify which plugin caused a request. Approved processes in the same Agent Sandbox can use its effective authority; request rules constrain the credential destination and operation.

The deployed Google and MCP adapters use OpenShell request enforcement. The saved-account proposal adds delivery through Credential Proxy. Each alternative delivery path must qualify the actual permitted and denied requests from the deployed Harness.

Current MCP admission rejects overlapping routes that could bypass its restrictions. General composition of independent credential policies and plugin contributions remains open: the design must preserve separate grants while preventing a broader route from silently defeating a promised restriction. The proposed credential-access view should expose effective destinations and actions, not just the selected plugin settings. Request-time approvals, reviewer routing, and elicitation remain separate from these hard allowlists.

## ClawHub and later capabilities

ClawHub is an external registry for OpenClaw skills and plugins. It can supply discovery and release artifacts without becoming the credential owner. OCE should expose compatibility, capability, and admission status, pin a reviewed release and dependencies, and materialize admitted artifacts through its deployment lifecycle. Publisher updates require new admission and deployment. Retained admitted artifacts must support recovery during a registry outage.

The current catalog is bundled with the runtime image; ClawHub references record provenance. For Google, that provenance identifies the skill, while gog is a separately pinned executable in the image. Dynamic import, custom MCP endpoints, and their discovery egress are separate work. Gateway extensions with channels, providers, hooks, or services remain platform-managed even when distributed through ClawHub.

## Delivery and review

The [implementation plan](../plans/0024-managed-native-openclaw-plugins.md) tracks the remaining Agent grant and deployment work. The [plugin support reference](../../docs/reference/managed-openclaw-plugins.md) owns current availability. The [deployment flow](../../docs/flows/agent-plugins.md) traces the Driver handoffs.
