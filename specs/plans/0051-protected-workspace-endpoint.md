---
rfc: ../rfcs/0023-egress-proxy-credential-lifecycle/index.md
---

# Implementation plan: protected workspace endpoint

- **ID:** TASK-0051
- **Delivery status:** Planned
- **Owner:** OCE contributors
- **Authority:** [Proposed endpoint amendment](../rfcs/0023-egress-proxy-credential-lifecycle/protected-workspace-endpoint.md)

## Outcome and scope

The normal first deployment pins its original protected Harness endpoint, obtains
an acknowledgment from the loaded Gateway consumer, and then reaches the existing
signed release. Activation reads the retained original rather than interpreting
reduced status inputs as new launch requirements. The amendment owns AC-1–5.

Initial support must preserve a serving predecessor. A deployment that would
replace that Gateway before its successor can acknowledge the binding fails with
a typed unsupported-transition error. Revision cutover needs a separately verified
ordering; it must not acquire an extra Gateway or replace a live one implicitly.

## Contract and source touchpoints

- `packages/contracts/src/drivers/sandbox/index.ts`: optional versioned observers.
- `apps/controller/src/drivers/compute/kubernetes/index.ts`: admission, immutable
  pin, Gateway binding, acknowledgment checks, activation and original cleanup.
- `apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts`: forward
  live consumer metadata through the existing authenticated private status path.
- The compatible Gateway consumer: fixed trust directory, mandatory protection,
  currentness checks and authenticated `codex.protectedWorkspaceBinding` RPC.
- The selected Sandbox: original launch context, exact owner/generation checks,
  typed failures and existing signed enrollment. Preserve permission selection.

## Implementation

1. Validate the complete selected registration and protocol before material access.
   Preserve ordinary revisions. Select a distinct Compute implementation for a fresh Installation and qualify
   its early older-reader refusal; a new admission marker alone is not proof.
2. Preserve the first model-disabled Gateway for authenticated node setup. Save
   bootstrap phase on the original anchor, then atomically pin the endpoint and
   change to bound before replacing that same revision's template. Reject
   replacement, missing state after first choice and uncertain writes.
3. Mount the fixed binding and require the actual consumer acknowledgment before
   enrollment. Do not infer it from file presence or a wrapper-generated hash.
4. Keep existing signed enrollment, node identity, serving and workspace checks.
   Require the same acknowledged original around status reads and at activation.
5. Update the Sandbox reference and owning Harness topology flow. Register the
   real installed scenario and its explicit prerequisites in the QA matrix.

## Verification

The following checks are required before delivery. This plan does not establish
implementation or installed qualification.

| Required outcome                                                    | Real check and prerequisites                                                                                                                | Status  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Live status forwarding, invalidation and startup failure precedence | Emitted HTTP status server with changing acknowledgments, malformed replies, transport failures and startup failure races                   | Pending |
| Exact pin and release ordering                                      | Compute workflow and real Kubernetes API persistence, including restart, conflicting first choices and uncertain writes                     | Pending |
| Actual consumer guards and reload invalidation                      | Qualified Gateway image at the normal workload UID, authenticated RPC and fixed immutable binding; reject stale acknowledgment after reload | Pending |
| Old-reader refusal before material                                  | Exact older Worker dispatch and installed image with incompatible revision identity; reject before Secret or material calls                 | Pending |
| Same Agent, real node and volume, model and withdrawal              | Genuine connected installer, exact API/Worker entries and controlled providers; verify the same Agent and workspace                         | Pending |

## Native Service route follow-up

The [proposed route extension](../rfcs/0023-egress-proxy-credential-lifecycle/protected-workspace-endpoint.md#native-service-route-extension)
owns AC-6–8. Implement the endpoint binding above before enabling this profile.
The first scope is a fresh protected dedicated Codex revision in one cluster;
ordinary routes and the existing static bridge retain their behavior.

1. Add the closed `network.providerHarness: { mode: "owned-service-v1" }`
   variant to the existing configuration identity. Qualify older loader and
   constructor rejection before material delivery or provisioning. Preserve
   existing absent, static and ordinary selections.
2. Keep bootstrap Harness egress closed. After the selected Sandbox provisions,
   observe its Service, Pod and EndpointSlice through the current cluster client.
   Use the validated route for policy and Gateway rendering without writing
   observed addresses into Installation configuration.
3. Extend the durable endpoint pin with the first route. Revalidate it before
   policy installation, consumer acknowledgment, release and activation. Preserve
   that choice across restart and uncertain writes. On invalidation, revoke the
   affected grant and retain the first failure and original cleanup obligation.
4. Extend the existing Compute workflow and real Kubernetes integration checks
   for AC-6–7, including absent and static profiles, harmless Pod status changes,
   ownership replacement and incomplete observations. Register AC-8 in the
   installed Agent workflow, with actual allowed and denied traffic and the same
   node, revision and mounted workspace through a controlled model turn.

These checks remain required and unrun by this proposal. A renderer, validator
or controlled API result alone does not establish installed route qualification.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-13: Propose the endpoint protocol, implementation owners and required runtime verification.
- 2026-11-13: Propose the owned-Service route profile, its implementation order and required verification.
