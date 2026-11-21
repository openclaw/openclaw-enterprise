---
status: Proposed
implementation_status: Partially implemented
author: Patrick-Erichsen
---

# Proposal: Declare standalone web search for a custom Codex endpoint

- **ID:** RFC-0026
- **Created:** 2026-10-29
- **Last updated:** 2026-10-29
- **RFC PR:** https://github.com/openclaw/openclaw-enterprise/pull/4142

## Summary

Add `runtime.codexModelSupportsStandaloneWebSearch?: boolean` to the Kubernetes
Compute Driver configuration. An operator can declare that the explicit
`runtime.codexModelBaseUrl` supports Codex's standalone web-search protocol.
The option defaults to false. It does not grant network access or prove that
the endpoint supports search.

## Motivation

The Driver already selects an OpenAI-compatible endpoint for dedicated Codex
API-key authentication. Its generated Codex user configuration does not declare
standalone web search. A compatible endpoint therefore cannot advertise this
capability through the supported Installation configuration.

## Proposal

The Kubernetes Compute Driver owns the option and its validation. Reject true
unless `runtime.codexModelBaseUrl` is explicitly configured. Reject nonboolean
values. Existing endpoint validation remains in force.

For dedicated Codex API-key authentication using that endpoint, carry the
option through the existing plugin runtime manifest. Write
`supports_standalone_web_search = true` under the existing custom provider in
Codex's user configuration. Omission or false retains current behavior. Do not
rename the provider or model, change credentials, enable Gateway provider tools,
or change sandbox, approvals, or egress rules. Other Harness and authentication
paths retain their current configuration.

The endpoint and selected runtime must implement standalone search. An incorrect
operator declaration can cause search requests to fail; it must not redirect
those requests to a different provider or enable a fallback credential path.
Changing this Installation option takes effect through the existing Agent
revision deployment lifecycle. This proposal does not authorize a deployment.

## Delivery and verification

Submit this RFC for human feedback before implementation. Implement the Driver
option and the existing runtime rendering path in this PR, with the owning
reference and source-backed flow updated together.

Exercise the regular Agent configuration and deployment path, inspect the
resulting user configuration, and verify that the declaration survives runtime
startup. Cover omitted and false values, true without an endpoint, and unrelated
authentication paths. Preserve provider identity, protected provider tools,
sandbox, and approval settings. Source and fixture checks do not establish that
a live provider completes search; report that separate proof explicitly.

Driver validation and generated configuration are implemented on this branch.
Focused conformance proves the opt-in and refusal behavior. Real installed Agent
lifecycle verification and independent review remain pending; this is not live
search qualification.

## Rationale and alternatives

An explicit Driver option keeps the capability under the owner that selects the
endpoint. Inferring it from a hostname would grant capabilities based on vendor
identity. Workspace provider overrides are unsuitable because Codex reads this
provider declaration from its user configuration. Keeping the current behavior
requires a separate search tool even when the endpoint supports native search.

## References

- [Kubernetes Compute Driver](../../docs/reference/drivers/kubernetes-compute.md)
- [Harness execution flow](../../docs/flows/harness-execution-topology.md)
- [Codex custom provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
