---
rfc: ../rfcs/0029-openai-compatible-model-endpoints.md
---

# Implementation plan: Authorized custom Responses endpoints in Create Agent

- **ID:** RFC-0029
- **Delivery status:** Planned
- **Owner:** Console, Compute Driver, and credential-binding maintainers
- **Authority:** [RFC-0029](../rfcs/0029-openai-compatible-model-endpoints.md)
- **Source baseline:** `adbf669ad` (`origin/main`, 2026-11-03)

## Outcome and scope

Add a supported Create Agent workflow for custom Responses endpoints. The creator selects **Custom (Responses API)**, supplies an endpoint and endpoint-authorized API key, and enters a model ID manually. Embedded OpenClaw uses the Agent-selected custom endpoint. Dedicated Codex keeps Installation-owned routing through `runtime.modelProvider`, and the Agent authorization must match that destination. Dedicated native OpenClaw selects an existing Credential Source whose immutable `authorized_base_url` matches the Installation endpoint.

The backend persists the credential reference and authorized endpoint together. It rejects an existing shared Secret at an unauthorized custom endpoint. An arbitrary custom endpoint requires a separately supplied endpoint-specific key. The workflow reuses the existing runtime transports and does not change model discovery or Agent egress.

## Contract and source touchpoints

- `apps/controller/src/console/agents/create.mts` owns the provider selector, endpoint field, credential state, manual model-ID mode, generated Configuration, and draft state.
- `apps/controller/src/drivers/openai-endpoint.ts` owns URL normalization and rewritten-IPv4 detection.
- `packages/contracts/src/index.ts`, `packages/contracts/src/harness-auth.ts`, and `packages/contracts/src/api/common.ts` own `HarnessAuthBinding`, its snapshot, and public schema.
- `packages/contracts/src/drivers/credential-gateway/index.ts` owns the Gateway destination-description contract. The selected Gateway implementation reports normalized destinations for each credential field; OCC compares them with Secret authorization.
- `packages/occ/src/index.ts`, `apps/controller/src/index.ts`, and `apps/controller/src/worker.ts` own admission, persistence, and provisioning checks.
- `packages/contracts/src/drivers/compute/index.ts` and `apps/controller/src/drivers/compute/kubernetes/index.ts` own `ComputeAgentProvisioningCapabilities` and its Installation response.
- `apps/controller/src/drivers/compute/plugin-runtime.ts` and `codex-model-configuration.ts` compile the Dedicated Codex endpoint and model.
- `apps/controller/src/drivers/credential-gateway/openshell.ts` owns source `authorized_base_url` validation and profile binding.
- `scripts/console-storybook/` owns matching UI stories and workflow instructions.
- `tests/browser/console-agents-2.test.ts` owns the supported browser workflow.
- `tests/integration/harness-topology-k3d-real.test.mjs` owns real-runtime topology coverage.

## Implementation

1. Extend `ComputeAgentProvisioningCapabilities` with optional `codexApiKeyBaseUrl`, populate it from `runtime.modelProvider`, update the API schema and generated reference, and return it from the authorized Installation response.
2. Add the custom provider choice and required endpoint field to Create Agent. Reuse the existing manual model-ID mode, hide the OpenAI model list, use a generic API-key label, and clear credential and model state when the provider or endpoint changes.
3. Extend the API-key `HarnessAuthBinding` and snapshot with an optional authorized endpoint. Store only the Secret reference and endpoint. Add schema, persistence, and immutable revision validation.
4. Add the Gateway-owned destination-description operation to the Credential Gateway Driver contract and its OpenShell implementation. For a proposed registration, return one normalized destination per credential field, including provider defaults, without exposing Secret values.
5. Enforce the binding in Agent admission and worker provisioning. Require an endpoint for a custom direct-Secret provider. Reject a shared Secret whose persisted endpoint does not match every Gateway-reported destination. Preserve current behavior for OpenAI and Anthropic.
6. Generate Embedded OpenClaw’s fixed `custom` provider with `api: "openai-responses"`, a `custom/<model-id>` reference, and `OCE_MODEL_API_KEY`. Do not add OpenAI-specific model metadata.
7. Bind the Dedicated Codex `openai-compatible` runtime projection to `runtime.modelProvider` (or the OpenAI default) and require the Agent authorization to match it; endpoint metadata does not redirect routing.
8. Add Dedicated native OpenClaw source selection to Create Agent. Show the source’s immutable `authorized_base_url` as read-only, require it to match the Installation endpoint, and require the model metadata Compute admits.
9. Update Create Agent, Compute, OpenShell, and execution-flow documentation. Add Storybook states for empty, loading, validation, permission, credential, and saved states.

## Verification

| Required outcome                                    | Real check and prerequisites                                                                                                                                                                                                                                                                                                                                                              | Result or remaining proof |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Create Agent supports the custom workflow           | Browser test the provider, endpoint, credential, manual model, state reset, draft recovery, and generated Configuration. Inspect matching Storybook states and capture required visual evidence.                                                                                                                                                                                          | Not run                   |
| Installation exposes the Compute endpoint           | Check `GET /installation` with and without `runtime.modelProvider`; run OpenAPI generation and checks.                                                                                                                                                                                                                                                                                    | Not run                   |
| Unauthorized shared-key destinations fail           | Integration-test Agent admission and worker provisioning with a shared Secret and mismatched endpoint. Assert an explicit refusal and no workload credential delivery.                                                                                                                                                                                                                    | Not run                   |
| Gateway reports normalized destinations             | Integration-test the Credential Gateway destination-description operation for default and custom endpoints. Assert OCC refuses a shared Secret when any reported destination is unauthorized.                                                                                                                                                                                             | Not run                   |
| Embedded OpenClaw uses the endpoint                 | In enforcing k3d, run a real streaming Agent turn with a tool call through the custom provider. Verify the rendered Configuration and delivered key reference.                                                                                                                                                                                                                            | Not run                   |
| Endpoint authorization matches Installation routing | In enforcing k3d, run a real turn with a Codex Agent whose endpoint authorization matches `runtime.modelProvider`, and with a native OpenClaw source that matches. Prove a mismatched Agent endpoint and a mismatched source endpoint are each refused during admission and provisioning. Verify routing follows the Installation endpoint and the compiled `openai-compatible` provider. | Not run                   |
| Gateway delivery is endpoint-bound                  | Run Dedicated Codex through an OpenShell Credential Source. Verify the profile host and base-path binding, and verify denial outside that profile.                                                                                                                                                                                                                                        | Not run                   |
| Dedicated native OpenClaw uses its source           | Select an existing source, supply admitted model metadata, and run a real streaming Agent turn with a tool call. Verify the immutable endpoint matches the Installation endpoint and the source profile.                                                                                                                                                                                  | Not run                   |
| Documentation and UI are reviewable                 | Run documentation, formatting, OpenAPI, browser, and Storybook checks. Capture final screenshots and a short workflow video outside the repository.                                                                                                                                                                                                                                       | Not run                   |

Fixture coverage does not establish provider compatibility. Run OpenAI first, then one documented Responses endpoint such as OpenRouter as a qualification candidate. A successful turn does not qualify every model or provider that exposes a Responses route.

## Delivery record

RFC-0029 remains Proposed. The Create Agent workflow, endpoint-bound direct Secret authorization, capability field, browser coverage, and real-runtime qualification have not been implemented. The underlying Embedded OpenClaw, Dedicated Codex, OpenShell source, and Dedicated native OpenClaw transports are present in current source.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-20: Revised the planned delivery to use manual model selection and defer remote discovery.
- 2026-10-20: Kept `runtime.modelProvider` as the Codex fallback and removed user-entered model limits and cost metadata from the initial Embedded and Codex phases.
- 2026-10-20: Made verification Kubernetes-provider agnostic with enforcing k3d and reused the current broad Agent HTTPS policy.
- 2026-10-20: Scoped the Agent field to Embedded OpenClaw and Dedicated Codex; Dedicated native OpenClaw keeps its OpenShell source-owned endpoint and exact-host egress.
- 2026-10-21: Added the OpenShell custom-profile path for Gateway-backed Dedicated Codex.
- 2026-10-22: Added the Compute Agent-provisioning capability needed to resolve the Installation Codex default during Gateway registration.
- 2026-10-23: Restored the proposal and plan content.
- 2026-10-26: Adopted the owner-authorized destination recommendation: shared keys cannot be redirected by Agent creators; custom endpoints use separately supplied endpoint-specific credentials.
- 2026-11-02: Renumbered to RFC-0029, the next available ID on `main` after 0024-0026 were assigned to other proposals.
- 2026-11-03: Rewrote the remaining scope around the Create Agent workflow and credential-endpoint authorization after the runtime transports landed on `main`.
- 2026-11-03: Added the Gateway-owned destination-description contract so OCC can enforce Secret authorization without interpreting provider-specific Gateway configuration.
- 2026-11-04: Aligned Credential Source authorization with Installation-owned routing. A source's `authorized_base_url` must match `runtime.modelProvider` (or the OpenAI default), a mismatch is refused during registration and provisioning, and authorization never selects a different route.
