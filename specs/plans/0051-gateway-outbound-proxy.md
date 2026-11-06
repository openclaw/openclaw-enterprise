---
rfc: ../rfcs/0030-gateway-outbound-proxy.md
---

# Implementation plan: one Gateway outbound proxy

- **ID:** TASK-0051
- **Delivery status:** In progress
- **Owner:** OCE contributors
- **Authority:** [Platform design](../../docs/design.md) and existing Kubernetes Compute/networking owners.
- **Proposal:** [RFC-0030](../rfcs/0030-gateway-outbound-proxy.md), not yet accepted.
- **Original experiment baseline:** `80725162a946f80652b939a32a57ee4e922eeb5c`
- **Refreshed upstream baseline:** `324fbad6f248bce4606e175fbb67ac506cd824ff`

## Outcome and scope

Select one operator-managed proxy, either bundled or external, for native
Gateway routing, shared by OCE channel-directory clients by default. Retain an
optional directory-only override for separate routing. Generalize the existing
bundled CONNECT server with a host policy; do not deploy a second bundled proxy.
No Console editor, per-Agent selector, decrypted traffic inspection, arbitrary
Harness routing, or expansion of existing channel/topology support gates.

## Contract and source touchpoints

Installation profiles accept `proxy.bundled` with optional `proxy.allowedHosts`,
or `proxy.url` for an external endpoint. Helm `gatewayProxy` and Compute
`runtime.proxy` consume that selection. Native OC settings and Kubernetes
reachability derive from the same Compute endpoint independently of channels.
The bundled server remains CONNECT/TCP 443 with public-IPv4-only Kubernetes egress.
An explicit `allowedHosts: ["*"]` removes hostname filtering without changing
those port or address restrictions. Slack-only remains the default.

Profile `channels.directoryProxyUrl` and Helm `api.channelDirectoryProxyUrl`
remain optional directory overrides. They take precedence for the API client
without changing Gateway configuration. Empty Helm input inherits the Gateway
selection. API proxy egress permits only its selected endpoint, not both.

The temporary runtime-source bridge exposes an exact-endpoint bypass only for
host-provisioned `OPENCLAW_INTERNAL_TRANSPORT_URL`. The regular Codex transport
registers it before connection and revokes it on closure/construction failure.
It does not exempt arbitrary hosts or Agent-chosen transport destinations.
The bridge must be removed when OC provides the owning internal-transport hook.

## Implementation

- [x] Complete upstream refresh, preserve Driver configuration/validation and
      Credential Proxy boundaries, and repeat affected verification.
- [x] Extend the existing bundled proxy and Helm packaging, not platform core.
- [x] Render a shared default endpoint for directory clients and embedded/dedicated Gateways.
- [x] Retain the directory-only override with explicit endpoint precedence.
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

### Directory override follow-up

The shared endpoint is a default, not a restriction. Profiles retain
`channels.directoryProxyUrl`; Helm retains `api.channelDirectoryProxyUrl`.
An override changes API directory routing and its exact proxy egress grant,
without also granting the default proxy or changing Gateway configuration.

- Both new profile and Helm routing checks failed before the correction and
  passed afterward. The profile check covers both shipped profiles and all
  three Gateway proxy modes: none, external, and bundled.
- All 250 selected profile, chart, and Slack directory checks passed without
  skips across the main run and a committed-chart rerun. The main run passed
  249 checks; the image-upgrade helper stopped at its unchanged-chart guard
  while the edits were uncommitted. That case passed after implementation
  commit `c0b974502`, without bypassing the guard.
- TypeScript, lint, workspace isolation, and CI registration audit passed.
- Formatting, docs/link/length checks, and all three changed flow validators
  passed. Documentation checked 335 pages and 5,380 links.
- This is configuration and rendered-policy proof, not live-cluster enforcement
  or model-turn qualification. Required deployment checks below remain pending.

| Required outcome                                         | Check                                                                                  | Evidence                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------- |
| Host-policy denial, real tunnel lifecycle                | CONNECT tests and packaged runtime transport proof                                     | Passed locally; see delivery record |
| Channel-free selected endpoint and conflict handling     | Compute and profile/Helm integration tests                                             | Passed locally; see delivery record |
| API/worker Agent deployment with enforced policies       | Existing Kubernetes API/worker fixture and real-runtime cases                          | Pending                             |
| Embedded/dedicated real model turns and failure recovery | Explicitly selected disposable cluster, immutable images, authorized model credentials | Pending                             |
| Native image startup, AMD64 and ARM64                    | Final-head container-check workflow                                                    | Pending                             |

## Upstream refresh verification

Refreshed to upstream `324fbad6f248bce4606e175fbb67ac506cd824ff` on 2026-11-05,
retaining published history through merge commits. RFC-0030 and TASK-0051 avoid
upstream's occupied IDs. Typed Driver configuration, structured validation,
shared model providers, multiple plugin catalogs, and Credential Proxy ownership
remain intact.

- Compute and CONNECT suites: 420 passed; no failures or skips.
- Profile renderer and chart parity: 116 passed; no failures or skips.
- Plugin Compute, Slack directory and runtime assembly checks passed (184 cases
  in the focused combined run). The one new async profile case was corrected
  for upstream's renderer and passed on rerun with the complete profile suite.
- Runtime credential and Secret delivery: 30 passed; no failures or skips.
- Selected chart routing and policy checks: 9 passed; no failures or skips.
- Selected committed-chart upgrade guards: 14 passed, including protected plugin
  registrations and refusal of proxy changes by image-only upgrades.
- TypeScript, lint, formatting, workspace isolation, CI suite audit, specification
  metadata, five changed flow validators, and documentation checks passed. The
  site checked 335 pages and 5,377 links; page lengths remain within hard limits.
- All eight runtime patches apply together in recipe order to the current,
  checksum-verified OC source pin. This is source compatibility, not a rebuilt
  image or model-turn claim. Final-head native image checks remain required.

The older runtime and ClawHub probes below remain evidence only for their exact
original image. They do not qualify the refreshed runtime or full OCC workflow.

## All-hosts policy follow-up

The operator can select `allowedHosts: ["*"]` for the bundled proxy. Profile
rendering, Helm validation, and the CONNECT server accept it. The default remains
Slack-only; TCP 443 and the existing public-IPv4 NetworkPolicy remain unchanged.

- The new wildcard checks failed before the change at all three boundaries and
  passed after it. The real proxy process relays bytes for unrelated hosts and
  still rejects other ports and malformed CONNECT targets.
- Proxy tunnel/reset, profile renderer/parity, and selected production-chart
  suites: 134 passed, no failures or skips. Rendered NetworkPolicies are unchanged
  between an explicit host list and `"*"`.
- This does not establish live NetworkPolicy enforcement or model execution.
  The deployment and model qualification items above remain pending.

## Delivery record

Policy identity correction on 2026-11-05: keep the existing Agent-scoped
`allow-gateway-channels-<Agent hash>` NetworkPolicy name for general proxy
reconciliation and retirement. The proposed rename left an existing grant
outside both paths. Embedded and dedicated regression cases reproduced the
stale grant before the correction, then passed endpoint replacement, proxy
removal, and retirement through the production Driver lifecycle with a
Kubernetes transport fixture. This is not live-cluster enforcement proof.

Local verification on 2026-11-05, against the original experiment baseline above, before the upstream refresh:

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
