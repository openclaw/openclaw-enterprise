---
status: Proposed
implementation_status: Partially implemented
author: kevinlin-openai
---

# Proposal: Shared model provider configuration

- **ID:** RFC-0028
- **Created:** 2026-11-03
- **Last updated:** 2026-11-03
- **Implementation plan:** [Shared model provider delivery](../plans/0028-shared-model-provider.md)

## Summary

Configure the OpenAI-compatible inference destination once at
`drivers.compute.configuration.runtime.modelProvider`. Kubernetes Compute
translates this configuration for Codex and OpenClaw. Credential Sources supply
credentials and retain immutable destination authorization; they cannot select
or override the inference endpoint.

This extends existing Compute configuration and rendering. It does not introduce
a resource, Driver, model router, or protocol-conversion service.

## Motivation and current behavior

Dedicated Codex already accepts `runtime.codexModelBaseUrl` for direct API-key
authentication. A bound source's `config.base_url` takes precedence. Embedded
OpenClaw passes through its authored provider URL. Dedicated native OpenClaw
requires a source for a custom endpoint and checks that the selected model URLs
match that source. These paths make credential delivery determine where inference
runs. See [Compute configuration](../../docs/reference/drivers/kubernetes-compute/configuration.md),
[Harness execution](../../docs/reference/harness-execution.md), and
[source registration](../../docs/reference/credential-sources.md).

An operator should choose the same endpoint for either Harness without moving
that setting into a credential record. Switching Harnesses still requires
compatible models, native model metadata, and the existing deployment prerequisites.

## Proposed contract

The shared configuration is Installation-scoped:

```yaml
drivers:
  compute:
    configuration:
      runtime:
        modelProvider:
          protocol: openai-responses
          baseUrl: https://models.example.com/v1
```

`modelProvider` is optional. When present, `protocol` and `baseUrl` are required.
The initial protocols are `openai-responses` and `openai-completions`.
Codex requires `openai-responses`; OpenClaw uses the matching native API adapter.
Omission retains the default OpenAI endpoint and native API defaults. Custom
OpenAI URLs in Agent Configuration require a matching shared provider.
ChatGPT account authentication and unrelated providers are outside this setting.

The optional `supportsStandaloneWebSearch` boolean describes the endpoint's
Codex standalone-search capability and defaults to `false`. It does not enable
provider tools prohibited by protected execution.

The shared object replaces `runtime.codexModelBaseUrl` and
`runtime.codexModelSupportsStandaloneWebSearch`. Old configuration keys fail
validation; replace them with the shared object. There is no precedence chain or silent
fallback between old and new settings. Installation profile inputs and the
Console's read-only Driver view expose the shared object.

### Ownership and translation

Compute validates the provider configuration and renders the supported Harness
configuration. Composition passes the same validated destination to the selected
Credential Gateway or Credential Proxy implementation. OCC core continues to
use generic Driver contracts; it does not gain OpenAI-specific branches.

- Codex receives its native provider entry and qualified model selections through
  the existing model projection and runtime entry points.
- Embedded and dedicated native OpenClaw receive the selected provider URL and
  API adapter. Existing model IDs, limits, costs, and other required metadata
  remain the operator's responsibility.
- Compute translates the native default OpenAI URL to the shared endpoint, so
  existing default model metadata remains usable for a new deployment. A different
  custom URL or API adapter must agree with the shared provider; conflicts fail
  admission. Unrelated providers retain their own configuration.
- Custom dedicated native OpenClaw endpoints retain the current requirement for
  source-backed credentials. This proposal does not widen direct Secret delivery.

An endpoint change must not reinterpret an existing deployment or credential
grant. Compute records a fingerprint of the provider in its existing admission
record. Both embedded and dedicated activation paths compare it before resolving
or delivering direct-Secret credentials or changing workloads. Preparation,
retries, and recovery make the same comparison. A change between preparation and
activation is refused, including removal of the shared setting. A conflicting saved deployment fails explicitly and requires a new
authorized deployment. No URL is taken from a credential source to repair it.

### Credential destination authorization

The `openai` source catalog removes the routing field `base_url`. New requests
that contain it fail before Secret resolution or registration effects.

Sources retain a separate immutable authorization field,
`config.authorized_base_url`. This field authorizes the key's destination; it
does not select it. Omission authorizes only `https://api.openai.com/v1`.
For a custom destination, the source creator explicitly supplies the matching
authorization while registering the source with its `api_key` Secret reference.
The existing create-source and operate-Secret permissions still apply.

Registration checks the normalized authorization against the shared provider.
Attachment and protected request dispatch recheck it before credential delivery.
A mismatch fails closed. Updating Installation configuration cannot expand a
source's authorization or rewrite its gateway profile to a new destination.
Protocol and existing request-policy restrictions continue to apply.

Existing records containing `base_url` are unsupported for new inference work,
including when their value happens to match the new provider. They require
explicit replacement with destination authorization. Existing records without
that field authorize the default OpenAI endpoint only. Reading and deleting old
records remain available through the existing ownership and authorization checks.
There is no automatic data rewrite or credential redirection.

Direct Secret delivery retains its current permission and topology restrictions.
This proposal does not turn permission to operate a Secret into permission to
change an Agent's destination. The endpoint is Installation-controlled, and
conflicting Agent-authored endpoint changes are rejected.

### Validation and networking

Reuse the existing HTTPS URL normalization, credential/query/fragment rejection,
IPv4 spelling checks, and destination-policy checks. Preserve stricter
requirements of native OpenClaw and protected delivery, including their DNS,
port, and path restrictions. A shared setting does not make an unsupported
destination valid for every Harness or delivery mode.

Keep existing egress policies and warnings. Endpoint authorization does not
grant network access, establish hostname confinement for direct keys, or add
private-network, HTTP, TLS, or cluster exceptions. No live credentials are needed
to verify endpoint selection and generated configuration.

## Delivery and verification

Submit this RFC before contract code. Then implement the
[delivery plan](../plans/0028-shared-model-provider.md), preserving any human
review holds. The RFC remains Proposed until accepted through the repository
process.

Required proof covers configured and omitted cases for both Harnesses; protocol
and authored-setting conflicts; new `base_url` rejection; stored-source recovery;
authorization mismatch after an Installation change; and unchanged unrelated
credentials and egress restrictions. Extend the real Agent workflow, including
failure before credential delivery. Record fixture proof separately from actual
runtime or cluster proof. Console changes require rebuilt Storybook inspection,
screenshots, and an interaction recording.

## Alternatives and overlap

Keeping a Codex-only option is smaller but leaves the cross-Harness task unsolved.
A separately managed ModelProvider resource adds lifecycle and permissions that
this Installation-level task does not require. The planned Model Registry and
Inference Driver remain separate architectural work.

[PR #4502](https://github.com/openclaw/openclaw-enterprise/pull/4502) and
[PR #3050](https://github.com/openclaw/openclaw-enterprise/pull/3050) instead keep
source endpoints authoritative and add Agent-level endpoint selection. This
proposal intentionally differs on routing ownership while preserving
credential-to-destination authorization. It does not implement their broader
Create Agent feature or modify their branches.
[Issue #4254](https://github.com/openclaw/openclaw-enterprise/issues/4254) asks for
private Embedded gateway support; that networking expansion is excluded.
[PR #4512](https://github.com/openclaw/openclaw-enterprise/pull/4512) separates
credential types and sources; this change keeps the current binding grammar.

RFC-0028 follows the current main branch. Recheck the number before merge under
the [numbering rules](../../docs/contributing/specifications.md#files-and-numbering).
