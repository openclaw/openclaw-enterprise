---
status: Proposed
implementation_status: Implemented
author: kevinlin-openai
---

# Proposal: Harness overrides in Agent revisions

- **ID:** RFC-0030
- **Created:** 2026-11-05
- **Last updated:** 2026-11-06
- **Related:** [RFC-0028](0028-shared-model-provider.md), [PR #4528](https://github.com/openclaw/openclaw-enterprise/pull/4528)
- **Implementation plan:** [Harness overrides](../plans/0030-agent-harness-overrides.md)

## Summary

Let an Agent deployment supply Harness overrides and save both the requested
overrides and resolved settings in its immutable Agent revision. The first
supported override is `modelProvider`: the endpoint, protocol, and standalone
web-search capability used by Codex or OpenClaw. The Installation setting becomes
the default for new revisions. Credential Sources continue to authorize
destinations independently of routing.

This proposal changes RFC-0028's Installation-only routing decision and its
dependency on current Installation values during revision recovery. It retains
the shared provider shape, native translation, and credential boundaries.

## Motivation and current behavior

An operator needs two Agents in one Installation to use different
OpenAI-compatible endpoints, for example a standard service and an evaluation
service. Changing the Installation default affects admission for both Agents.

PR #4528 merged on 2026-11-04. Its reviewed head is
`c473ee1899e5114b9267d6d945f649acf75ed748`; the following behavior remains present
on main at `3136e5becd476a06bfdd8c120d4ebbd3b85e4e0a`:

- [Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts)
  selects `runtime.modelProvider` from Installation configuration.
- [Native translation](../../apps/controller/src/drivers/compute/model-provider.ts)
  rejects conflicting custom OpenAI URLs in Agent Configuration.
- [DeployAgentInput](../../packages/occ/src/index.ts) contains only namespace
  and Agent IDs. [RevisionHarnessDescriptor](../../packages/contracts/src/index.ts)
  records the Harness ID, version, and execution mode, with no overrides.
- Compute admission fingerprints the provider. A changed or removed Installation
  provider prevents preparation or activation of an earlier admission.
- Source `authorized_base_url` must match the Installation provider; it cannot
  select another inference endpoint.

These restrictions apply to OpenAI API-key inference. Other providers and
ChatGPT account authentication retain their separate paths. See the current
[provider reference](../../docs/reference/drivers/kubernetes-compute/model-provider.md).

## Goals and boundaries

Support independently configured Agents through the normal deployment workflow,
with inspectable, immutable revision settings and explicit destination consent.
Support embedded OpenClaw, dedicated OpenClaw, and dedicated Codex where their
current authentication and network contracts allow the endpoint.

Arbitrary native configuration patches, Harness image or execution-mode
overrides, new providers, routing failover, and expanded network access are
outside this proposal. Model IDs and OpenClaw model metadata remain in
Configuration. ChatGPT authentication does not accept `modelProvider` overrides.

## Proposal

### Deployment input and revision ownership

Extend `DeployAgentInput` and both ordinary and first-deployment HTTP request
bodies with optional `harnessOverrides`. The initial shape is:

```json
{
  "harnessOverrides": {
    "modelProvider": {
      "protocol": "openai-responses",
      "baseUrl": "https://evaluation.example.com/v1",
      "supportsStandaloneWebSearch": false
    }
  }
}
```

This is a proposed request-body fragment. Existing route parameters and
first-deployment intent fields still apply. Include normalized overrides in the
first-deployment intent digest; reusing an intent key with different overrides
must fail instead of returning a receipt for another destination.

Save the request as `AgentRevision.harness.overrides` and the resolved settings as
`AgentRevision.harness.configuration`. Both are immutable, nonsecret objects
owned by the selected Compute Driver's Harness contract. OCC transports these
objects through its generic deployment lifecycle; Kubernetes Compute defines
and validates the supported `modelProvider` fields. Unsupported keys, invalid
types, and unsupported Harness/authentication combinations fail admission.
Compute implementations without override support reject a nonempty request.

The provider object replaces the whole default object. Require `baseUrl` and
`protocol` together; omitted `supportsStandaloneWebSearch` means `false`, even
if the Installation default declares `true`. Do not deep-merge endpoint
capabilities from another provider. An omitted or empty `harnessOverrides`
inherits the Installation default at admission. If neither supplies a provider,
resolve OpenAI's default endpoint and the selected Harness's existing native
protocol and capability defaults. Reject `null`.

A new ordinary deployment with omitted overrides uses current defaults; it does
not implicitly reuse the previous revision's overrides. Console shows a requested
URL or an inherited-default label and captures the controls at submission. Console
and CLI submit directly to deployment admission and explicitly submit retained
overrides when redeploying. There is no separate resolution endpoint or provisional
CLI output: the admitted revision is the source of resolved settings. Automated image upgrades must carry the selected
revision's requested overrides into the new deployment. Retrying or recovering
an already admitted revision uses that revision's resolved settings.

### Admission and execution

Resolve provider settings once, before credential attachment, egress planning,
or workload effects. Extend the existing Compute preparation/admission contract
to return the resolved Harness settings and pass them to Credential Gateway and
Credential Proxy admission. Do not read process-wide provider defaults again
inside those operations.

OCC authorizes the caller's exact Agent deployment and the referenced resources
under existing IAM rules. Within its existing admission transaction, it saves
the requested overrides, resolved settings, credential snapshots, and egress
plan with the revision and records attributable audit evidence. Revision reads
expose the requested and effective provider under existing revision permissions.
No credentials or secret values are stored in Harness settings or audit data.

Compute fingerprints the resolved revision settings. Preparation, activation,
retry, and recovery validate that snapshot and use it for native rendering,
credential destination checks, and runtime probes. A change to the Installation
default affects future admissions only. Missing, malformed, or unsupported
saved settings fail explicitly before credential delivery or workload mutation;
execution must not reconstruct them from current defaults. Existing runtime
admission and cleanup facts remain available for withdrawal and deletion.

Codex continues to require Responses and authenticated app-server transport;
its Gateway retains the fail-closed HTTP URL. OpenClaw's authored custom URLs and
protocols must match the resolved provider, and native default URLs can be
translated as today. Capability overrides do not enable tools forbidden by
protected execution. An unavailable endpoint causes the existing deployment or
runtime failure; it does not trigger fallback to the Installation endpoint.

### Credential destination consent

An Agent override must not redirect a credential authorized for another
destination. In this initial scope, an explicit provider override requires
source-backed API-key authentication. Direct Secret authentication keeps the
existing Installation-controlled path; expanding its destination consent is a
separate decision.

Allow source registration for a validated `authorized_base_url` that differs
from the Installation default. The source creator still needs the existing
create-source and operate-Secret permissions. Omission authorizes only OpenAI's
default endpoint. Source authorization remains immutable and never chooses an
Agent's route.

Update source registration and predeployment attachment validation so they do
not require equality with the Installation default. Before a binding can serve
inference, compare its authorization to the resolved revision destination,
including scheme, host, port, and path after existing normalization. Apply the
same check to protected dispatch, refresh, retry, and recovery. A mismatch fails
before credential delivery. Credentials for another endpoint require a
separately authorized source and a new deployment.

Gateway registration may describe the source's authorized destination, but
Compute and proxy inference routing consume the resolved revision destination.
The Credential Proxy must admit and retain that destination in the revision's
egress plan. Multiple Agents and sources with different destinations must
coexist without mutating shared provider state or retargeting registered copies.
Keep exact Agent/source grants and withdrawal behavior intact.

Reuse current URL validation, DNS and port restrictions, native OpenClaw source
requirements, and network policy enforcement. An override neither grants egress
nor permits a new private-network, HTTP, or TLS exception.

## Delivery and verification

Submit this RFC for human review before changing Driver contracts. Prepare a
separate implementation plan for the cross-Driver work after submission. Update
the deployment API, revision storage and decoding, Console and CLI callers,
Compute, Credential Gateway, and Credential Proxy together. Keep the current
provider reference, deployment guides, runtime flows, and generated API
documentation synchronized with implementation.

Extend integration coverage at the normal Agent deployment boundary:

- Deploy two Agents to distinct authorized endpoints while a third inherits the
  Installation default. Verify native rendering and observable provider requests
  for each supported Harness topology.
- Change and remove the default after admission, including between preparation
  and activation. Existing revisions retain their destinations; new admissions
  inherit the new default. Exercise restart and retry from PostgreSQL state.
- Reject mismatched source authorization, missing grants, direct-Secret
  overrides, invalid URLs, unknown fields, conflicting native configuration,
  and Completions with Codex before credential delivery or workload changes.
- Verify first-deployment intent conflicts, explicit override retention on
  upgrades, and failure without fallback when an endpoint is unavailable.
- Prove protected refresh and dispatch isolation, source withdrawal, and cleanup
  with concurrent Agents using different endpoints. Preserve unrelated-provider
  and ChatGPT behavior. Inspect Console requested destinations, admission refusals, and revision details
  with the required Storybook screenshots and interaction recording.

Use real supported dependencies for integration proof. Distinguish HTTP fixture,
PostgreSQL, live-cluster, and model-turn evidence; generated configuration alone
does not prove runtime routing. The [implementation plan](../plans/0030-agent-harness-overrides.md)
records delivery and verification limits. Current behavior is owned by the
[provider reference](../../docs/reference/drivers/kubernetes-compute/model-provider.md).

## Rationale and alternatives

Keeping Installation-only routing requires a separate Installation or a global
configuration change for each endpoint. Source-owned routing confuses permission
to deliver a credential with selection of its destination. Arbitrary native
patches create competing paths around Compute's validation. A ModelProvider
resource or model router adds lifecycle that this task does not need.

Revision-owned settings make the deployment request explicit and recovery
deterministic. The tradeoff is that changing an Installation default no longer
stops an older admission through fingerprint mismatch. Operators must stop the
Agent or withdraw its credential authorization to revoke access; a default
change is not a revocation operation. Maintainer review must approve this
lifecycle change and the source-backed-only scope for explicit overrides.
