---
rfc: index.md
---

# Native supervisor enrollment and held startup

## Proposed decision

Extend [RFC-0023](index.md) with an OCE-issued native supervisor identity and a
fresh, authenticated startup acknowledgment. This amendment is proposed and not
implemented. Submit it for human review before changing Driver contracts.
Ordinary native execution remains unchanged; protected admission remains refused
until the complete path is available.

OCE owns execution identity, grants, provider login, token preparation and token
custody. Box owns containment, the association with its live workload, and the
exclusive handoff of locally permitted requests. Box does not authenticate a
ChatGPT account. Provider login is outside this enrollment protocol.

The existing [protocol](protocol.md#establish-protected-execution) already requires
supervisor key enrollment, held startup, execution-bound request capture and
stale-peer rejection. This amendment selects the missing native trust transport,
issuance lifecycle and acknowledgment. It does not weaken exact dispatch or the
separate online-authorization profile.

## Existing deficit and integration points

The native [StrandsBoxSandboxDriver](https://github.com/openclaw/openclaw-enterprise/blob/c7d00d7486a91de8e40d47573ec7d78fbec8690d/apps/controller/src/drivers/sandbox/strands-box.ts)
implements Sandbox only. Installation
selection and `provisionHarness` refuse protected requirements. Its resource
renderer launches `outer.mjs`, which starts ordinary Box immediately.
[ProtectedExecutionDriver.enroll](../../../apps/controller/src/drivers/compute/protected-execution-driver.ts)
already observes, verifies and records an
installation before invoking `SandboxDriver.enrollHarness`. Reuse that caller.

The protected launcher calls `strands_box::run` with an exclusive
`RequestExchange` and a fallible `on_ready`. The callback runs after hardening,
inside the Box runtime. It currently loads fixed installation files, checks the
origin pin and initializes the sender. File loading is not enrollment. Move its
transition to a usable sender behind the protocol below. Keep its empty adapter
refusal and fixed executable selection; never select protection from workload
arguments or environment.

OCE's [signComputeExecutionRelease](../../../apps/controller/src/drivers/compute/egress-enrollment.ts)
supplies release signatures. Its
`OpenShellExtensionJwtVerifier` verifies pinned issuer signatures, and
`OpenShellEgressIdentity` checks exchange-key possession and response custody.
Reuse the cryptographic encoding and verification where compatible, through
implementation-neutral owners. Neither verifier issues a native identity.
Provider-token issuance is a separate authority and must not issue supervisor
certificates or reuse its signing key for them.

## Trust bootstrap and issuance

For the Kubernetes native implementation, project a short-lived, Pod-bound
ServiceAccount token with an OCE-enrollment-only audience into the supervisor
container. Do not mount it, its directory, or an equivalent identity into the
workload. Disable automatic token mounts. The enrollment endpoint requires TLS
with a pinned OCE trust root. The token grants enrollment access only, never
provider access or direct request authority.

OCE validates the token with Kubernetes TokenReview for the selected cluster and
exact audience. It checks the authenticated Pod UID and ServiceAccount against
Compute's persisted provisioning record and live Kubernetes object. It verifies
the expected namespace, execution, immutable image/configuration inputs and
supervisor-only projection. Labels, a submitted Pod UID, the ordinary Harness
bearer and a locally generated certificate cannot establish this binding.
Cluster admission and node/container isolation are explicit trust assumptions;
an installation without these guarantees must refuse this profile.

Inside the hardened callback, the supervisor generates a new Ed25519 key and
random instance ID for every process start. Keep the private key in private
memory or supervisor-only temporary storage. A process restart must not adopt a
predecessor key from a persistent volume or shared Secret.

OCE creates a single-use, 256-bit challenge with a 60-second expiry, tied to the
authenticated Pod, execution and pending enrollment generation. The supervisor
signs canonical, versioned bytes containing the challenge, public key, instance,
execution, sandbox ID, sender generation, loaded configuration digest, effective
policy digest and workload-association ID. Use a dedicated enrollment domain,
distinct from request signatures and Compute releases. Specify the byte encoding
with shared test vectors before implementing either peer.

The trusted Box callback must report the configuration and effective policy it
actually loaded and identify the held workload/transport. A digest of a requested
file alone is insufficient. If the current callback cannot provide that report,
extend the native host adapter contract; do not synthesize evidence in OCE.

OCE compares the report with the admitted plan and expected host inputs. In one
fenced transaction it consumes the challenge, invalidates the prior generation,
and records the pending key and association. It issues a purpose-restricted,
short-lived endorsement containing these fields, issuer, audience, key ID and
expiry. The configured OCE issuer key is pinned by the authority. Enrollment
alone conveys no material-read or send permission.

## Held startup and acknowledgment

The proposed states are `held`, `enrolled`, `released` and `retired`. OCE persists
the generation and transition identity. The supervisor holds the workload while
OCE verifies policy and material readiness through the existing protected caller.

`enrollHarness` obtains a fresh startup ID from that supervisor and invokes the
existing Compute release callback. Extend the signed release binding, if needed,
to cover the pending generation, workload association and both digests. The
supervisor verifies the pinned Compute signature, expiry and exact binding, then
signs an ACK over the release digest and startup ID with its enrolled key.

OCE verifies this ACK and atomically records the same generation as released.
A signed activation receipt for that committed transition lets the supervisor
leave the callback and start the held workload. The authority rejects material
access until the generation is released. A valid release without ACK, or ACK
without committed activation, cannot start work. Compute reports readiness only
after the ordinary authenticated Harness serving check also succeeds.

Lost replies are resolved by authenticated inspection of the same transition,
not by allocating another generation or blindly repeating startup. Inspection
may return the same activation receipt only to the same enrolled instance.
Timeout, cancellation, mismatched fields or unavailable authority keep startup
held and ultimately terminate that attempt. None selects ordinary execution.

## Rotation, withdrawal and request custody

Renew an endorsement only while OCE confirms the current execution, key, host
association and policy. Renewal does not extend a grant. Rotate the issuer key
through an explicit pinned verification-key set; remove retired keys after all
permitted endorsements expire. No trust-on-first-use key discovery is allowed.

A supervisor restart, Pod replacement or exchange-key rotation creates a fresh
held generation. OCE fences the previous generation before activating its
successor. A late ACK or issuance result cannot restore it. Controller restart
recovers these fences and pending transitions from durable state. Withdrawal
blocks renewal and new access immediately according to the existing authorization
contract; retirement closes old channels and rejects their response delivery.

Keep the existing request protocol: Box first permits the operation, then hands
one immutable request and its original downstream association to the exclusive
sender. OCE checks current authority before material access and before the final
write. The sender consumes one permit on the same authenticated origin connection
and returns only the protected response to that initiating association. Check
current generation during response protection and immediately before downstream
delivery. A successor cannot inherit an old connection or reply.

A final permit already released before withdrawal retains only its existing
finite send deadline; enrollment adds no stronger recall guarantee. Possible
provider dispatch followed by lost reply remains uncertain and cannot be retried
automatically. Missing sender, authorizer or identity permits no direct route,
ordinary sender fallback or credential projection into the workload.

## Contract scope and delivery

Keep one selected InstalledDriver owning Sandbox and Credential Proxy. Add the
issuer and enrollment state to OCE's protected execution lifecycle, not Box or
provider-login code. Concrete Kubernetes authentication belongs in the native
Driver; generic lifecycle code consumes verified associations. The new endpoint,
persisted generation transitions, host report, ACK and activation receipt are
contract changes requiring this amendment's submission before implementation.

Implement as a separate change after submission: issuer/state and native host
report; protected Driver composition and supervisor-only projection; held
callback/release/ACK; request and response fencing. Update the existing runtime
flow and references with that implementation. Keep ordinary selection and its
launcher unchanged. Enable no profile before all required pieces work together.

The Git owner consumes the same enrolled recipient and OCE-owned material
lifecycle. This amendment grants no Git capability: the supplied sender supports
only the admitted Responses route. Git and GitHub operations need their own
real request handoff and authorization coverage. The integration owner must use
the same reviewed Box tree for launcher, gateway and containment trampoline.

## Required verification and alternatives

Exercise normal provisioning through the actual Driver and hardened callback.
Tests must use independent expected values and controlled origins, with no real
provider credentials. Require:

- Allowed enrollment and one protected operation; ordinary provisioning still
  works without an issuer or enrollment configuration.
- Wrong execution, audience, Pod UID, key, configuration or policy digest refused
  before activation, material resolution or workload traffic.
- Absent, forged, expired and replayed ACK refused; lost ACK/activation reply
  inspected without duplicate start.
- Replacement and concurrent enrollment race: only the committed generation
  activates; old open channels, queued requests and delayed replies are refused.
- Token and key renewal, issuer-key retirement, controller restart and withdrawal
  preserve fences and never broaden grants.
- Projection inspection plus installed isolation proof: workload cannot read
  bootstrap identity, exchange key or provider material, or use a bypass route.
- Withdrawal between material lookup and final authorization produces zero
  attributable application bytes at the controlled origin, on fresh and reused
  connections; possible prior dispatch is reported as uncertain.

Unit cryptography tests and a recording Kubernetes API do not prove installed
containment, TokenReview behavior or loaded-policy observation. Run those with
the real supported runtime before enabling protection; record missing proof.

Pinned mutual TLS can replace the projected-token bootstrap if it proves the
same live host and workload association. It requires a separate provisioning and
rotation design. Reusing the Harness bearer cannot prove supervisor custody.
Keeping protected admission refused remains the supported behavior until this
proposal is implemented and qualified.
