# Feature Spec: Workspace enrollment without a Harness restart

**Date:** 2026-09-28
**Status:** Superseded by the implementation merged in PR #616
**Owner:** Kubernetes Compute Driver and dedicated Codex runtime

> Historical design: [PR #616](https://github.com/openclaw/openclaw-enterprise/pull/616) independently shipped workspace enrollment without a Harness restart; [PR #640](https://github.com/openclaw/openclaw-enterprise/pull/640) extended Gateway startup. The file path, renewal, and delivery details below describe this earlier proposal. Use the [current storage reference](../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md) for the shipped contract. This branch retains only the test-fixture repairs discovered during validation.

## Problem and Decision

Today, Codex initializes before its Gateway can issue workspace-node credentials. Adding those credentials changes the Harness Pod template, so Kubernetes replaces the Pod and Codex initializes again.

Create the first Pod with its supervisor and mounts already configured. Start Codex after local baseline initialization, then start the workspace node when its credential file appears. Enrollment must leave the Harness Pod and Codex process running.

The implementation belongs to [Kubernetes Compute](../apps/controller/src/drivers/compute/kubernetes/index.ts) and its [existing supervisor](../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts). The implementation targets `8f3fc12cca3cb2e2a387aefb2be4d1c1eb2b39b6`, preserving its Agent-and-Harness node identity and setup renewal. Runtime and latency proof must use that integrated source.

## Scope

- Apply to ordinary Kubernetes Compute-owned dedicated Codex Harnesses, including replacement recovery.
- Preserve provider-owned workload behavior. [Sandbox requirements](../packages/contracts/src/index.ts) cannot express Secret-file projection; this change does not extend that contract.
- Leave Gateway replacement, controller cadence, native pairing APIs, automatic setup renewal, and other execution modes unchanged.

## Contract

### Stable Pod and credential delivery

For a fixed revision, image, credentials generation, and runtime configuration, the complete Harness Pod template must remain identical before setup issuance, after issuance, and after recording `deviceId`.

Compute derives the existing Agent-and-Harness-owned Secret name before Gateway readiness and includes the supervisor, bootstrap options, CA, private node-state mount, and directory initialization in the first Pod. It creates the Secret only when the Gateway is ready; no placeholder or new persisted state is needed.

Mount only its existing `setupCode` key at `/run/openclaw/node-setup/setupCode` using an optional, read-only Secret volume with mode `0440` and the existing runtime group. Set `OPENCLAW_NODE_SETUP_CODE_FILE` to that path; omit `OPENCLAW_NODE_SETUP_CODE` for this path.

Mount the directory without `subPath`. [Kubernetes projects Secret updates asynchronously](https://kubernetes.io/docs/concepts/configuration/secret/#using-secrets-as-files-from-a-pod); `subPath` would prevent updates. Delivery delay must count toward the latency result.

### Start Codex once, then enroll the node

1. Complete existing local asset and baseline workspace initialization.
2. Start Codex immediately and poll the credential path every second, reopening it each time to observe projection updates.
3. On a nonempty code, stop polling and launch one supervised node using the existing `--pair-if-needed` command and command allowlist. Secret changes leave a running node alone. After a node exit, read the current file before retrying so existing renewal can recover an expired setup without restarting Codex.
4. Preserve independent child restarts, process-group cleanup, and saved native identity. Shutdown cancels polling and restart timers before stopping children; no node may start afterward.

Missing files mean wait. Empty content or other read errors produce a sanitized, rate-limited diagnostic and retry without restarting Codex. Never log credential contents.

Use one supervisor. Preserve the explicit environment-code input for existing callers, reject simultaneous input modes, and never fall back from an absent file to another input. Strip both setup input variables and existing node-only configuration from the Codex child; preserve the node child's restricted environment.

### Keep existing lifecycle guarantees

Early Harness readiness still checks Codex and plugins, allowing the Gateway to start. Overall preparation and activation still require the exact Agent-and-Harness-owned node to connect with the required commands; file presence is not readiness or authentication.

The [enrollment client](../apps/controller/src/gateway/node-enrollment-client.ts) remains the authority for setup issuance, completion, and exact-node connection. Keep current Secret ownership, update/retirement rules, setup-expiry renewal, and worker cancellation behavior.

Preserve [workspace storage and credentials](../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md), including per-Agent-and-Harness private identity on the per-Agent RWO PVC and predecessor draining. A recreated Pod reuses saved native credentials with the current setup code. Preserve existing automatic renewal; do not add another status store, listener, or workload API permissions.

The credential file stays outside the workspace. This preserves the current same-container trust model; it does not create a security boundary between Codex and the node.

## Implementation

1. In Kubernetes Compute, separate the static node descriptor from readiness-dependent setup issuance. Render the optional projection from both ordinary Harness construction paths while preserving provider input selection.
2. In `AGENT_WITH_NODE_ENTRYPOINT`, add delayed node launch to the existing supervisor without delaying Codex on enrollment.
3. Extend the three proof surfaces below and retain existing native pairing/reconnect coverage unchanged.
4. Update the [Harness execution flow](../docs/flows/harness-execution-topology.md) and [storage reference](../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md) to match the implementation.

No public configuration, database migration, Secret schema, or native API change is required. Adopting the changed template can cause one normal rollout; subsequent enrollment must not cause another.

## Verification

For this PR, the user approved deferring plugin-enabled acceptance and comparative timing after both baseline and candidate failed native `plugin/list` startup. The required real-Kubernetes acceptance uses the API-key workflow, including stable enrollment, workspace/model operations, retained storage, and credential recovery. The plugin and timing procedures below remain follow-up work; no latency improvement is claimed.

| Surface                                                                           | Required outcome                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Controller conformance](../tests/conformance/kubernetes-compute.test.mjs)        | The full Harness template stays equal across Gateway readiness, one setup issuance, and `deviceId` persistence. Cover initial and replacement-recovery paths; final readiness still requires native connection. Existing provider/embedded coverage remains valid.      |
| [Supervisor conformance](../tests/conformance/workspace-node-supervisor.test.mjs) | Delayed file arrival starts one node while Codex keeps its PID/start count. Projection replacement, later updates, invalid input, node-only restart, and shutdown preserve supervision and credential filtering. Retain existing Codex-restart coverage.                |
| [Real K3d topology](../tests/integration/harness-topology-k3d-real.test.mjs)      | An API-key-authenticated dedicated Codex revision retains its Harness Pod UID, template hash, and Codex process identity through enrollment. Verify authenticated workspace file access and a model turn after activation; preserve predecessor, ownership, and PVC assertions. |

The permanent Kubernetes regression retains its API-key authentication and recovery assertions. Run the plugin-enabled acceptance proof separately with the supported `codex_pat` binding: API-key login exposes a different native plugin marketplace. Keep the production enrollment path and observation logic identical, and require successful plugin initialization without deployment warnings.

Keep the existing [native pairing/reconnect integration](../tests/integration/runtime-image-startup.test.mjs) and its [direct-CLI fixture](../tests/fixtures/runtime-workspace-node.mjs) unchanged. They do not exercise the supervisor's file delivery; no new delayed-file or expiry-specific case belongs there.

Compare repeated baseline and candidate deployments with the same cluster, images, configuration, and model credentials. Record warm/cold conditions, sample count, median/range, first Harness readiness, Secret creation, file visibility, node connection, and overall readiness.

Acceptance requires zero enrollment-induced Harness/Codex restarts with working workspace access and activation. Claim a latency improvement only after measuring repeatable net savings without worse reliability; Secret propagation may consume the expected gain. Record exact controller/runtime revisions with proof.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-29: Main independently shipped the feature in #616. Preserved its newer implementation and kept only the Kubernetes test-fixture repairs in this follow-up. Earlier live proof used controller base `8f3fc12c` and runtime `01d7131`; it does not qualify the newer main runtime.

- 2026-09-29: User approved publishing the scoped implementation with plugin-enabled and timing proof deferred. Retained the failed results and withheld any latency improvement claim.

- 2026-09-29: Verified stable enrollment, workspace/model operations, retained storage, and credential recovery on real Kubernetes. Retained completed full-run scenarios and passed a focused recovery rerun after repairing stale fixtures. Plugin-enabled baseline and candidate deployments both fail the existing native `plugin/list` startup deadline; no latency improvement is claimed.

- 2026-09-29: Integrated current main’s Agent-and-Harness identity and setup renewal; node retries reread the projected code while running nodes remain undisturbed.

- 2026-09-29: Implemented the stable Pod and delayed node launch. Separated the API-key regression from the PAT-authenticated plugin proof after validating native catalog behavior; live Kubernetes verification remains pending.
- 2026-09-28 22:46: Simplified the approved implementation and limited new proof to controller, supervisor, and real K3d behavior; retained native pairing coverage unchanged. ([session](codex://threads/01a0ead5-66c0-7a72-a9ab-1188a7b4ce75) - 11755a9c510538054e0f158fbd8274cbcb971c60)
- 2026-09-28 22:33: Investigated the enrollment-induced Harness replacement and proposed an optional Secret-file handoff with independent node launch. ([session](codex://threads/01a0ead5-66c0-7a72-a9ab-1188a7b4ce75) - 2a191c74c0079e329db130d0a81a1f0f87869bb9)
