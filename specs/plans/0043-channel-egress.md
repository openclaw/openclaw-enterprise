---
rfc: ../rfcs/20261118-channel-egress.md
---

# Implementation plan: Per-Agent channel egress

- **ID:** RFC-20261118-channel-egress
- **Delivery status:** In progress (implementation and local verification complete; final review pending)
- **Owner:** kevinlin-openai
- **Source baseline:** `b401e36cb8754af762120e28cbf150e379482fef`
- **Authority:** [RFC-20261118-channel-egress](../rfcs/20261118-channel-egress.md), submitted in [PR #6507](https://github.com/openclaw/openclaw-enterprise/pull/6507).

PR #6507 submitted the proposal as RFC-0043. It briefly used RFC-0044 before
adopting its submission date. This plan retains its filename.

## Outcome and scope

Deploy enabled channels through separate Agent listeners on a dedicated Envoy
fleet. Route OCC credential validation and directory requests through a separate
restricted listener. Preserve dedicated Harness connections and private workspace
routing. Remove the custom Slack proxy after both consumers use Envoy.

The scope includes Slack and different destination policies, not a Microsoft
Teams Driver, customer upstream proxies, workload identity, or automatic sharding.
The [acceptance criteria](../rfcs/20261118-channel-egress.md#acceptance-criteria)
define required proof. Fixture success does not establish runtime acceptance.

## Qualification gate

Before changing the Driver or selecting production resources, qualify Envoy
Gateway v1.6.7 with its default Envoy v1.36.6 image. Record CONNECT termination,
target and resolved-address authorization, configuration acknowledgement,
connection revocation, and listener capacity. An extension or version change
requires the RFC's explicit review.

Source inspection found that v1.6.7 supports CONNECT termination through
`BackendTrafficPolicy.httpUpgrade` and a `DynamicResolver` Backend. Its cluster
translator creates a dynamic-forward-proxy cluster. It does not install the
dynamic-forward-proxy HTTP filter with `save_upstream_address`, or an
upstream-address RBAC policy. These resources alone do not satisfy the address
restriction requirement.

A native Envoy probe with target RBAC, dynamic forwarding, and resolved-address
RBAC passed configuration validation and six real connection cases: Slack TLS
worked; an unlisted host, a domain-boundary lookalike, an unlisted port, a
loopback IP, and a DNS name resolving to loopback were denied. This does not yet
qualify Gateway API integration, DNS changes or alternate address selection,
IPv6, revocation, or production NetworkPolicies.

The tested image is
`envoyproxy/envoy@sha256:947974108bb93df64469fedaa0ab7191cdf86c608217d6ff9b497c4e96ff1069`.
The binary reports Envoy 1.36.6, source commit
`31608367a7f5f7e4ec627f4dac396577f2322fdc`.

The native downstream-address candidate subsequently failed an alternate-address
test. A controlled DNS response returned a public address followed by loopback.
Envoy authorized the first address, then connected to the private alternate and
received the negative target's marker. Do not use this candidate. Separately,
the stock Gateway resources returned `200 OK` for loopback CONNECT.

A revised native candidate uses Envoy v1.39.4, strict-DNS subclusters and
`envoy.filters.http.upstream_rbac` before the upstream codec. Its image digest is
`sha256:ccb37e93d8274a525fe00d67287716dbe3d58bc4237d7627af9e64fae0fd25c8`.
Slack CONNECT and verified TLS passed. Loopback DNS and IP cases returned 403.
Eight mixed-address attempts returned alternating 403 for the private host and
503 for the unavailable public endpoint; none reached the private marker.
These remain native probes, not Gateway integration or full DNS-change proof.

The proposed production path retains the v1.6.7 controller and private ingress
fleet. Only the separate egress fleet would select the newer image. A scoped
`EnvoyPatchPolicy` would install target RBAC, the subcluster filter and cluster,
and upstream-address RBAC. The RFC records this extension/version proposal for
explicit review. The coordinator reviewed the amendment and qualification
artifacts before implementation. This is technical review, not human acceptance.

Gateway qualification then passed Slack credential validation, channel/user
directory reads and a genuine Socket Mode handshake. With a five-second
filter-chain drain, inspection showed the revoked generation active and the old
chain gone after 5.63 seconds. The socket observed EOF 6.35 seconds after opening.

The fleet accepted 64 configured listeners: 62 Agent slots, one OCC slot and one
inspection slot, in addition to Envoy's own readiness listener. Real labeled Pods
with enforcing NetworkPolicies passed distinct Slack and public HTTPS CONNECT
policies. Cross-listener, stale-revision, Harness, no-channel and direct internet
attempts failed. The public HTTPS probe required the host's public CA bundle;
certificate verification stayed enabled. These probes do not replace Agent
workflow tests.

## Implementation decisions

- `runtime.channelEgress` identifies `gatewayName`, `gatewayNamespace`,
  `envoyNamespace`, `serviceName`, `listenerPortStart`, `listenerPortEnd`,
  `occListenerPort`, and `inspectionPort`. Omission disables channel activation.
  The packaged Agent range is 10001–10062; OCC uses 10000 and inspection 19004.
  At most 62 Agent slots are supported, including replacement slots.
- Packaging owns the separate Gateway, EnvoyProxy and Service. Compute owns
  per-binding EnvoyPatchPolicy and NetworkPolicy resources. The egress fleet
  uses the qualified image and a five-second filter-chain drain.
- Each port has a stable EnvoyPatchPolicy allocation record. Kubernetes
  `resourceVersion` compare-and-swap reserves it with namespace, Agent, revision,
  rules generation and an immutable binding ID. Its initial policy denies all
  targets. The same resource holds the binding and policy, so stale workers
  cannot reinstall an old policy after port reuse. Released slots retain a deny
  policy. Recovery reuses only an exact binding. Unknown ownership retains its
  reservation. A changed rules generation obtains a new binding; source grants
  also select its server-owned Gateway binding label.
- Before workload creation, Compute checks active listener generations on every
  serving egress Pod through a worker-only read-only inspection listener, and
  checks exact NetworkPolicies. Translation status alone is insufficient.
- Cleanup installs a new deny filter chain, waits until each serving Pod shows
  that generation with no old draining listener and a zero filter-chain drain
  gauge, and removes exact source grants. In-place filter-chain drains are not
  present in Envoy's `config_dump`; the separate gauge is required.
  Before release, source Pods must be absent and their Deployments and ReplicaSets
  must have no desired replicas. This fences port reuse while CNI updates propagate.
  Only then can it release the reservation using compare-and-swap. Unknown or
  unavailable Pods make cleanup retry.
- IPv4 uses upstream RBAC, a complete special-use exclusion list and installation
  network exclusions. IPv6 rules remain unsupported until qualified and fail
  explicitly; IPv6 upstream connections remain denied.

## Contract and source touchpoints

- Contracts own `NetworkDestinationRule`, strict schema validation, and
  `ChannelDriver.enableRouting()`, exported through the top-level entry point.
- Controller composition resolves each enabled provider to one installed Driver.
  Admission and worker deployment use this resolver. Each deployment attempt
  holds one coherent set of derived rules; retries derive current rules again.
- Kubernetes Compute owns listener reservation, configuration, exact revision
  NetworkPolicies, readiness, and cleanup. Managed Kubernetes resources retain
  ownership and generation; the database stores no destination snapshot.
- The Slack Driver owns Slack destinations and provider requests. Compute must
  not retain Slack-specific destination decisions.
- Helm and installation profiles own the fleet configuration and scoped RBAC.
  API Pods alone receive the OCC listener grant.

## Implementation

1. Finish the qualification gate. Record concrete resource kinds, configuration
   fields, port range, OCC reservation, and measured capacity before implementation.
2. Add the destination contract and shared trusted provider resolver. Integrate
   admission and worker attempts without persisting destination rules.
3. Implement compare-and-swap allocation and recovery of managed bindings.
   Candidate revisions retain separate bindings from serving revisions.
   Reject uncertain ownership, exhaustion, and unavailable enforcement.
4. Install the exact listener policy and network grants before starting Gateway
   Pods. Supply `HTTPS_PROXY` directly; preserve required internal connections.
5. Revoke access and terminate old tunnels before releasing a port. Retain the
   reservation when cleanup cannot be proved. Scope deletion to its generation.
6. Route OCC provider calls through the reserved listener and remove the custom
   Slack server, packaging, profile settings, and obsolete tests.
7. Update Channel Driver, Slack, networking and configuration references, their
   guides and flow owners, and the changed architecture ownership claim.

## Verification

| Criterion | Supported proof                                                                                                                              | Status                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| AC-1      | Helm-installed API, worker and PostgreSQL; Slack validation, users/channels directory, genuine message/reply and native Codex correlation    | Passed                                                          |
| AC-2      | Distinct Agent policies and no-channel Agent; allowed public destinations; denied cross-listener, Harness, unlisted target and direct access | Passed                                                          |
| AC-3      | Envoy absent, rejected policy and exhausted capacity; OCC stays usable                                                                       | Passed, including final outage/model/recovery repeat            |
| AC-4      | Replacement, disable, delete, worker restart, concurrent allocation, changed Driver retry, tunnel termination and port reuse                 | Passed with final drain and source-workload checks              |
| AC-5      | Malformed targets, boundary lookalikes, explicit IP/CIDR, public/private/mixed DNS answers and IPv4/IPv6 restrictions                        | Passed                                                          |
| AC-6      | Packaged Slack proxy removal, private routing and dedicated model turns before and after cutover                                             | Passed on native amd64; native multi-architecture check pending |

Use the existing Kubernetes integration workflow with a disposable cluster and
enforcing NetworkPolicies. Private Pod addresses are negative cases. Test model
credentials stay only in the model-executing workload. Store no credentials or
private test evidence in the repository.

## Remaining delivery

Implementation and local AC-1 through AC-6 proof are complete on the selected
amd64 environment. Before merge, resolve final independent review, native image
checks and the RFC's extension/image decision. The RFC remains Proposed;
implementation does not change its human-review status. No merge or release is
authorized by this delivery.

## Delivery record

The RFC branch was merged normally into the implementation branch. The contract,
trusted resolver, Compute lifecycle, dedicated Envoy packaging, OCC listener and
proxy removal are implemented. [Implementation PR #6529](https://github.com/openclaw/openclaw-enterprise/pull/6529)
is separate from the RFC PR. Current behavior belongs to the
[managed channel egress reference](../../docs/reference/drivers/kubernetes-compute/channel-egress.md).

Real checks on the implementation candidate:

- `channel-egress-helm-real.test.ts`: one case passed with zero skips in the final 286.4-second run.
  The actual Helm-installed OCC and PostgreSQL completed dedicated model turns
  across two revisions, credential validation, users and channels lookup, one
  Slack message/reply, and normal Agent deletion with listener retirement. The
  reply correlated with exactly one completed native Codex turn, with a
  60-second observation for duplicates. Gateway and Harness network denials passed.
- `channel-egress-kubernetes-real.test.ts`: one fresh case passed with zero skips
  in 356.6 seconds. It covered rejected writes, concurrent allocation, capacity,
  current Driver rules on retry, distinct policies, public/private/mixed DNS,
  IP/CIDR and IPv6 target denial, disablement, deletion, tunnel retirement and
  port reuse. It also completed model turns before and after replacement.
- `harness-topology-k3d-slack-real.test.mjs`: one case passed with zero skips in
  264.6 seconds. It verified a genuine Slack exchange, one native Codex turn and
  credential placement. With the actual Envoy Pods absent, OCC stayed usable,
  a real model turn completed, channel activation failed before revision admission,
  and direct Slack access stayed denied. Authorized directory lookup succeeded
  after fleet recovery; Pod readiness alone was not treated as provider readiness.
- The lifecycle fixture initially omitted the new read-only ReplicaSet permission.
  Production Helm already included it. A diagnostic run confirmed fail-closed
  reservation retention and recovered after repair. The reported final run used
  the corrected fixture from setup and required no manual intervention.
- The three required Kubernetes fixture files passed four cases with zero skips
  in the final 229.3-second run. They prove API, RBAC, storage,
  reconciliation and NetworkPolicy behavior, not model execution.
- The prepared native amd64 image lane passed 32 runtime tests in seven files.
  The runtime rebuilt after the main merge passed its 32 tests; six controller
  startup cases passed on the final controller image with zero skips in 21.0 seconds.
  These results do not qualify ARM64.
- A separate production Helm/TUI case passed four model replies across two
  revisions, tenant RoleBindings and API/Gateway network denials. Optional OTLP
  and independent image-upgrade scenarios were not selected.
- The final affected API checks passed 129 cases, Compute/network/Slack checks
  passed 458, contract/Slack configuration checks passed 51, chart/profile checks
  passed 135, and the updated Console fixture passed two headless browser cases.
  Each reported set had zero skips. Another 20 upgrade/preflight cases passed.
  Lint, TypeScript, workspace, OpenAPI, documentation links/length and CI test
  registration checks passed.

Hosted CI identified remaining fixture assumptions after the first publication.
The fixes add the declared dependency to cold-prepack setup, use the absent-binding
form for channel-disabled rendering, and supply required profile exclusions.
Credential-reference cases use a second supported Slack account; the existing API
table checks unavailable Teams refusal. The unreachable Teams browser draft case
was removed. The corrected packaging/conformance/profile group passed 121 cases,
the Configuration API suite passed 286, and the credential Console suite passed
36, all with zero skips. Production routing and validation were unchanged.

A further CI failure came from the PostgreSQL provisioning fixture omitting its
installed Channel Driver. It now supplies the real Slack Driver with the existing
mocked external request function; production proxy enforcement is unchanged. The
selected official PostgreSQL run passed 73 tests with zero skips or runner issues
in 116.3 seconds, and its owned database resources were cleaned. This is
provisioning and IAM proof, not another claim of real Slack networking.

An audit of Envoy source found that `config_dump` omits in-place filter-chain
drains. Cleanup now also checks the drain gauge on every serving Pod. It requires
old source Pods to be absent and their Deployments and ReplicaSets to have no
desired replicas before reuse, because policy readback does not acknowledge CNI
revocation. The final lifecycle run exercised this implementation.

The isolated autoreview CLI failed authentication before producing an assessment.
ClawSweeper independently reviewed checkpoint `c1b11f202` and reported no definite
P0–P2 findings. Its absence-only test was removed; real transport cases own that
proof. Its review does not cover later changes. Before merge, the human RFC
extension/image decision, final independent review and native image checks remain.
No previous-release upgrade or compatibility shim is claimed. The RFC intentionally
rejects retired proxy settings and introduces no database format. Saved revisions
with current Driver rules were exercised through real worker restarts and retries.

Private credentials and raw runtime evidence stay outside the repository.

## Manual Notes

## Changelog

- 2026-11-18: Created the linked implementation plan and recorded initial native
  Envoy qualification against the source baseline above.
