---
rfc: ../rfcs/0020-gateway-outbound.md
---

# Implementation plan: managed Gateway outbound HTTPS

- **ID:** RFC-0020
- **Delivery status:** In progress
- **Authority:** [RFC-0020](../rfcs/0020-gateway-outbound.md)
- **Source baseline:** `d3ccc54781d0d50b40e9aeb814f0573d38c0a585`

## Outcome and scope

Deliver the RFC through the regular Agent workflow in one draft PR. Preserve
dedicated execution and existing credential owners. Supply automatic Slack
requirements, explicitly approved restricted/public integration HTTPS, isolated
revision proxies and a separately restricted control-plane transport. Teams
implementation, embedded networking and remote plugin hosting are excluded.

## Implementation

1. Extend shared Agent/revision, Compute capability/admission and Channel network
   requirement contracts. Add exact authorization, API schema, immutable
   snapshots, PostgreSQL constraints and in-memory equivalent behavior.
2. Replace vendor-specific proxy policy with validated generic CONNECT policy,
   vetted DNS/IP connection and bounded lifecycle/diagnostics. Compose Slack
   management transport independently of Agent lifecycle.
3. Integrate revision proxy preparation, readiness, exact peers, runtime
   environment and teardown with Kubernetes Compute. Preserve Harness networking
   and model-credential placement.
4. Expose Agent controls and requested/deployed state in Console, updating
   Storybook scenarios and capturing screenshots plus a short walkthrough.
5. Update architecture, living reference, operator procedures and source-backed
   flows; regenerate API references and update affected cheat sheets.
6. Run proportional integration and native-runtime proof, clean the diff and
   complete independent review. Keep the PR draft for missing required evidence.

## Verification

| Outcome | Required proof | Current result |
| --- | --- | --- |
| Authorized save/deploy and denied widening | Actual API/controller integration | Not run |
| Persisted selection and immutable revision | PostgreSQL integration with migrated disposable database | Not run |
| DNS/IP denial and pinned CONNECT transport | Real local proxy request integration | Not run |
| Gateway HTTPS, Agent isolation and lifecycle | Enforcing disposable Kubernetes cluster with actual native runtime | Not run |
| Slack management/runtime coexistence | Actual Driver transport and native Slack client; live provider requires authorized Secrets | Not run |
| Console workflow | Rebuilt Storybook, screenshots and walkthrough; real API behavior checked separately | Not run |

## Delivery record

The earlier external-route draft was discarded. This implementation starts from
the source baseline above. No implementation or runtime success is claimed yet.

## Changelog

- 2026-10-14: Created the agreed combined RFC/implementation delivery plan from
  upstream `d3ccc54781d0d50b40e9aeb814f0573d38c0a585`.
