# Implement a Credential Proxy Driver

Start with the [Credential Proxy contract](../reference/drivers/credential-proxy.md)
and choose a delivery profile that your backend can enforce. This guide connects
one package's Sandbox and Credential Proxy capabilities to the normal Agent
workflow. You will register the pair, implement installation and request
handling for the chosen profile, and then qualify those guarantees through a
real Agent and backend. An implementation does not need to use OpenShell.

## 1. Choose the enforcement boundary

Decide whether the transport owns request-time resolution and response custody,
or installs prepared repository material into a verified recipient. The public
repository authority supports Git and GitHub installation profiles; it is not a
generic credential installation service. Document which guarantees your backend
provides before selecting it.

Follow the contract's [ownership boundaries](../reference/drivers/credential-proxy.md#overview).
Installed material and request-time exchange require different evidence.

## 2. Return one registration

Follow the [package loader contract](../reference/drivers/selection.md#package-identity-and-factory-exports)
for schema, validation, ESM packaging and exact dependency pinning. The factory
returns `DriverRegistration` with `capabilities.sandbox` and
`capabilities.credential_proxy`. Both use the supplied ID and implementation.
Place shared `computeLifecycleHooks` and optional `close()` on the registration,
not on either capability object.

The smallest implemented non-OpenShell example is the
[protected-execution fixture](../../tests/fixtures/driver-packages/protected-execution-driver/index.ts).
Its `createDriver` has an explicit `DriverRegistration` return type. Follow its
single factory, shared configuration and paired capability shape. It reads
installation evidence through an authenticated TLS peer and implements the
startup release handshake. It deliberately rejects operations outside its
deny-all profile and uses a placeholder provider. It is a fixture, not a complete
production Driver or evidence of credential delivery.

Select the package once under `drivers.sandbox.package`; put configuration under
`drivers.sandbox.configuration`. Select the same ID under
`drivers.credential_proxy.id` with empty proxy configuration. Keep bundled
Kubernetes Compute for the current protected release path. API and worker load
separate process instances of this same registration; they compare the admitted
ID, implementation and configuration digest.

## 3. Implement preparation and release

Implement `configureRevision` to produce nonsecret configuration for exactly the
admitted plan. Have the paired Sandbox install that configuration before
`wiringStatus` returns evidence. Query authenticated enforced state, including
execution, policy and recipient identity; desired state is insufficient.

Implement `verifyInstallation` as a new counterpart query. Compute calls it
around committed installation custody and Sandbox enrollment, and checks current
custody inside the fresh startup challenge. A stored receipt alone cannot release
work. Follow [ProtectedExecutionDriver](../../apps/controller/src/drivers/compute/protected-execution-driver.ts)
for the actual `configure`, `observe`, `enroll`, `current` and `verify` checks.

Implement removal for owned resources and return incomplete results honestly.
Keep deny-all effective when no routes remain. If advertising `policyReduction`,
implement persistent compare-and-reduce operations and independent observation;
stale enrollment must not restore withdrawn access. Use the contract's
[withdrawal and uncertainty rules](../reference/drivers/credential-proxy.md#cancellation-retries-and-uncertainty).

## 4. Bind the selected transport

For request-time delivery, implement `bindExchange` before accepting traffic.
Follow the contract's [request-time exchange ordering](../reference/drivers/credential-proxy.md#request-time-exchange),
live transport custody, deadlines, response protection and uncertainty requirements.

For prepared repository delivery, implement `bindRepositoryGit` and Sandbox
`repositoryAccess`. The larger
[non-OpenShell repository fixture](../../tests/fixtures/driver-packages/protected-execution-driver/repository-git.ts)
stores material in its loopback sender and reads back the attempt and version
over authenticated HTTPS before confirming. Its capability listener is separate;
its installation endpoint reads the sender's own in-memory state. A real Driver
must obtain evidence from the actual enforcing recipient, independently of the
write acknowledgment. OCC cannot make that observation on the Driver's behalf.
The fixture then authorizes a captured request once and checks exact-dispatch
deadlines before connecting and again after TLS setup, before writing.

That fixture confines origins to controlled loopback HTTPS peers. Its direct
upstream response pipe is not an implementation of the stronger exchange
response-custody profile. Do not copy its test controls or treat it as production
qualification. Use its public authority calls as the example, not its simulated
placement or provider behavior.

## 5. Exercise the normal Agent path

Configure the selected pair through Installation composition. Create an Agent
with the supported credential source or repository binding through the normal
API. Admission records the registration and profile; the worker prepares the
revision; Compute observes, records and verifies its installation before Sandbox
release. The Agent's ordinary client then reaches the selected sender without
receiving provider credentials. Use the [operator setup](../guides/credential-proxy.md)
to follow the source or repository binding through deployment and withdrawal.

For a repository request, correlate the Agent revision, observed recipient,
installation fence, preparation attempt, material version, request digest and
exchange decision. After renewal, require the newly confirmed version before
use. After restart, reject stale execution evidence and retain unresolved
installation or send outcomes. Merely invoking `authorize` in a standalone test
does not prove this workflow.

## 6. Qualify the backend

Use the existing [exchange checks](../testing/static-egress.md#check-a-credential-proxy-change)
and [repository workflow checks](../testing/protected-repository-custody.md#check-useful-git-work-and-conversation-continuity)
as starting points. Their owning testing pages specify prerequisites and explain
what the fixtures prove. Extend relevant conformance and integration coverage
through the real Agent caller for a new implementation.

Require real backend evidence for installation, renewal, withdrawal while a token
is still valid, stale execution refusal, restart and uncertain installation/send
outcomes. Verify that a second client or replacement process cannot claim another
exchange's response. Independently test direct network bypass and withheld
responses, including trailers. Successful registration, mock decisions or a
matching policy hash cannot establish these backend guarantees.

Record the tested build, profile and remaining gaps. Keep detailed qualification
procedures under `docs/testing/`; keep backend setup and diagnostics in its own
implementation page. Link those pages from the contract once the implementation
is available.
