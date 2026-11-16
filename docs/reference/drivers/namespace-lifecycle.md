# Namespace Driver lifecycle

A selected registration can expose `namespaceLifecycleHooks.ensureNamespace` and
optional `deleteNamespace`. Single-capability Drivers can expose the same hooks.
Installed packages put them on `DriverRegistration`, not capability views.
Invalid hooks stop selection. A multi-capability registration participates once;
unselected registrations do not run.

OpenClaw Control Plane (OCC) first asks Compute to ensure infrastructure, then invokes participants in
registration-ID order. Context contains an immutable logical Namespace and the
operation's `AbortSignal`. Each result names that exact Namespace and reports
`namespaceReady` or `namespaceDeleted`, with optional `retryable` or `permanent`
failure. Pending or failed setup blocks readiness and later participants. Retries
start from Compute; completed effects must be safe to repeat. OCC performs no
automatic compensation. A lost claim stops further hooks and state commits.

For deletion, Compute checks eligibility before any participant effects. OCC
then runs deletion hooks in reverse order before Compute teardown. Incomplete
cleanup blocks deletion. Compute implementations used with cleanup participants
must implement `checkNamespaceDeletion`. When Compute confirms an external backing
namespace was never claimed, it can return `skipParticipantCleanup: true`. OCC then
runs only Compute teardown, which retains that backing namespace and touches only
Compute-owned resources. An omitted flag requires participant cleanup. Hooks cannot grant IAM permissions or
change resource state. The worker retains original-actor authorization and
records sanitized participant outcomes with its lifecycle evidence.

Composition adapts Sandbox setup and cleanup using
`ComputeDriver.resolveSandboxNamespaceContext`. This read-only resolver supplies
the selected runtime client and backing namespace; logical `default` does not
select Kubernetes' `default`. No provider dispatch occurs inside Compute.
See the [worker flow](../../flows/controller-worker.md).
