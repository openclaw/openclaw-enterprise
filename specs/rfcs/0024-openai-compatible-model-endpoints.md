---
status: Proposed
implementation_status: Not implemented
author: cooktheryan
---

# Proposal: Custom Responses API providers with manual model selection

- **ID:** RFC-0024
- **Created:** 2026-10-20
- **Last updated:** 2026-10-23
- **Implementation plan:** [RFC-0024 implementation plan](../plans/0024-openai-compatible-model-endpoints.md)
- **Related:** [PR #913: Support OpenAI-compatible Codex model endpoints](https://github.com/openclaw/openclaw-enterprise/pull/913), [Create Agent reference](../../docs/reference/console/create-and-deploy.md), [Compute Driver contract](../../docs/reference/drivers/compute.md), [Harness execution](../../docs/reference/harness-execution.md)

## Decision requested

May an Agent creator who can use a shared model Secret choose the HTTPS provider that receives its key? This proposal grants that authority for Embedded OpenClaw and Dedicated Codex API-key Agents. For example, if a creator selects a shared Secret and enters `https://models.example.test/v1`, that provider receives the key when the Agent makes a model request. Maintainers must decide whether permission to use the Secret is sufficient or whether its owner must also authorize the destination.

An existing OpenShell Credential Source already binds its key to a destination. Selecting that source fixes the endpoint. To use another endpoint with Gateway-backed Codex, the creator must register a new source. For direct Secret delivery, the selected Harness Configuration owns the endpoint. A blank field uses the Installation default for Dedicated Codex when configured, then OpenAI. Embedded OpenClaw defaults to OpenAI. The creator enters the model ID for a custom provider.

## Motivation

OpenClaw Enterprise (OCE) Create Agent offers static OpenAI choices and manual model-ID entry, but no per-Agent endpoint. The current form also labels a custom destination as OpenAI even when another provider operates that endpoint and receives the key. This proposal separates provider identity from the Responses wire protocol and covers all three execution topologies.

Existing Configuration and Create Agent paths support provider `baseUrl` values and manual model IDs. Reuse `apps/controller/src/drivers/openai-endpoint.ts` for server-side HTTPS and `/v1` validation; it rejects credentials, queries, fragments, wildcards, port `0`, and rewritten IPv4 forms, with no loopback HTTP exception. OpenClaw's [custom-provider guidance](https://github.com/openclaw/openclaw/blob/main/docs/concepts/model-providers/custom-providers.md) describes the same configuration pattern.

[PR #913](https://github.com/openclaw/openclaw-enterprise/pull/913) adds the Dedicated Codex API-key Responses path and `runtime.codexModelBaseUrl` Installation default. This RFC adds a per-Agent override and endpoint selection for Embedded OpenClaw. OCE's Gateway Driver binds keys to a Credential Source host and base-path prefix; Dedicated Codex reads that URL and calls the provider directly. OpenShell v0.1.4 requires custom profiles for alternate hosts and removed `inference.local`. Dedicated native OpenClaw uses a separate provider-fenced path; current Compute rejects custom source endpoints there, and [PR #2755](https://github.com/openclaw/openclaw-enterprise/pull/2755) proposes that runtime change.

## Goals

- Add a fixed custom provider choice for the Responses API. It requires an endpoint URL, a provider API key, and a manual model ID.
- Support custom endpoints in Embedded OpenClaw, Dedicated Codex, and Dedicated native OpenClaw. The first two use the Agent-selected endpoint; Dedicated native OpenClaw uses its source-owned endpoint.
- For Gateway-backed Dedicated Codex, register a new endpoint-bound API-key Credential Source; leave an explicitly selected existing source authoritative.
- Reuse the existing Secret binding and Agent HTTPS egress policy. Expose `runtime.codexModelBaseUrl` as `agentProvisioning.codexApiKeyBaseUrl` in the existing Compute capability for authorized Installation readers.

## Non-goals

- Remote model discovery or a model catalog refresh API. Consider this in a follow-up RFC or implementation change after manual endpoint use is qualified.
- Add a general provider registry, new credential type, model proxy, or browser-to-provider request. The custom choice is one fixed Console provider option.
- Add provider-specific authentication. The custom choice supports bearer API keys only; ChatGPT OAuth and Codex service-account tokens remain OpenAI-provider choices.
- Add Chat Completions-only support to the shared OpenClaw and Codex path. Codex currently uses the Responses API.
- Add or broaden Agent egress, change provider-specific infrastructure, or claim that the configured hostname is allowlisted.
- Override the immutable endpoint of an existing Credential Source. A different endpoint requires a new source.
- Add an Agent-controlled endpoint override for Dedicated native OpenClaw. Its source owns the endpoint, and support depends on [PR #2755](https://github.com/openclaw/openclaw-enterprise/pull/2755).

## Proposal

### Provider, endpoint, and manual model selection

Add **Custom (Responses API)** to the existing Provider selector. OpenAI remains the default provider and keeps its static model list, OpenAI API-key help, Service Accounts, and ChatGPT OAuth choices. Anthropic remains unchanged. The custom choice is not a provider registry.

When the custom provider is selected, show a required endpoint field below the API-key Secret field. Use a generic **Provider API key** label and Secret picker; do not show OpenAI's key placeholder or documentation link. Require manual model-ID entry and hide static OpenAI model choices. Changing the provider or endpoint must clear the entered key, selected Secret or Credential Source, and selected model so one provider's credential cannot be sent to another destination.

Validate the URL before saving and normalize it with the existing OpenAI endpoint helper. Require HTTPS and a base path that ends in `/v1`; reject wildcards, port `0`, embedded credentials, query strings, fragments, and IPv4 spellings that the URL parser changes. The current helper has no loopback HTTP exception. Do not make an HTTP request to the endpoint while editing or saving the form.

For direct Secret delivery in Embedded OpenClaw, save the endpoint under a fixed internal `custom` provider key with `api: "openai-responses"` and a `custom/<model-id>` reference. For Dedicated Codex, carry the same selected provider and model ID through admission and compile the runtime projection into the existing Codex `openai-compatible` provider with `wire_api = "responses"`. For Gateway delivery, save the resolved endpoint on a new Credential Source and derive the Dedicated Codex provider endpoint from that source. Store the custom model ID and display name without OpenAI-specific metadata for Embedded OpenClaw and Dedicated Codex. Keep the key in its Namespace Secret.

When Create Agent registers an OpenAI-provider API key through the Gateway, resolve `agentProvisioning.codexApiKeyBaseUrl`, then OpenAI. Kubernetes Compute sets this capability from `runtime.codexModelBaseUrl` when configured. The endpoint is non-secret and appears only in the authorized Installation response. For the custom provider, use its required endpoint. Save the resolved value as a new Credential Source `base_url`; the Gateway Driver builds its profile and Compute reads the same URL. OpenShell substitutes the key only at the profile's host and configured base-path prefix. A changed URL needs a new source; the field cannot override a source selected directly. This path supports Dedicated Codex, not Embedded OpenClaw.

For Dedicated native OpenClaw, the creator selects an existing OpenShell API-key Credential Source. Its immutable `base_url` determines the provider endpoint, and the Agent cannot redirect that credential. Show the source endpoint as read-only. This workflow remains pending [PR #2755](https://github.com/openclaw/openclaw-enterprise/pull/2755); do not enable it in Create Agent until that runtime change is accepted and integrated. The phase must also satisfy Compute's existing Dedicated OpenClaw model-metadata requirements rather than inventing defaults.

### Create Agent interface mockup

Keep the current form layout and spacing. For the custom provider, place the endpoint field between **API key Secret** and **Model**, and replace the static model chooser with manual model-ID entry.

```text
Agent name
[____________________________________________________________]

Model provider
Provider                         Harness
[Custom (Responses API)      v] [Codex                        v]

Authentication method            API key Secret
[Provider API key             v] [Choose the provider API key Secret v]

Responses endpoint
[https://models.example.test/v1______________________________]
The selected provider receives this API key. OCE checks the URL syntax, not the provider identity or model compatibility.
Choose this harness only when the endpoint supports streaming Responses requests and tool calls.

Model
Model ID
[provider-model-id___________________________________________]
Enter the model ID listed by this endpoint.
```

With the OpenAI provider, keep the existing **Choose a model** list and **Enter model ID manually** control. With the custom provider, show the manual field and do not imply that OCE has checked the model ID with the provider. Dedicated Codex must also allow manual entry when its Installation default points to a custom endpoint.

### Runtime use by OpenClaw and Codex

Embedded OpenClaw uses its provider Configuration; it does not use the OpenShell SandboxDriver. Direct Secret delivery for Dedicated Codex sets its projected provider endpoint. Gateway-backed Codex derives the provider URL from the selected source's `base_url`; OpenShell substitutes the placeholder only at the profile's authorized host and base-path prefix. Dedicated Codex keeps `wire_api = "responses"`. OAuth and Service Account authentication remain available only with the OpenAI provider. Dedicated native OpenClaw uses its source-owned endpoint and remains pending [PR #2755](https://github.com/openclaw/openclaw-enterprise/pull/2755).

The Embedded OpenClaw, Dedicated Codex, and Dedicated native OpenClaw paths call `/v1/responses`. The pinned OCE runtime includes OpenClaw's custom-provider Responses transport, and Codex supports the Responses wire API. A catalog entry does not prove request or streaming compatibility. Qualify OpenAI, then one endpoint and model through real turns in all three workflows; do not generalize that result to every compatible service.

### Credential, validation, and egress boundaries

The browser saves the URL and model ID; it does not call the endpoint. The proposed authority lets a creator with access to a shared model Secret send its key to any compatible HTTPS endpoint, without separate approval from the Secret owner. HTTPS and URL validation do not establish trust in the endpoint operator. The interface must disclose where the key goes. OpenShell binds a Gateway-delivered key to the source profile's host and base-path prefix, but it does not establish trust in that provider. Validate URLs with the existing OpenAI endpoint rules. Clear the credential and model when the provider or endpoint changes.

The current Compute-generated Agent NetworkPolicy permits IPv4 TCP/443 to `0.0.0.0/0` except `10.0.0.0/8`, `100.64.0.0/10`, `172.16.0.0/12`, `192.168.0.0/16`, and `169.254.0.0/16`. These exclusions cover private, carrier-grade NAT, and link-local ranges, but not every reserved range; `198.18.0.1` remains allowed. Reuse this policy without adding API or worker egress. It does not restrict traffic to the configured hostname; cluster networking must also allow HTTPS. Verify the five denied ranges and selected public endpoint in enforcing k3d. A restricted model proxy remains separate work under `TODO(model-egress-proxy)` and RFC-0017. Dedicated native OpenClaw retains the Credential Gateway's exact-host policy.

```mermaid
---
config:
  theme: base
  htmlLabels: true
  themeVariables:
    fontSize: 15px
    primaryTextColor: "#344054"
    lineColor: "#8B949E"
    edgeLabelBackground: "#FFFFFF"
  flowchart:
    curve: linear
    nodeSpacing: 28
    rankSpacing: 34
    padding: 14
---
flowchart TB
  User["<b>Agent creator</b><br/>Selects provider and model"]
  Console["<b>Create Agent</b><br/>Saves Configuration and credential reference"]
  DirectRuntime["<b>Embedded OpenClaw<br/>or direct-key Codex</b>"]
  GatewayCodex["<b>Gateway-backed Codex</b><br/>Uses source endpoint"]
  NativeRuntime["<b>Dedicated native OpenClaw</b><br/>Uses source endpoint"]
  Secret["<b>Existing Secret binding</b><br/>Provides runtime API key"]
  Source["<b>OpenShell Credential Source</b><br/>Owns endpoint and provider profile"]
  Gateway["<b>OpenShell Credential Gateway</b><br/>Substitutes key at authorized host and path prefix"]
  Provider["<b>Custom provider</b><br/>Accepts Responses API requests"]
  User -->|provider + endpoint + model ID| Console
  Console -->|Configuration + Secret reference| DirectRuntime
  Console -->|Configuration + source reference| GatewayCodex
  Console -.->|source selection after #2755| NativeRuntime
  Secret -->|runtime credential| DirectRuntime
  Console -->|registers source with API key reference and base_url| Source
  Source --> Gateway
  GatewayCodex -->|request with placeholder| Gateway
  NativeRuntime -->|request with placeholder| Gateway
  DirectRuntime -->|Responses API request| Provider
  Gateway -->|authorized endpoint| Provider
  classDef actor fill:#F1EEF5,stroke:#A091AD,color:#3A3243,stroke-width:1px
  classDef owner fill:#E8EEF5,stroke:#879BB0,color:#25364A,stroke-width:1px
  classDef runtime fill:#E6F4F1,stroke:#7FA8A0,color:#25364A,stroke-width:1px
  classDef pending fill:#F3F4F6,stroke:#98A2AE,color:#44505F,stroke-width:1px,stroke-dasharray:4 4
  class User,Provider actor
  class Console,Secret,Source,Gateway owner
  class DirectRuntime,GatewayCodex runtime
  class NativeRuntime pending
  linkStyle default stroke:#8B949E,stroke-width:1px
```

The diagram shows proposed runtime paths. The dashed connection marks the Dedicated native OpenClaw phase as pending #2755. It does not prove endpoint compatibility or deployment egress.

## Compute capability

This proposal extends the existing `ComputeAgentProvisioningCapabilities` contract with optional `codexApiKeyBaseUrl` and returns it in the authorized `GET /installation` response. It adds no route, model-discovery API, API egress rule, database entity, or credential format. It reuses the existing OpenShell API-key Credential Source and provider-profile path for Gateway-backed Dedicated Codex. Create Agent cannot automatically register the source when its caller cannot read Installation capabilities; the existing direct Secret path remains available where the selected Compute Driver permits it.

### Coordination with PR #2755

[PR #2755](https://github.com/openclaw/openclaw-enterprise/pull/2755) proposes custom endpoints for Dedicated native OpenClaw with `credential_source` authentication. It requires the endpoint to match the bound source, so Agent Configuration cannot redirect that credential. This RFC stages that workflow after #2755 is accepted and integrated; the phase must add the supported caller, satisfy Compute's model-metadata requirements, and run a real Agent turn.

## Delivery and verification

[The implementation plan](../plans/0024-openai-compatible-model-endpoints.md) owns the ordered changes and proof. Required proof includes:

1. Playwright for the OpenAI and custom providers, including model ID entry, endpoint changes, credential clearing, validation, persisted Configuration, and error states. Inspect the matching Storybook scenarios and provide screenshots and a short video outside the repository.
2. Verify that `GET /installation` returns `agentProvisioning.codexApiKeyBaseUrl` to Installation readers when configured and omits it otherwise. Regenerate and check OpenAPI output for the response field; the operation and permission inventory do not change.
3. Real streaming turns with a tool call in Embedded OpenClaw, Dedicated Codex, and Dedicated native OpenClaw, first with OpenAI and then a qualified custom endpoint. Verify the selected endpoint, credential path, and Agent egress. For Gateway delivery, verify the source profile's host and base-path prefix and its denial outside that profile.
4. Updated Create Agent, Codex, OpenShell, and execution-flow documentation.

RFC acceptance does not establish implementation or runtime availability. Missing enforcing k3d networking, endpoint access, or authorized credentials leaves the corresponding proof outstanding.

## Rationale and alternatives

Reuse the existing Secret binding, OpenShell source profile, and Codex Installation default while making the custom provider a distinct user choice. Omit OpenAI-specific metadata for Embedded OpenClaw and Dedicated Codex; keep Dedicated native OpenClaw's source ownership and metadata admission.

Remote discovery is deferred. `discoverAgentModels` and `ComputeDriver.discoverHarnessModels` support built-in catalogs at fixed URLs. Custom discovery needs endpoint validation, catalog requests, and API egress changes; assess it after manual endpoint use is qualified.

Use one custom provider choice and the Responses API for all three workflows. Assess other protocols and provider-specific features after this path is qualified.

## Decisions and remaining proof

- **Agent egress:** Reuse the policy above; it does not allowlist the endpoint hostname. A restricted model proxy remains separate work.
- **Responses API qualification:** Use OpenAI first, then OpenRouter's documented beta Responses endpoint as the first candidate. Its docs do not prove every model works with every Harness. Require real streaming Agent turns with a tool call in all three workflows before claiming compatibility; record failures by request or stream behavior.

## References

- [OpenClaw custom-provider configuration](https://github.com/openclaw/openclaw/blob/main/docs/concepts/model-providers/custom-providers.md)
- [OpenClaw custom Responses transport support, merged upstream](https://github.com/openclaw/openclaw/issues/43018)
- [Codex model provider configuration](https://developers.openai.com/codex/config-reference)
- [OpenRouter Responses API reference](https://openrouter.ai/docs/api/api-reference/responses/create-responses) (qualification candidate only; not an OCE provider integration)
- [OpenShell v0.1.4 inference and custom endpoint guidance](https://docs.nvidia.com/openshell/v0.1.4/how-it-works/inference)
- [OpenShell v0.1.4 provider profiles and credential binding](https://docs.nvidia.com/openshell/v0.1.4/how-it-works/providers/overview)
- [OCE's pinned OpenClaw Responses transport](https://github.com/openclaw/openclaw/blob/f8386bc7df0a6c9eda7a28ae81943c5c06a414ff/packages/ai/src/transports/openai-responses-client.ts)
- [RFC-0004: Initial OCC Prometheus metrics](0004-occ-prometheus-metrics.md) and [RFC-0018: Installation profiles](0018-installation-profiles-design/index.md), accepted proposals with scoped delivery and verification records.
- [RFC-0022: Shared Driver configuration definitions](0022-driver-configuration-contributions.md), a merged proposal that remains `Proposed` pending its decision and implementation review.
