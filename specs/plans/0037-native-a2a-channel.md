---
rfc: ../rfcs/0037-native-a2a-channel.md
---

# A2A channel delivery and qualification

- **ID:** RFC-0037 implementation plan
- **Status:** Planned
- **Decision:** [A2A channels for dedicated Agents](../rfcs/0037-native-a2a-channel.md)

## Outcome and prerequisites

An operator deploys a dedicated Agent through OCC and exchanges text tasks with a
configured external A2A peer. The RFC owns the required behavior and AC-1 through
AC-5. No implementation or runtime qualification is complete.

Submit the Driver configuration proposal for human review before changing code.
Resolve routing and destination-enforcement ownership with the selected Driver
maintainers. Use existing Configuration, Agent revision, Secret binding, routing,
and network-policy primitives; do not create a parallel invocation service.

## Owners and ordered work

1. **Compute admission and Secret projection (AC-1, AC-4).** Extend
   [`configuration-rules.ts`](../../apps/controller/src/drivers/compute/kubernetes/configuration-rules.ts)
   and the [Kubernetes implementation](../../apps/controller/src/drivers/compute/kubernetes/index.ts).
   Admit the native A2A shape for dedicated execution, validate explicit peer and
   agent scopes, and authorize token bindings through the existing Secret path.
   Refuse unsupported configurations during save and deployment preflight.
   Preserve existing channel behavior. The supported caller is Configuration
   save followed by Agent creation and deployment through OCC.
2. **Routing and channel networking (AC-2 through AC-4).** Extend the owning
   Driver contracts through the reviewed design. Add per-Agent HTTPS A2A routes,
   separate explicit inbound exposure from outbound-only configuration, and
   enforce admitted peer destinations. Preserve Authorization for native peer
   authentication. Keep runtime-specific behavior inside Drivers. Missing route
   support or destination enforcement must refuse admission.
3. **Revision lifecycle (AC-5).** Integrate route creation, cutover, token
   rotation, and stop with the existing revision workflow. Check that an invalid
   candidate leaves the serving revision available. Surface native task loss
   after replacement without retrying an uncertain tool-bearing task.
4. **Connected proof and documentation (AC-1 through AC-5).** Extend the real
   Agent workflow in
   [`qa-matrix-real.test.mjs`](../../tests/integration/qa-matrix-real.test.mjs),
   and register scenarios and prerequisites in the
   [QA manifest](../../scripts/ci/test-suites/qa-matrix.json) and selection helpers.
   Update the selected CI lane using the
   [local development workflow](../../.agents/skills/local-dev/SKILL.md#add-integration-tests).
   Update the owning Compute/routing references, operator channel guide, and
   source-backed runtime flow in the implementation PR. Do not document the
   proposal as current support.

## Qualification and recovery

Use a disposable loopback cluster with enforcing NetworkPolicies and a dedicated
test database, following [Kubernetes testing](../../docs/testing/kubernetes.md).
Supply authorized model credentials and synthetic peer tokens without logging
their values. Pin the real runtime by digest and run a real peer process; protocol
mocks do not establish native task exchange or network isolation.

Record each acceptance criterion's command, source revision, runtime digest,
observed result, and relevant denial evidence. Include genuine inbound and
outbound turns, token rotation, wrong-peer task polling, denied destination
probes, stopped-Agent access, and replacement during work. Keep tenant data and
credentials out of published evidence. Remove only run-owned fixtures.

Required runtime/plugin availability, route implementation, enforceable peer
egress, and disposable infrastructure remain implementation prerequisites. An
unrun or skipped criterion stays incomplete. Source checks or a successful
protocol fixture do not qualify AC-2 through AC-5.

## Change record

- 2026-11-11: Initial plan from source inspection at upstream `9ff173b40`.
  Delivery remains Planned; no runtime acceptance criterion has run.
