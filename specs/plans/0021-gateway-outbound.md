---
rfc: ../rfcs/0021-gateway-outbound.md
---

# Implementation plan: managed Gateway outbound HTTPS

- **ID:** RFC-0021
- **Delivery status:** In progress
- **Authority:** [RFC-0021](../rfcs/0021-gateway-outbound.md)
- **Source baseline:** `d3ccc54781d0d50b40e9aeb814f0573d38c0a585`
- **Refresh target:** upstream `main` at `26d3bcc89e313a7041c6def5b973dfc54ea0e2f4`

## Outcome and scope

Deliver the RFC through the regular Agent workflow in one draft PR. Preserve
dedicated execution and existing credential owners. Supply automatic Slack
requirements, explicitly approved restricted/public integration HTTPS, isolated
revision proxies and a separately restricted control-plane transport. Teams
implementation, embedded networking and remote plugin hosting are excluded.
Harness egress and Credential Proxy mediation remain separate. Unmerged upstream
PRs #2484 and #2487 are not dependencies; protected compositions remain unqualified.

## Implementation

1. Extend shared Agent/revision, Compute capability/admission and Channel network
   requirement contracts. Add exact authorization, API schema, immutable
   snapshots, PostgreSQL constraints and in-memory equivalent behavior.
2. Replace vendor-specific proxy policy with validated generic CONNECT policy,
   vetted DNS/IP connection and bounded lifecycle/diagnostics. Compose Slack
   management transport independently of Agent lifecycle.
3. Integrate revision proxy preparation, readiness, exact peers, runtime
   environment and teardown with Kubernetes Compute. Preserve Harness networking
   and model-credential placement. Freeze admitted address exclusions and reconcile
   tightened Installation ceilings on existing proxies; prove old tunnels close
   before the replacement policy is applied and loosening cannot broaden a revision.
   Use pure `revisionAccessStatus` before Compute effects and persist `withdrawn`
   before invoking removal-only `withdrawRevisionAccess`, so a revision
   with both Gateway and public GitHub reader access closes both. Reader withdrawal
   removes its policy and terminates the admitted Harness before terminal failure,
   preserving existing failure evidence and required retirement across restart.
4. Expose Agent controls and draft/admitted state in Console, updating
   Storybook scenarios and capturing screenshots plus a short walkthrough.
5. Update architecture, living reference, operator procedures and source-backed
   flows; regenerate API references and update affected cheat sheets.
6. Run proportional integration and native-runtime proof, clean the diff and
   complete independent review. Keep the PR draft for missing required evidence.

## Verification

| Outcome                                      | Required proof                                                                             | Current result                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorized save/deploy and denied widening   | Actual API/controller integration                                                          | 11 Console/API workflow cases passed; exact Agent authorization and deploy admission exercised                                                      |
| Persisted selection and immutable revision   | PostgreSQL integration with migrated disposable database                                   | Feature case passed with limited application role; all 148 migration-history cases passed                                                           |
| DNS/IP denial and pinned CONNECT transport   | Real local proxy request integration                                                       | Nine real proxy cases passed, including the explicitly selected public-HTTPS lane; mixed-answer/rebinding fixture proof remains pending             |
| Gateway HTTPS, Agent isolation and lifecycle | Enforcing disposable Kubernetes cluster with actual native runtime                         | Four real-cluster fixture cases passed without skips; native case in progress; 577 Compute conformance cases passed with one existing platform skip |
| Slack management/runtime coexistence         | Actual Driver transport and native Slack client; live provider requires authorized Secrets | 80 Driver/profile and 121 real Helm packaging/parity cases passed; live Slack, Teams and Composio provider proof not run                            |
| Console workflow                             | Rebuilt Storybook, screenshots and walkthrough; real API behavior checked separately       | Nine Network stories inspected; native GitHub screenshot and 18-second captured-frame walkthrough attachments uploaded for the PR                   |

## Delivery record

Implementation commit `27562ebf5` starts from the original source baseline above.
The [implementation PR](https://github.com/openclaw/openclaw-enterprise/pull/2518)
includes this RFC and its implementation. RFC status remains Proposed pending human
review. Verification counts below describe the earlier source; the refreshed base
and composed revision-access withdrawal require new qualification.

TypeScript, lint, workspace, OpenAPI, format, documentation/link and specification
checks passed. Console captures use simulated API/runtime fixtures on macOS arm64
at 1400 × 900; they establish the visible workflow only. Backend and native
networking proof are separate. Required final-head CI, both native image
architectures and full Helm-installed production proof remain merge requirements.
Independent P2 reviews found abandoned proxy authority after deployer revocation
and a lost runtime retirement obligation during withdrawal. Both fixes preserve
durable removal-only work, failure evidence and required cleanup across retries,
restart and lease recovery. Five focused PostgreSQL cases and the existing
candidate cleanup case passed without skips; final refinement review and native
proof remain in progress. The native finalizer regression also found a proxy Pod
selector mismatch that allowed premature finalization; the corrected wait uses
the actual revision ownership labels. The broad local conformance attempt also encountered host
prerequisite failures; targeted passing suites do not imply all local suites passed.

## Changelog

- 2026-10-14: Created the agreed combined RFC/implementation delivery plan from
  upstream `d3ccc54781d0d50b40e9aeb814f0573d38c0a585`.
- 2026-10-16: Renumbered to RFC-0021 after upstream allocated RFC-0020; refreshed
  against current main and composed Gateway/reader withdrawal through Compute.
