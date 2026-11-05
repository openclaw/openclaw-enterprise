---
rfc: ../rfcs/0019-gateway-outbound-proxy.md
---

# Implementation plan: one Gateway outbound proxy

- **ID:** TASK-0045
- **Delivery status:** In progress
- **Owner:** OCE contributors
- **Authority:** [Platform design](../../docs/design.md) and existing Kubernetes Compute/networking owners.
- **Proposal:** [RFC-0019](../rfcs/0019-gateway-outbound-proxy.md), not yet accepted.
- **Source baseline:** `80725162a946f80652b939a32a57ee4e922eeb5c`

**Blocked on upstream refresh.** Checked against upstream
`0ecbe50bfe0df315fda06a90274b9e218b48d96c` on 2026-11-05: the baseline is
2,655 upstream commits behind. Both this task number and the linked RFC number
are occupied upstream. Preserve the experiment's evidence, refresh the code
against current contracts, allocate available identifiers, and repeat affected
verification before treating this as a current OCE implementation.

## Outcome and scope

Select one operator-managed proxy, either bundled or external, for native
Gateway routing and OCE channel-directory clients. Generalize the existing
bundled CONNECT server with a host policy; do not introduce a second proxy.
No Console editor, per-Agent selector, decrypted traffic inspection, arbitrary
Harness routing, or expansion of existing channel/topology support gates.

## Contract and source touchpoints

Installation profiles accept `proxy.bundled` with optional `proxy.allowedHosts`,
or `proxy.url` for an external endpoint. Helm `gatewayProxy` and Compute
`runtime.proxy` consume that selection. Native OC settings and Kubernetes
reachability derive from the same Compute endpoint independently of channels.
The bundled server remains CONNECT/TCP 443 with public-IPv4-only Kubernetes egress.

The temporary runtime-source bridge exposes an exact-endpoint bypass only for
host-provisioned `OPENCLAW_INTERNAL_TRANSPORT_URL`. The regular Codex transport
registers it before connection and revokes it on closure/construction failure.
It does not exempt arbitrary hosts or Agent-chosen transport destinations.
The bridge must be removed when OC provides the owning internal-transport hook.

## Implementation

- [ ] Refresh against current upstream, reconcile its Driver/configuration and
      Credential Proxy contracts, and correct colliding specification identifiers.
- [x] Extend the existing bundled proxy and Helm packaging, not platform core.
- [x] Render one endpoint for directory clients and embedded/dedicated Gateways.
- [x] Preserve internal Codex transport through a lifecycle-owned exact bypass.
- [x] Update [operator setup](../../docs/guides/integrations/gateway-proxy.md),
      [networking reference](../../docs/reference/drivers/kubernetes-compute/gateway-proxy.md),
      and [execution flow](../../docs/flows/harness-execution-topology.md).
- [ ] Exercise supported Agent deployment, permitted/denied requests, proxy failure,
      and revision replacement through real dependencies.
- [ ] Qualify embedded and dedicated model turns with approved images/credentials.
- [ ] Complete final-head native image checks before merge; publication from main
      remains a separately authorized operation.

## Verification

| Required outcome                                         | Check                                                                                  | Evidence                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------- |
| Host-policy denial, real tunnel lifecycle                | CONNECT tests and packaged runtime transport proof                                     | Passed locally; see delivery record |
| Channel-free selected endpoint and conflict handling     | Compute and profile/Helm integration tests                                             | Passed locally; see delivery record |
| API/worker Agent deployment with enforced policies       | Existing Kubernetes API/worker fixture and real-runtime cases                          | Pending                             |
| Embedded/dedicated real model turns and failure recovery | Explicitly selected disposable cluster, immutable images, authorized model credentials | Pending                             |
| Native image startup, AMD64 and ARM64                    | Final-head container-check workflow                                                    | Pending                             |

## Delivery record

Local verification on 2026-11-05, from the source baseline above with this change:

- Focused Node suite: 756 passed, no failures or skips. It covers the proxy
  reset/tunnel cases, Kubernetes Compute and runtime credentials, plugin/Secret
  delivery, directory lookup, profile rendering/parity, production chart
  packaging, and image-upgrade recovery.
- The two-cluster placement regression failed before its admission guard and
  passed afterward. No proxy selection and colocated bundled use remain accepted.
- The packaged-runtime case in `tests/integration/runtime-image-gateway-peer.test.mjs`
  passed with local image `sha256:7fb1291cdda1e38bda918955dd9a3e89892531416e2f84c3728a13884a9f7ead`.
  It exercises genuine Codex initialization, exact bypass and revocation,
  reconnect, trusted HTTPS, denial, and proxy outage without model credentials.
- Separate disposable-container probes passed genuine Slack and example.com
  HTTPS through the selected bundled server. A real native Gateway/node pair
  enrolled and completed workspace file-stat with Gateway-only routing; routing
  the worker too failed as expected. These are transport checks, not dispatch,
  model, Kubernetes enforcement, or OCC deployment proof. All probe resources
  were removed.
- Lint, TypeScript, workspace isolation, documentation/link/length checks,
  changed flow validators, and CI suite audit passed.

Follow-up verification on 2026-11-05:

- The first native image run passed both controller architectures but failed
  both runtime lanes. The new proxy case used a local bind mount that was not
  visible to the CI Docker daemon. It now copies material into a Docker volume;
  the repaired packaged-runtime case passed locally with the image above.
  A separate stock-broker case failed with a bubblewrap mount-permission error;
  native CI remains unresolved, not passed.
- A genuine Gateway from that image searched ClawHub, fetched the owner-qualified
  `@steipete/weather` detail, and installed version `1.0.0` through the bundled
  server permitting `clawhub.ai`. Workspace discovery reported the installed
  skill eligible and model-visible, with valid archive integrity and a lock
  record. Discovery remained valid after a native Gateway restart. TLS
  verification remained enabled; no model or installed skill was executed.
  The disposable containers and network were removed. This does not prove OCC
  deployment, dedicated remote-workspace delivery, NetworkPolicy enforcement,
  skill execution, or persistence across Agent revision replacement.

The real API/worker embedded and dedicated Codex proxy cases are authored under
`tests/integration/harness-topology-k3d-real.test.mjs`. They were not selected for
live execution: an approved disposable cluster/database, immutable image pair,
and authorized model selection/credentials were not provided. Their normal
unselected run reported two skips. Required runtime qualification remains
unchecked; this is not an integration-test waiver. The PR stays draft pending
that proof and final-head native image checks. Image publication from main is
not authorized by this implementation task.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-05 17:34: Record authorized bundled/external implementation and proof boundaries (authoring-run/88571699-9ee3-42d5-89c5-d871f0a18b62 - 80725162a946f80652b939a32a57ee4e922eeb5c).
