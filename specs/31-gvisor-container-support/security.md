# gVisor security model

[Overview](../31-gvisor-container-support.md) · [Architecture](architecture.md)

See the [2026-09-24 amendment](../31-gvisor-container-support.md#current-disposition--2026-09-24-amendment)
for release scope and changes to the historical source and storage baseline.

An Agent must be able to run repository tools without receiving the host's or
another Agent's authority. The proposal adds a selected runtime boundary around
dedicated Codex. It preserves existing authorization and ownership checks, and
does not treat runtime isolation as proof of credential custody or network
confinement.

## Assets, actors and trust

Treat repositories, dependencies, build scripts, model-selected commands and the
Harness itself as hostile. A compromised Harness can use every capability
actually delivered to it, even when the initial user request was legitimate.
The selected controls protect the host, other Agents, gateway state,
controller and provider credentials, repository grants and retained data.

The profile trusts OCC, IAM and State, Kubernetes, node and storage operators,
the installed runtime, the enforcing CNI and credential services. These owners
decide authority or enforce a boundary that the Harness cannot establish for
itself. The design claims neither a virtual-machine boundary nor protection
from compromise of those trusted components or administrators. These are
recorded trust and scope limits, not unresolved qualification work.

The gateway is a separate trusted workload. Its private database and credentials
must not cross into dedicated Codex. Shared workspace data is Agent-wide. That
sharing is intentional and does not make the workspace a private channel
between one tool and one user. Retained content continues to require its own
authorized disclosure and recovery rules.

## Runtime controls

Use restricted Pod security, approved immutable images, the existing Codex
authentication and seccomp requirements, and effective resource limits.
Seccomp restricts the system calls available to a workload. Selecting gVisor
does not silently remove the reviewed Codex compatibility controls.

Tool execution receives none of the following:

- Host paths or host namespaces.
- Container-engine sockets or credential-service control sockets.
- Unrelated credentials or the gateway's private state.

Preserve exact Namespace, Agent and revision ownership checks at every resource
effect. Preserve identity and authorization checks before admitting or
reconciling work. Runtime selection grants no personal, team, repository or
provider authority. The human requester, Agent ServicePrincipal and deployment
actor remain distinct identities.

The [placement observer](architecture.md#placement-and-observation) checks the
complete candidate set because one correct Pod cannot make an unsafe sibling
acceptable. Positive violation evidence drives guarded containment. Mere
unavailability does not authorize resource deletion. Installed qualification
must verify eligible-node scheduling and effective network, process, storage,
log, socket and resource controls. Configuration labels and declared limits
alone do not demonstrate those properties.

## Assurance profiles

The first usable runtime and disposable contribution retain supported model
authentication and network access. Model credentials may remain visible to
tools, and destinations may remain unconfined. A copied session bearer does
not identify a physical workload. Those weaker limits must accompany the
first-profile claim even after runtime qualification succeeds.

Repository provider custody is already a separate requirement. The dedicated
Harness receives only the service's ephemeral session material. GitHub App
keys, App JWTs, installation tokens and control sockets remain service-private.
The contribution explicitly selects `git-full`, whose broader Git, selected
REST, GraphQL, PR, issue and comment ceiling is not a single-PR capability.
GraphQL uses the installation-token grant without per-field authorization.
The [repository interface](interfaces.md#repository-material) keeps this limit
beside the actual material consumer.

The selected protected composition adds independently enforced private ingress,
verified receiving identity, external model/provider custody and owner-admitted
operations. Ordinary off-Pod replay denial is part of that selected composition.
Exact-container origin proof remains deferred and requires separate runtime,
identity and operator evidence when that stronger assurance is selected.

Egress C1 is ordinary embedded Kubernetes network confinement with weaker model
custody. Its completion cannot qualify this RFC's dedicated or protected
composition. The [architecture](architecture.md#protected-composition) names
the local obligations and cross-component owners. Neither this specification
nor a neighboring source component confers composed guarantees on the current
runtime or credential services.

## Accepted limits and closure

This heading records the selected trust and scope limits. Missing implementation,
missing qualification and undecided mechanisms remain open requirements. They
are not accepted residual risk.

Protected traffic withdrawal and runtime termination are distinct obligations.
The completed protected composition must refuse new work and emit the last
protected bytes within a measured maximum of **30 seconds**, including loss of
renewal connectivity. Scoped stricter five-second currentness contracts prevail.
Owners still have to define the starting event, maximum evidence age, clocks
and skew, recheck cadence and closure reserve.

Receivers deny locally before awaiting cleanup. They must close active traffic
as well as reject new requests. Identity and State own currentness, while egress
owns transport closure and the operation owner retains provider settlement.
This lane must consume those results without equating withdrawal with physical
termination. Exact runtime stop remains pending until Compute observes
termination of the bound incarnation. Delete acceptance, timeouts, unavailable
nodes and Pod absence during a partition do not supply that proof.

Independent local process termination during a control-plane outage remains
later hardening. A consumer selecting that stronger assurance needs a qualified
runtime or fencing mechanism and operator evidence. The current proposal does
not invent a runtime supervisor to supply it.

The inspected repository supplier invalidates local sessions on restart and
loses provider-token cleanup inventory. Tokens may remain valid until expiry.
Replacement material or local closure does not prove remote revocation.
Durable cleanup remains the credential owner's separate continuation and needs
protected custody, restart recovery and provider-observed outcomes. Retain
retryable cleanup and the original deadline while reporting that limit.

The earliest-untrusted-execution containment proposal, protected bootstrap and
finite profile transitions remain [owner decisions](interfaces.md#owner-decisions).
Their missing mechanisms do not waive mandatory pre-readiness enforcement,
current authorization or refusal of unsupported combinations.

[Delivery evidence](delivery.md#acceptance-evidence) distinguishes source guards,
composed consumers, installed boundaries and provider results. Rich runtime
receipts require restricted access. History receives only safe owner-produced
projections, not the secret or operational payloads used to qualify a boundary.
