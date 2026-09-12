# Feature Spec: Private Agent Gateway Routing

**Date:** 2026-09-01
**Status:** Completed and locally verified in PR #7; not merged
**Owner:** Kubernetes Compute, OCC API, installation operators

## Problem and Decision

Replace the per-Agent workspace-file endpoint map with stable, Compute-managed
routes through one private Envoy Gateway per Installation. cert-manager issues
and renews its server certificate. Operators configure infrastructure once;
Agent provisioning creates its route without a subsequent OCC restart or map
edit. This implements the approved Kubernetes integration under the
[platform design](../../docs/design.md).

## Scope

- Add optional Kubernetes routing configuration and a pure Compute endpoint
  resolver; retain the existing four-file OCC API and active-revision admission.
- Package opt-in Gateway, Envoy, certificate, authentication, and network
  resources in the existing Helm chart. Operators install the controllers and
  provide an issuer, hostname, trust bundle, and service credential.
- Remove `OCC_WORKSPACE_FILES_CONFIG_PATH` and its per-Agent endpoint YAML.
- Do not introduce a platform Gateway resource, store URLs or file bytes in
  PostgreSQL, rewrite immutable native Configuration, or broaden native RPCs.
- Docker and Compute Drivers without endpoint resolution return unavailable.
  Automatic Docker routing, a public native UI, mTLS client support, and an
  additional background route controller are outside this change.

## Contract

The Installation-selected Compute Driver may implement
`getGatewayEndpoint(revision)`. OCC calls it only with an already authorized
active AgentRevision. Kubernetes derives
`wss://<hostname>/namespaces/<namespaceId>/agents/<agentId>` from installation
routing settings and admitted IDs, without Kubernetes API access or persisted
per-Agent mappings. Native connection or routing failure returns the existing
dependency-unavailable result; a calculated URL does not establish readiness.

Kubernetes Compute owns one `HTTPRoute` in the Agent's Kubernetes namespace,
targeting its existing gateway Service in that same namespace. The exact path
and hostname bind the request to that Service; Envoy rewrites the path to `/`
for the native WebSocket upgrade. The route follows the stable Service across
revision cutover. Preparation and activation reconcile it. Retiring an old
revision must not delete a newer gateway's route. Final gateway cleanup removes
the owned route by name or verifies its absence, even after a prior attempt
already removed the Deployment or Service. A stale retirement cannot remove a
route belonging to a newer revision.

The installation operator owns the private Gateway and its infrastructure.
Only namespaces labelled for that Gateway may attach routes. The tenant worker
receives namespace-bound HTTPRoute permissions; the API receives no route,
Gateway, certificate, or proxy management permission. Operators must prevent
untrusted Kubernetes principals from modifying attached routes, native gateway
configuration, proxy policy, or namespace membership. Platform IAM does not
authorize direct Kubernetes resource mutation.

Envoy authenticates OCC's high-entropy service key in `x-api-key`, removes the
credential, and overwrites `x-occ-identity: occ-workspace-files`. It removes
caller forwarding and scope headers and sets `X-Real-IP` from the **direct
downstream socket address**, using Envoy's
`%DOWNSTREAM_DIRECT_REMOTE_ADDRESS_WITHOUT_PORT%` formatter. This does not
delegate human authentication to native OpenClaw: OCC retains exact-Agent
`read`/`operate` checks and attributable human audit evidence.

Native Configuration explicitly enables `trusted-proxy` authentication,
`allowRealIpFallback`, the trusted proxy source range, and an `operator.admin`
grant for that fixed identity. It omits a simultaneous gateway token.
Routed Compute requires exactly one gateway-client peer with the configured
Gateway's Envoy ownership labels and rejects legacy direct peers. A trusted Pod
CIDR alone cannot distinguish Envoy from other workloads. The fallback uses the actual nonloopback
OCC connection address even when OCC and Envoy share a Pod CIDR. No caller IP
or synthetic address is accepted as the proxy's attribution assertion.

OCC's pinned native client supports authenticated WSS upgrade headers but not
client certificate presentation. Use Envoy Gateway v1.9 API-key authentication,
not an invented SDK mTLS option. The API mounts a dedicated service-key file,
validates it before serving, and reads it for each operation. Rotation affects
new connections; existing admitted native requests remain bounded by their
deadline. Rotate by accepting old and new keys at Envoy before replacing OCC's
mounted key, then remove the old key. One Opaque Secret contains accepted keys
under separate client IDs; OCC mounts only its `occ` entry. Key bytes contain no
whitespace and are not trimmed. Never replay a write whose outcome is unknown.

cert-manager renews the listener certificate under a trusted CA. OCC uses normal
hostname/CA verification and optionally a startup `NODE_EXTRA_CA_CERTS` bundle;
there is no leaf-certificate pin. Ordinary leaf renewal requires no OCC restart.
Changing a private root bundle requires an API restart. The chart creates a
ClusterIP proxy and permits API-to-proxy and proxy-to-gateway traffic using
exact workload selectors; public exposure is not part of this integration.

## Implementation

1. Extend [Compute](../../packages/contracts/src/index.ts) and
   [Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts)
   with endpoint derivation, route ownership, and lifecycle cleanup.
2. Replace [workspace-file composition](../../apps/controller/src/composition/workspace-files.ts)
   and retain the [native client](../../apps/controller/src/gateway/workspace-files-client.ts)
   deadline, scope verification, and unknown-write outcome handling.
3. Add opt-in [Helm](../../deploy/helm/openclaw-enterprise) infrastructure, API-only
   credential/trust mounts, restricted route attachment, RBAC, and networking.
4. Update [Agents](../../docs/reference/agents.md#workspace-files),
   [deployment](../../docs/guides/deploy/workspace-routing.md#agent-workspace-files),
   [settings](../../docs/reference/settings.md), [Compute](../../docs/reference/drivers/compute.md),
   [Kubernetes Compute](../../docs/reference/drivers/kubernetes-compute.md), and
   [testing](../../docs/testing/README.md). Replace the hand-built proxy proof with the
   actual Envoy Gateway and cert-manager path.

## Verification

| Required outcome                                                                               | How to verify                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| New Agent works without an endpoint map or API restart                                         | Real Kubernetes provisioning followed by OCC four-file PUT/GET and a fresh native model session consuming the file                      |
| Service and workspace survive gateway replacement                                              | Replace the gateway Pod; verify new UID, unchanged route, four reads, and fresh model consumption                                       |
| Routing remains exact and cleanup does not remove a newer revision                             | Compute lifecycle coverage, including retry after Deployment/Service deletion; verify route absence and preserve a newer revision route |
| Unauthenticated access and direct-workload bypass fail; spoofed headers cannot change identity | Requests against the real Envoy listener and native gateway with enforced NetworkPolicies                                               |
| Human Agent authorization still applies                                                        | Existing OCC read/operate and cross-Agent conformance cases                                                                             |
| Credentials stay server-side and rotation works                                                | Inspect API-only mounts; real overlapping keys in one Secret, new-key acceptance, and old-key denial after rotation                     |
| Certificate renewal does not require an OCC restart                                            | Renew the cert-manager leaf under the same CA, observe a new serial, and repeat a native file request                                   |
| Infrastructure is opt-in and permissions remain bounded                                        | Helm rendering tests and real Gateway/Certificate/SecurityPolicy accepted conditions                                                    |

Verified 2026-09-01 with 158 conformance tests, seven actual Helm-render tests,
and the focused live routing case (200.9 seconds, one pass, no skips). The live
case used Envoy Gateway 1.9.1, cert-manager 1.20.0, real OpenClaw 2026.8.1 and
Codex 0.150.1, limited-role PostgreSQL, and two fresh model sessions. It proved
four-file access, automatic routing, denied credentials/direct peers, overlapping
key rotation, served certificate renewal, and persistence after Pod replacement.
The API/worker ran in the test process; Docker Desktop and a Pod carried
unchanged TLS bytes. This does not prove a Helm-installed OCC controller or CI.
Current behavior is owned by the linked Agent and Kubernetes Compute references.

## Manual Notes

## Changelog

- 2026-09-01 18:10: Completed implementation and the live acceptance case;
  archived this implementation record. Session 01a04ae1-7ba7-7372-88a4-488e01f690ae;
  implementation based on `3e26931d31ba03a7fa187c12009867c636a86041`.

- 2026-09-01 17:25: Recorded the approved Envoy Gateway/cert-manager integration
  and pinned-client authentication boundary (01a04ae1-7ba7-7372-88a4-488e01f690ae;
  baseline `3e26931d31ba03a7fa187c12009867c636a86041`).
