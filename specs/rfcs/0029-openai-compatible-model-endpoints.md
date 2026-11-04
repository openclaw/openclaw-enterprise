---
status: Proposed
implementation_status: Not implemented
author: cooktheryan
---

# Proposal: Authorized custom Responses endpoints in Create Agent

- **ID:** RFC-0029
- **Created:** 2026-10-20
- **Last updated:** 2026-11-04
- **Implementation plan:** [RFC-0029 implementation plan](../plans/0029-openai-compatible-model-endpoints.md)
- **Related:** [PR #913: Support OpenAI-compatible Codex model endpoints](https://github.com/openclaw/openclaw-enterprise/pull/913), [Create Agent reference](../../docs/reference/console/create-and-deploy.md), [Compute Driver contract](../../docs/reference/drivers/compute.md), [Harness execution](../../docs/reference/harness-execution.md)

## Decision

Add a fixed **Custom (Responses API)** provider to Create Agent. The provider requires an HTTPS Responses endpoint, a model API key, and a manual model ID. OCE stores the credential reference and authorized endpoint together, and checks that pair when it admits and provisions an Agent.

Permission to operate a shared Secret does not authorize sending that key to a different destination. An existing shared Secret may be used with a custom endpoint only when its persisted binding authorizes that endpoint. An arbitrary custom endpoint requires a separately supplied endpoint-specific key or an existing Credential Source whose immutable `authorized_base_url` authorizes that endpoint. Reject a mismatch during Agent admission and again during provisioning. Do not infer destination consent from `secret:operate` or a browser confirmation.

The custom choice is a provider selection, not a provider registry. OpenAI remains the default. Dedicated Codex routing is Installation-owned: `runtime.modelProvider`, then OpenAI; an Agent endpoint authorizes the credential but does not redirect that routing. Dedicated native OpenClaw likewise uses a source whose endpoint matches that Installation endpoint; selecting a source authorizes the credential, not a different route. Directly delivered keys are not hostname-confined; the current Agent NetworkPolicy permits broad public HTTPS. Gateway-owned credentials retain their source profile’s host and base-path restrictions.

## Current behavior

The runtime transports are already present. PR #913 added the Dedicated Codex API-key Responses path and the `runtime.modelProvider` Installation default. OpenShell Credential Sources accept an optional OpenAI-compatible `authorized_base_url` and bind their profiles to that host and base path. Current Compute requires a bound source’s `authorized_base_url` to equal the Installation model endpoint: `runtime.modelProvider`, otherwise the OpenAI default. It refuses a source that authorizes a different destination during registration and provisioning. Authorization can refuse a destination; it cannot select a different route. Embedded OpenClaw supports custom providers through Configuration and `OCE_MODEL_API_KEY`, and Gateway-backed Dedicated Codex and Dedicated native OpenClaw accept an OpenAI-compatible source only when its endpoint matches the Installation endpoint.

Create Agent does not expose this path as a first-class workflow. Its provider selector offers only OpenAI and Anthropic. Its manual model-ID control exists, but the form does not collect or authorize a custom endpoint. `ComputeAgentProvisioningCapabilities` advertises execution modes but not the Installation’s Codex API-key endpoint. The `harnessAuth` binding records a Secret or Credential Source reference, not the authorized endpoint for a directly delivered key.

## Goals

- Add the custom provider choice, endpoint field, generic API-key label, and required manual model-ID entry to Create Agent.
- Persist and enforce the credential-endpoint pair for direct Secret delivery.
- Keep provider-specific destination parsing and normalization inside the selected Credential Gateway Driver. OCC compares normalized Gateway destinations with Secret authorization and does not interpret OpenShell configuration itself.
- Let Gateway-backed Dedicated Codex and Dedicated native OpenClaw use an existing Credential Source whose immutable `authorized_base_url` authorizes the Installation endpoint and is read-only.
- Preserve the OpenAI provider, its existing authentication choices, and Installation-owned Dedicated Codex routing through `runtime.modelProvider`, then OpenAI.
- Expose `runtime.modelProvider` as `agentProvisioning.codexApiKeyBaseUrl` to authorized Installation readers.
- Qualify the workflow with real streaming Agent turns and a tool call in Embedded OpenClaw, Dedicated Codex, and Dedicated native OpenClaw.

## Non-goals

- Remote model discovery, a model catalog refresh API, or provider-specific model metadata.
- A general provider registry, new credential type, model proxy, or browser-to-provider request.
- Chat Completions-only endpoints or provider-specific authentication. The custom choice supports bearer API keys and the Responses API.
- Redirecting an existing shared Secret to a destination its owner did not authorize.
- Changing or broadening Agent egress. Restricted model egress remains separate work under RFC-0017.
- Overriding the immutable endpoint of an existing Credential Source.

## Proposal

### Create Agent workflow

When the creator selects **Custom (Responses API)**, show a required endpoint field and a generic **Provider API key** label. Hide the OpenAI model list and require manual model ID entry. Changing the provider or endpoint clears the credential and model. Do not call the endpoint from the browser or while saving the Agent.

Validate and normalize the URL with `normalizeOpenAiBaseUrl`. Require HTTPS and a base path ending in `/v1`. Reject wildcards, port `0`, embedded credentials, queries, fragments, and IPv4 spellings that the URL parser rewrites. Show validation and authorization failures beside the affected field.

For a separately supplied key, create an endpoint-specific Secret and persist its authorized endpoint with the Agent’s `harnessAuth`. For an existing shared Secret, accept only an endpoint already authorized by that Secret’s binding; otherwise refuse the combination. For a Credential Source, show its immutable `authorized_base_url` as read-only and never accept a caller-supplied override.

### Runtime topology

Embedded OpenClaw uses a fixed internal `custom` provider with `api: "openai-responses"`, a `custom/<model-id>` reference, and `OCE_MODEL_API_KEY`. It does not inherit OpenAI-specific context-window, output-limit, or cost metadata.

Dedicated Codex compiles the Installation model endpoint and model ID into its existing `openai-compatible` provider with `wire_api = "responses"`. The Agent's endpoint authorization must match that effective destination; it does not take precedence over `runtime.modelProvider`.

Dedicated native OpenClaw selects an existing OpenShell API-key Credential Source. Its immutable `authorized_base_url` must match the Installation model endpoint, and the form shows it as read-only; it authorizes the credential but does not redirect routing. The creator supplies the model metadata Compute requires for that topology; OCE does not invent defaults or bypass admission.

### Capability and authorization

Extend `ComputeAgentProvisioningCapabilities` with optional `codexApiKeyBaseUrl`, set it from Kubernetes Compute’s `runtime.modelProvider`, and return it in the authorized `GET /installation` response. Create Agent uses this value only when it registers an OpenAI-provider API-key Credential Source and no Agent endpoint is selected.

Extend `HarnessAuthBinding` and its immutable `AgentRevision` snapshot so an API-key Secret records its authorized endpoint. Store only the Secret reference and endpoint, never the key value. Admission and provisioning reject a mismatch or a missing required binding. Existing Credential Source bindings continue to use the source’s immutable `authorized_base_url`.

Extend the Credential Gateway Driver contract with a Gateway-owned destination-description operation. For a proposed source registration, the Gateway reports one normalized destination for each credential field. OCC compares those destinations with the Secret’s authorized endpoint before it creates or attaches the source. The Gateway continues to own provider-specific parsing, normalization, defaults, and refusal messages.

## Security and failure boundaries

Directly delivered API keys are readable by the Harness. The existing public TCP/443 Agent NetworkPolicy does not allowlist the configured hostname and does not prevent Harness code from using the key at another reachable endpoint. UI text and documentation must not describe this path as hostname-confined.

Gateway-owned credentials are bound by their OpenShell source profile to the authorized host and base-path prefix. Verify that a request outside that profile is denied. Credential values must never appear in Configuration JSON, OCC state, audit records, logs, or API responses.

Invalid URLs, unauthorized shared-key destinations, missing model IDs, and Credential Source endpoint mismatches must produce explicit refusals. A custom endpoint that passes URL validation is not proof that the provider supports the Responses API, streaming, or tool calls.

## Delivery and verification

The [implementation plan](../plans/0029-openai-compatible-model-endpoints.md) owns execution and evidence. Required proof includes:

1. Browser coverage for provider and endpoint changes, manual model entry, validation, credential clearing, persisted Configuration, and authorization refusals, with matching Storybook scenarios and visual evidence.
2. OpenAPI checks showing that `GET /installation` returns `agentProvisioning.codexApiKeyBaseUrl` when configured and omits it otherwise.
3. Integration coverage proving admission and provisioning reject shared Secret and Credential Source endpoint mismatches.
4. Integration coverage proving the Credential Gateway reports normalized destinations and OCC refuses a shared Secret whose authorization does not match every destination.
5. Real streaming Agent turns with a tool call for OpenAI and one qualified custom endpoint in all three supported topologies.
6. Updated Create Agent, Compute, OpenShell, and execution-flow documentation.

## Rationale and alternatives

Reusing the existing Configuration, Secret, Credential Source, and Compute transports avoids a new runtime path. The missing product capability is the supported caller and backend-enforced destination authorization.

Allowing `secret:operate` to redirect any shared key would make Secret permissions imply provider consent. Requiring a separately supplied key for arbitrary endpoints keeps the initial authorization simple. Remote discovery and additional wire protocols can be assessed after manual endpoint use is qualified.

## References

- [Create Agent reference](../../docs/reference/console/create-and-deploy.md)
- [Compute Driver contract](../../docs/reference/drivers/compute.md)
- [Harness execution](../../docs/reference/harness-execution.md)
- [Kubernetes Compute reference](../../docs/reference/drivers/kubernetes-compute.md)
- [OpenShell Credential Gateway reference](../../docs/reference/drivers/openshell-credential-gateway.md)
