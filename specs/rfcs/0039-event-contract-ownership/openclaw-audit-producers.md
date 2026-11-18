---
rfc: ./index.md
---

# Protect OpenClaw audit producers

## Required outcome

An Installation administrator enables audit once. Users then deploy and chat
with OpenClaw Agents through the usual steps. The Agent audit API shows the
session, turn, and model-request records that the protected runtime observed.
OCC manages audit credentials during revision deployment and retirement.

Dedicated OpenClaw keeps sessions and transcripts in its Gateway. Its worker
normally makes model requests locally. The Gateway can report turns that it
observes. To report a worker-local model request, OCE needs a trusted component
at the request boundary. Embedded OpenClaw runs the harness inside the Gateway
and shares the Gateway’s identity and storage. Agent-controlled code in that
boundary can use credentials available to the Gateway. [Harness execution](../../../docs/reference/harness-execution.md) · [Runtime isolation](../../../docs/reference/security/runtime-isolation.md)

## Proposed boundary

The Compute Driver selects and configures a qualified producer as part of the
admitted revision. Agent authors continue to select their existing Harness and
model configuration. When audit is enabled, the deployment verifies the
required isolation before it registers a producer. OCC authenticates that
producer for the exact revision. The producer uses the existing audit API and
PostgreSQL ledger.

### Dedicated OpenClaw

Keep the current Gateway as the session and turn producer. Put model-request
reporting at a protected provider connection that sends the actual request and
receives its result. Reuse the selected Sandbox and Credential Proxy where
they enforce that connection. For another supported provider path, qualify an
equivalent protected connection before advertising model-call coverage. The
model credential remains under the Harness credential contract. [Protected inference](../../../docs/reference/credential-sources/protected-inference.md)

The protected connection sends its observations to the Gateway over a
revision-bound channel. The Gateway sends the audit events to OCC with its
existing audit credential. The model path and Agent tools have no access to
that credential.

Associate a provider attempt with a turn only when the provider connection can
verify the execution reference. A value supplied by Agent code can identify a
request for diagnostics. It cannot establish audit authority. A retry that
makes a new request has a new attempt ID. Delivery of the same observation
keeps its original event ID.

### Embedded OpenClaw

Keep the Gateway and OpenClaw turn runner together. Isolate Agent-controlled
tools and extensions from that process and its audit credential. The trusted
runner reports the turn start and result where it executes them. A protected
provider connection reports model requests and outcomes. Apply these hooks to
chat and supported background turns.

A separate process that only accepts claims from the Agent cannot establish
whether a turn happened. The supported isolation profile must protect both
the credential and the code that observes the turn. Identify which approved
in-process extensions belong to the trusted runtime before qualifying a
profile. Any other extension needs an execution boundary that preserves its
supported behavior and protects the producer.

## Decisions for review

- Compute and Sandbox owners specify how the embedded profile isolates
  tools and extensions while preserving supported Agent behavior.
- Harness and Credential Proxy owners select the protected provider connection
  and define the execution reference that binds an attempt to a turn.
- Audit and Compute owners define how enablement reports unsupported profiles
  and how required writes fail when the audit service is unavailable.

Changes to required Driver behavior need a submitted RFC that covers the
selected contracts before implementation. This proposal describes the
required boundary. The owners still need to select and review its interfaces.

## Acceptance criteria

1. On an installed deployment, enable audit once. Deploy and chat with a
   dedicated OpenClaw Agent and an embedded OpenClaw Agent. Repeat after each
   Agent has a new revision. Authorize a reader and retrieve the session, turn,
   and model-request records for each revision through the Agent audit API.
2. Verify that Agent-controlled tools and extensions have no access to trusted
   audit credentials. Verify that OCC refuses a producer for another revision.
3. Cancel a turn, interrupt a producer, and retry delivery. Verify observed
   outcomes, preserved event IDs, and the absence of a completion record when
   the producer stopped before it observed a result.
