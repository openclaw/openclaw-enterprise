# Kubernetes Agent Operator (alpha)

The optional Operator reconciles namespaced Kubernetes resources through the
OCC HTTP API. Argo CD can apply these resources from Git. OCC still owns IAM,
Configuration, deployment admission, work, audit and runtime Drivers.

This alpha supports **reviewed adoption of an existing dedicated Agent**,
Configuration updates, running or stopped intent, and Retain finalization.
Namespace and Secret resources reference existing OCC resources. First-time
Agent/Namespace creation, Secret import/rotation and Delete cleanup are not
implemented. Those requests remain pending without performing the unsupported
operation. [RFC-0037](../../specs/rfcs/0037-kubernetes-agent-operator.md) describes
that larger proposed contract; it is not the current feature inventory.

## Kubernetes resources

All four kinds use `enterprise.openclaw.ai/v1alpha1` and must share the Operator's
Kubernetes namespace. The generated structural schemas are installed by the
[Operator chart](../../deploy/helm/openclaw-enterprise-operator/Chart.yaml).

| Kind            | Supported selection                                                                                                      | Ownership                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `OCEConnection` | HTTPS origin, Installation ID, service key and optional public CA Secret references; approved existing OCC Namespace IDs | Administrator-owned trust configuration                                           |
| `OCENamespace`  | `connectionRef`, `existingId`, `deletionPolicy: Retain`                                                                  | Reference only; no tenant creation                                                |
| `OCESecret`     | `namespaceRef`, `existingId`, `deletionPolicy: Retain`                                                                   | Metadata reference; no credential value retrieval                                 |
| `OCEAgent`      | `namespaceRef`, `executionMode: dedicated`, `adopt`, Configuration, Harness auth, desired state, optional native UI      | Exclusive external management of the existing Agent and its private Configuration |

The Connection endpoint is an HTTPS origin without credentials, path, query or
fragment. Redirects are refused. An optional `address` selects an IP for the
socket while retaining the endpoint's Host, SNI and certificate identity. It does
not disable TLS verification. `caSecretKeyRef` can contain a public CA only.

Treat Connection writes as administrator authority: changing its endpoint can
send its service key to another server. Keep untrusted contributors from editing
Connections and their Kubernetes credential Secrets. The chart permits `get`
only for explicitly named Secrets; it grants no Secret list/watch or runtime
Pod access. Secret import fields are reserved and fail closed in this alpha.

## Agent configuration and credentials

`spec.configuration.values` is the native OpenClaw configuration document.
`secretBindings` maps environment names to
`{ secretRef: <OCESecret name>, delivery: { type: env } }`.
The Operator resolves the OCC Secret ID and requests ordinary env delivery;
it does not read the Telegram token. The selected Compute Driver remains
responsible for delivery to the Gateway.

`harnessAuth` selects an existing `credential_source` by `sourceId`, or an
`api_key` / `codex_pat` by local `OCESecret` reference. Credential access and
Agent grants are checked through the normal OCC workflow. ChatGPT OAuth still
requires human consent and a ready, authorized same-Namespace source. Git
contains the source ID, never the login token. See [credential sources](credential-sources.md).

`nativeAdmin: true` requests the existing server-side browser configuration
preparation. It requires native administration to be enabled on the Installation.
It does not grant a service key permission to use the human browser session.
Native Telegram support also depends on the selected runtime/Installation;
installing this Operator does not add a Telegram Driver profile.

## Adoption and apply

Before adoption, read `GET /namespaces/:namespaceId/agents/:agentId/management`
with Agent and Configuration read permissions. Review the exact Configuration
ID, generation, active revision and fingerprint. Put these values and the
current management version (zero for an unmanaged Agent) in `spec.adopt`.
Disable an earlier reconciler before applying this CR. Adoption is exact-ID
based; matching a display name never transfers ownership.

The Operator derives a stable source ID from its configured cluster ID, the
Kubernetes Namespace UID and the CR UID. OCC binds that source to the authenticated
principal and Agent under a lock. One principal/source can manage only one Agent.
The adoption review and execution mode must still match. A shared Configuration
cannot be adopted. An unchanged running configuration does not deploy a revision.

Apply requests carry the source generation, management version and request key.
OCC prepares provider checks before the write transaction, rechecks ownership,
updates the ordinary Configuration/Agent and admits deployment through the
existing lifecycle. The receipt and audit commit with the accepted work. Replaying
the accepted request does not create another revision. An older source generation
cannot overwrite a newer one. A changed `retryNonce` explicitly retries a failed
deployment; routine resynchronization does not.

Ordinary configuration/deploy mutations conflict while external management is
active. An administrator's normal stop remains available and suspends automatic
management. The Operator reports `ManagementSuspended`; it does not undo the
stop. Release ownership, review the current Agent again and explicitly adopt to
resume. Release retains a version tombstone that rejects an old adoption request.

## Status, retries and deletion

`status.observedGeneration` and the Ready condition identify the observed spec.
Successful running intent requires the requested revision to be active, deployment
completion, a runtime observation no older than 90 seconds with ready Gateway
and Agent Pods, and successful current Gateway configuration, authentication and
connectivity diagnostics. An accepted API write alone is insufficient. Stopped intent waits
for runtime cleanup. Status contains IDs and sanitized reasons, no credentials
or private input fingerprints.

The Operator watches its four kinds and resynchronizes every 30 seconds. Writes
use resource versions. API calls have a 10-second deadline and 2 MiB response
limit. Retries back off from 2 to 30 seconds. A 30-second leader Lease renews every
10 seconds; processing stops and in-flight HTTP calls abort after 20 seconds
without renewal. OCC version and source-generation checks also reject stale work.

The supplied Argo health script checks the current generation and observation
age. It requires standard Lua libraries to be enabled for these trusted
customizations and Argo to use UTC. An old status becomes Progressing rather
than remaining Healthy after Operator failure.

`Retain` deletion releases exact Agent ownership before removing its finalizer;
it leaves the Agent, Configuration and credentials intact. Reference CRs wait
for their dependent CRs to finalize. Delete cleanup is unsupported and retains
the finalizer. Do not remove finalizers to bypass an unavailable OCC API.

## Access and setup

Management read needs Agent and Configuration `read`; adoption/release need
exact Agent `administer` and adoption also Configuration `update`. Apply requires
Agent `update` plus normal affected Configuration, deploy, credential and runtime
permissions. Connection verification uses Namespace `read`, not Installation
administration. See [permissions](cheatsheets/permissions.md).

Use the [Argo setup guide](../guides/kubernetes-agent-gitops.md),
[source-backed flow](../flows/kubernetes-agent-operator.md) and
[test coverage](../testing/kubernetes-agent-operator.md).
