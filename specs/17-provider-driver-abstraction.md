# Feature Spec: Provider and related Drivers

**Date:** 2026-09-01
**Status:** Implemented and locally verified in PR #8; live Provider proof pending
**Owner:** OCC / controller composition

## Problem and Decision

Introduce an Installation-owned `Provider` that groups an authenticated provider client with its related Drivers. Replace the special-cased integration configuration with this abstraction. Each Agent has an optional Provider association, and deployment copies that reference into its immutable AgentRevision.

Baseline source at `b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d` has `integrations.chatgpt`, an API-only [ChatGPTClient](https://github.com/openclaw/openclaw-enterprise/blob/b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d/apps/controller/src/integrations/chatgpt.ts), and one globally selected [ServiceAccount Driver](https://github.com/openclaw/openclaw-enterprise/blob/b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d/apps/controller/src/drivers/service-account/chatgpt.ts). There is no common Integration interface or registry to replace. The client authenticates with an admin API key and creates accounts and access-token credentials; it does not perform model inference. Baseline [Agent and revision contracts](https://github.com/openclaw/openclaw-enterprise/blob/b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d/packages/contracts/src/index.ts) carry no Provider reference.

This proposal extends the [platform design](../docs/design/drivers.md#drivers-and-providers). It preserves OCC resource ownership, exact Namespace authorization, one Installation-selected Driver per capability, and the API-only admin-credential boundary. Existing model configuration and Harness selection remain authoritative for inference and execution.

## Scope

- Add Provider configuration, client ownership, related-Driver membership, nullable Agent association, immutable deployment references, and provider injection into consuming Drivers.
- Replace the existing integration abstraction in code, Installation YAML, Helm configuration, and current documentation when implementation ships.
- All related Drivers are required now. Required/optional selection, automatic account creation, OAuth/refresh, credential renewal, Provider CRUD/discovery, clientless Providers, installed-package Provider injection/loading, and a common inference/HTTP transport API are deferred.
- Preserve native API-key accounts, providerless Agents, existing ServiceAccount operations, Driver package trust rules, and current development/production support boundaries.

## Contract

See [Contract](17-provider-driver-abstraction/contract.md#contract).

## Implementation

1. Add shared Provider/Agent contracts in [contracts](../packages/contracts/src/index.ts); update request/response schemas, controller projections, generated OpenAPI, and both state adapters. Own `providerId` once per Agent/revision; keep private binding projection in [platform-state](../packages/occ/src/state/platform-state.ts) and its PostgreSQL implementation.
2. Replace integration parsing in [installation-config](../apps/controller/src/composition/installation-config.ts), move the concrete client under `apps/controller/src/providers/`, and wire typed Provider injection through API/production/development composition. Validate concrete member selection at composition; retain the ordinary Driver registry contract unchanged.
3. Add per-use admission/worker binding checks and immutable revision-column storage, preserving existing ServiceAccount CRUD, deployment queue, cancellation, credential delivery, and cleanup. Update schema artifacts through the repository's database workflow and require the clean state transition described above.
4. Update Helm values/templates, startup examples, tests, and current [Driver selection](../docs/reference/drivers/selection.md), [ServiceAccount](../docs/reference/drivers/service-account.md), [Agent](../docs/reference/agents.md), settings/security, architecture, startup/credential-delivery flows, and deployment documentation when shipping. Update the platform design's integration terminology narrowly; retain historical specs unchanged.

## Verification

| Required outcome                                                                              | Implementation proof                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One membership authority, mandatory ChatGPT/service-account pairing, correct client injection | Configuration-startup and bundled Driver tests reject missing/conflicting/unselected membership; ordinary Driver registration needs no Provider metadata.                                                                                                                            |
| Nullable association and immutable revisions                                                  | Real API tests for create/PATCH matrix, `201`/`202` and response projections; PostgreSQL round-trip/restart tests for Agent and revision; draft edits preserve prior revision values.                                                                                                |
| Exact credential ownership without worker admin access                                        | Extend PostgreSQL worker/ServiceAccount tests: null/native success; managed matched success; null, wrong Provider/Driver/workspace, absent issuance, and cross-Namespace denial before effects; unchanged failure recovery.                                                          |
| Stale references do not block repair; credential ownership remains exact                      | Actual API startup accepts stale saved references and permits authorized draft repair. PostgreSQL deployment/worker tests reject invalid Provider and binding identities at use. Preserve same-identity key/TTL changes, exact old-config cleanup and recoverable failures.          |
| Existing provider calls and credential delivery still work                                    | Retain conformance plus authorized service-account-driver-real coverage: create, issue, dedicated Codex delivery, revoke/delete and rollback; no admin key in worker/gateway/revisions/logs. Missing credentials must be reported as a proof gap.                                    |
| Integration format fully removed and clean state transition enforced                          | Startup rejects old configuration/persisted formats; Helm render checks exact Secret path, API-only mounts/egress and `/32`; verify a fresh database through normal initialization and recreation. Scoped search excludes historical specs and generic test/integration terminology. |

Implementation gates: focused tests above, workspace/type checks, generated OpenAPI checks, and scoped formatting. Delivery evidence and remaining proof limits are recorded below.

## Delivery Record

The approved simplification removes global startup saved-state traversal and generic Driver ownership metadata, moves revision Provider snapshots into immutable columns, and consolidates test fixtures. Provider configuration, nullable API fields, exact per-use credential checks, and API-only client construction remain. Current behavior is owned by [Providers](../docs/reference/backends.md), [Agents](../docs/reference/agents.md), and the [Provider-managed credential delivery flow](../docs/flows/service-account-driver-credential-delivery.md).

The simplified [implementation a635483](https://github.com/openclaw/openclaw-enterprise/commit/a635483aa62d41df7b45040b89d9edf4a3cee725) passed independent local verification: 139 conformance tests, 27 API/configuration/ServiceAccount tests, 36 PostgreSQL tests, and three production-image smoke tests. The PostgreSQL run had five explicit skips: four require a live Kubernetes ConfigurationDriver, and one requires an uninitialized singleton after an earlier case bootstrapped it. Workspace, TypeScript, formatting, OpenAPI, actual Helm rendering, flow-doc, and link checks passed. Two review passes resolved the bootstrap-fixture identity and security wording findings. Live ChatGPT account issuance, dedicated model turns, and upstream revocation remain unverified because authorized credentials/workspace and explicitly selected Kubernetes runtime fixtures are unavailable. No pre-existing Installation was reset or deployed.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 10:58: Completed the approved simplification, fixed review findings, and independently verified the smaller implementation; live Provider proof remains pending (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - a635483aa62d41df7b45040b89d9edf4a3cee725).

- 2026-09-01 10:19: Kevin approved composition-owned Driver membership, immutable revision columns, per-use ownership checks without startup traversal, and consolidated test fixtures; implementation/verification underway (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - 1c7eae4d11e6c474cc7f1bbbb05d2c2e7052a158).

- 2026-09-01 09:41: Implemented Provider configuration and Driver ownership, nullable Agent associations, immutable revisions, startup/admission/worker checks, and current reference/flow docs; independent local verification passed, live Provider proof remains pending (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - 118de64066c330e0828b50cdf4f2409ec22dc001).

- 2026-09-01 08:19: Applied Kevin's approved review direction: required client and bundled pairing, scoped injection, cleanup guard, exact Helm shape, and clean development-state transition; specification only (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d).
- 2026-09-01 07:43: Draft Provider contract and source-grounded migration proposal; awaiting independent reviews and user direction (01a05d6b-e21d-7fc0-b1bd-b5cb15b365c6 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d).
