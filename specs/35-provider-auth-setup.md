# Provider authentication setup

**Date:** 2026-09-23\
**Status:** Implementation in progress; API-key and local endpoint setup\
**Owner:** OCE provider integration and Agent authentication\
**Tracking:** [Provider expansion #84](https://github.com/openclaw/openclaw-enterprise/issues/84)

## Scope

OpenClaw Enterprise (OCE) lets operators save a model provider and authentication
method before creating an Agent, then reuse that connection within its Namespace.
The first milestone supports OpenAI API keys, Anthropic API keys, Ollama, and
vLLM. OAuth acquisition, credential custody, refresh, and Console sign-in belong
to a separate PR. Anthropic setup tokens are deferred. No new inference
transport is needed.

An Installation [Provider](../docs/reference/providers.md) remains startup-loaded
configuration for related Drivers. `Agent.providerId` retains its existing
managed-service-account meaning. A new **ProviderConnection** records model setup
for one Namespace; it neither creates an Installation Provider nor changes model
or Harness selection. Existing direct Secret, managed ChatGPT account, and
operator-managed runtime bindings remain available where supported.

## Catalog and availability

The bundled [catalog](../apps/controller/src/providers/model-auth-catalog.ts)
uses native OpenClaw provider and method IDs:

| Provider    | Method                 | Harness                              |
| ----------- | ---------------------- | ------------------------------------ |
| `openai`    | `api-key`              | Embedded OpenClaw or dedicated Codex |
| `anthropic` | `api-key`              | Embedded OpenClaw                    |
| `ollama`    | `local`, no credential | Embedded OpenClaw                    |
| `vllm`      | `custom`, API key      | Embedded OpenClaw                    |

Mappings are source-checked against OpenClaw `2026.9.1`. Source compatibility
is separate from live verification. Ollama records an endpoint without a
credential; the pinned vLLM setup requires a nonempty API key. Neither local
choice provisions a server or grants network access.

## Implemented contracts

The [provider reference](../docs/reference/providers.md#model-authentication-catalog-and-saved-connections)
owns API routes, permissions, immutable connection fields, Secret ownership,
endpoint validation, and deletion guards. The
[Console workflow](../docs/reference/console.md#save-a-provider-connection)
owns credential entry, uncertain-save recovery, and Agent selection.

Key design decisions remain:

- `Agent.harnessAuth` stores `{method: "provider_connection", connectionId}`;
  the connection is reusable metadata, while Secret bytes stay with its Driver.
- Admission snapshots safe connection metadata; dispatch rechecks actor, Agent,
  connection, and Secret authority before Compute projects credentials.
- Compute owns native configuration and credential delivery. The deployed
  OpenClaw process probes the selected model. No inference broker is introduced.
- Local endpoints require separately configured network access. Saving setup
  neither contacts the endpoint nor grants egress.
- Drafts, active revisions, and pending deployments protect connection references.
  Historical snapshots do not retain old credential values; changing a Secret
  uses the existing explicit redeployment workflow.

## Verification

Validation exercises connection API permissions, foreign-Namespace denial,
immutable storage, Secret deletion guards, unsupported-method rejection,
connection-backed deployment snapshots, and worker reauthorization. Console
coverage follows saving a connection and selecting it for an Agent. PostgreSQL
and HTTP integration establish persistence and API behavior; source mappings
and browser fixtures do not establish live upstream model execution.
