---
status: Proposed
implementation_status: Not implemented
author: sunnymodi
---

# Proposal: Custom OpenAI-compatible endpoints for native OpenClaw

## Problem and decision

A user deploying dedicated native OpenClaw can register an OpenShell `openai`
CredentialSource with a custom endpoint, but Kubernetes Compute rejects every
native model endpoint except `https://api.openai.com/v1`. OpenShell also rejects
that source for native OpenClaw. This prevents using an OpenAI-compatible model
service such as Fireworks through the regular Agent deployment workflow.

Allow the existing `openai` provider alias to use a configured HTTPS endpoint on
TCP 443 with a path ending in `/v1`. Preserve each model's normalized endpoint in
the native worker configuration. For OpenShell, require every native model in the
catalog to use the bound CredentialSource endpoint, including its path.

This extends the implementation behavior of the existing Compute and Credential
Gateway Drivers. It adds no Driver interface, source type, provider ID, API
protocol, credential mechanism, or platform-core special case. Existing supported
API selectors and explicit model metadata remain required.

## Ownership and trust

Kubernetes Compute owns model admission and worker configuration. Its existing
endpoint normalizer rejects credentials, queries, fragments, wildcards, malformed
hosts and paths; native admission also rejects non-443 ports and ambiguous IPv4
spellings. Existing NetworkPolicies continue to bound model egress. Selecting a
custom endpoint does not grant access to a private-network model service.

The OpenShell Credential Gateway owns source registration and attachment. Before
attaching a native model source, it compares the entire catalog with the immutable
source endpoint and fails closed on a mismatch or missing endpoint. The existing
Sandbox provider substitutes the key only on its bound endpoint. The worker
receives an opaque `OPENAI_API_KEY` placeholder, and the Gateway receives no model
key. Source authorization, ownership, withdrawal and cleanup remain governed by
[RFC-0016](0016-sandbox-credential-injection/index.md).

No change to Agent tool permissions, required-worker placement, sandbox readiness,
or isolation policy is proposed. A worker must create its temporary files beneath
a private child of `TMPDIR`, preserving the Sandbox's shared temporary directory.

## Delivery and verification

1. Extend existing Driver admission and credential-source API tests to cover a
   custom host and nested `/v1` prefix, both supported API selectors, malformed
   endpoints, and source/catalog mismatches.
2. Extend the existing dedicated-native OpenShell real-runtime workflow with a
   custom endpoint. Require a genuine model response from the enrolled worker;
   admission fixtures and a schema smoke alone do not prove model execution.
3. Verify native runtime startup with a root-owned shared temporary directory,
   provider enrollment files and the configured API selector. Update the owning
   references and source-backed execution flow.

The accompanying implementation must record exact checks and missing runtime
prerequisites. Local development proof does not establish production qualification
or qualify a new default runtime image. No image pin or publication is proposed.

## Alternatives and open decision

Keeping the OpenAI-only restriction excludes compatible services even when their
source is endpoint-bound. Adding vendor-specific provider IDs would duplicate
protocol support and expand authentication contracts unnecessarily. The proposed
alias reuses the existing protocol and credential boundaries.

Maintainers must review whether this endpoint admission boundary is sufficient
for dedicated native OpenClaw. The proposal remains unaccepted until that review.
