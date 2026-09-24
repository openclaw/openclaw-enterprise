# OAuth credentials during Agent activation

**Date:** 2026-09-19\
**Status:** Implementing\
**Owner:** OCC activation and the selected OpenClaw Harness integration\
**Current reference:** [Agent OAuth authorization](../docs/reference/agents.md#deployment-oauth-authorization), [Harness authentication](../docs/reference/harness-execution.md#harness-authentication), and the [Harness execution topology flow](../docs/flows/harness-execution-topology.md)

## Problem and Decision

When OAuth is selected, OpenClaw Enterprise (OCE) must collect provider authorization before Agent activation succeeds. Recommend an auth runner in the Agent's own gateway Pod, reusing OpenClaw's provider login implementation and mutable credential store. OpenClaw Control Plane (OCC) authorizes the operation and relays consent instructions; tokens stay with that Agent. No installation-wide gateway or OCC refresh service is required.

The approved first delivery supports OpenAI device authorization with embedded OpenClaw on Kubernetes, for a new or fully stopped Agent. Reconnection requires stopping first. Dedicated Codex uses different native credentials and remains deferred.

## Scope

- Required: compare CLI and installation-gateway reuse; collect consent during activation; retain exact Namespace/Agent authority, isolated custody, refresh, retry, cancellation, and observable success.
- Proposed: one Agent-local OpenAI profile, one current connection attempt, and one consent actor. No cross-Agent credential sharing or automatic account switching.
- Provider OAuth authorizes model access. OCC login identifies the operator; gateway transport auth protects the runtime connection; workload identity identifies the Agent; harness auth selects model credentials. None substitutes for another. OCE's Installation-owned `Provider` is not the OpenClaw model-provider ID.
- Non-goals: OCC SSO, Control UI exposure, arbitrary OAuth providers, general shells, installation-wide personal accounts, dedicated Codex OAuth, or a generic credential framework. Existing API-key and managed service-account paths remain supported.

## Evidence and options

OCE baseline: `3e2187949462afda2ca09f987a3a37518d11a124`. Current [bindings](../packages/contracts/src/index.ts) support `api_key`, `chatgpt_service_account`, and host-managed `runtime`; [admission](../packages/occ/src/index.ts) and the [worker](../apps/controller/src/worker.ts) enforce exact source ownership. Kubernetes rejects `runtime`; its embedded [startup probe](../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts) requires an OpenAI API key and a temporary empty auth home. OAuth needs deliberate admission and readiness changes.

OpenClaw inspected: `083b498270124a059db70714b5df93d973391ee0`, package `2026.9.3`. Its [CLI](https://github.com/openclaw/openclaw/blob/083b498270124a059db70714b5df93d973391ee0/src/commands/models/auth.ts#L1101-L1112) requires a TTY. Its [unpersisted provider-method runner](https://github.com/openclaw/openclaw/blob/083b498270124a059db70714b5df93d973391ee0/src/plugins/provider-auth-choice.ts#L252-L291) accepts structured prompts, cancellation, and current-authority checks; that helper is internal. The supported `openclaw/plugin-sdk/provider-auth-managed-login-runtime` SDK wrapper for `runModelsAuthLoginFlow` belongs to the separate native prerequisite branch, not the inspected upstream package or current upstream main `89ed`. Consume a verified prerequisite image and extend that managed persistence boundary rather than introducing another login engine.

| Option                 | Reuse and consent                                                                                                                                                                       | Isolation, cost, and feasibility                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI during activation  | `openclaw models auth login --provider openai --method device-code`; user approves in a separate browser. `--method oauth` uses PKCE, loopback callback, or manual redirect/code entry. | Works interactively in isolated target-Agent state. Headless servers still need a TTY/prompt bridge; browser localhost is not the remote Pod. CLI writes profiles/config. Terminal scraping and importing an operator's existing login are unsuitable managed interfaces.                                                                                                                                                 |
| Installation gateway   | Newer source has real `users.authConnect.start/answer/status/cancel/catalog` RPCs and personal-account consent.                                                                         | Adds an always-running gateway and shared custody. [Current RPC](https://github.com/openclaw/openclaw/blob/083b498270124a059db70714b5df93d973391ee0/src/gateway/model-account-connect.ts#L313-L369) stores a verified Gateway person's account, not an OCE Agent credential. Requires tenant authority mapping and a new transfer/refresh contract. Sharing the gateway grants no shared credentials or tenant authority. |
| **Agent-owned runner** | Reuse the underlying provider method; initially OpenAI device code only. Relay verification URL, short-lived user code, and safe status.                                                | Short-lived process in the eventual gateway Pod and existing private storage. Requires a narrow managed-commit extension to the public SDK and an OCE runtime adapter; avoids a separate deployment, callback server, token export, and refresh owner.                                                                                                                                                                    |

The [device flow](https://github.com/openclaw/openclaw/blob/083b498270124a059db70714b5df93d973391ee0/extensions/openai/openai-chatgpt-device-code.ts#L419-L458) polls and exchanges credentials server-side. Device authorization availability is an acceptance prerequisite; unavailable device auth fails explicitly. Browser PKCE fallback is deferred. Earlier OpenClaw `759e127777b54426c922e8ab4c228523ddac04e9`, cited in OCE, has provider login methods but lacks `users.authConnect.*`. Neither inspected commit proves the installed image's capabilities; implementation must pin and verify the runner-enabled image.

## Contract

### Ownership and binding

Extend `HarnessAuthBinding` with `{ method: "oauth" }`. The selected Harness/Compute validates model/provider compatibility and owns the fixed native profile `openai:occ-managed` inside its exact Agent-private state. OCC carries no provider-specific selector or caller-supplied filesystem/profile path. Revisions freeze the binding, not tokens. Existing operation/audit records retain the connecting OCC actor; native OAuth metadata alone retains the verified upstream account/user subject. Reconnect must match that subject even after native refresh-failure fencing; changing accounts is deferred.

Consent names Installation, Namespace, Agent, provider, and delegated Agent use. The original actor needs exact Agent `deploy` and Configuration `read` at admission, before credential commit, and before activation. Start/status/complete bind to that actor and exact current revision/attempt. Cancellation uses the existing Agent stop operation and its `operate` permission. Authorized Agent stop can cancel another actor's attempt without exposing prompts or credentials. A Gateway person, token, provider subject, or attempt ID grants no OCC authority.

The Harness integration owns acquisition, native persistence, refresh, and model authentication. Compute owns placement, private storage/transport, and lifecycle. OCC owns binding metadata, IAM, ordering, and audit. The Secret Driver keeps its static-secret role and receives no OAuth copy. OpenClaw [rejects OAuth SecretRefs](https://github.com/openclaw/openclaw/blob/083b498270124a059db70714b5df93d973391ee0/docs/auth-credential-semantics.md#L141-L147) because refresh mutates the native store.

Persistent OAuth custody extends the scoped direct-credential exception in [current safeguards](../docs/design/safeguards.md#secret-access). The target architecture calls for brokerage without provider credentials in workloads. The implementation request accepts this interim exception; the target architecture remains unchanged.

### Activation and consent

1. Select OAuth and a compatible model/Harness, then **Connect and activate**. For reconnect, require completed [Agent stop](../docs/reference/agents.md), including execution/routing removal; desired stopped state alone is insufficient.
2. Ordinary deployment admission freezes the binding and queues the revision. Reject unsupported Compute/Harness/model/runtime capability before provisioning. OAuth never automatically changes the model.
3. Revision preparation creates the ordinary gateway Pod in new **auth-only startup** mode. Only the pinned provider auth runner runs: no normal gateway traffic, channels, tools, cron, user plugins, or model execution. Mount private storage only into this exact owner.
4. Authenticated Console/CLI starts an Agent/revision-scoped attempt through OCC. Compute reaches the pending runner using private authenticated transport, without a public gateway route or `pods/exec`. OCC rechecks exact ownership/authority on every request. Return verification URL and short-lived code only through the authenticated response.
5. The user approves on the provider's site. Hold returned credentials in runtime memory until OCC reauthorizes the original actor and confirms current revision, binding, attempt, and running intent. Fence native commit so late/cancelled results cannot overwrite the selected profile. Ignore provider-result config patches that alter the admitted model or Configuration.
6. Run one bounded model probe using exactly that native profile, with tools and fallback disabled. Then hand off to normal gateway startup. Existing worker readiness and guarded activation establish serving state and activation audit. OAuth completion alone is not success. The existing deployment status remains authoritative for activation; OAuth observations describe consent only, without new persisted Agent lifecycle states.

Do not hold a worker claim while awaiting the browser. Reuse `pending` and queue deferral with an auth-required observation; preserve stop and supersession checks. Bound consent by the earlier of provider expiry and the existing convergence deadline (currently 15 minutes from work creation). Waiting does not consume infrastructure-failure attempts. Expiry fails the pending deployment with an actionable retry message.

### API and runtime contract

Use the existing deployment path `/namespaces/:namespaceId/agents/:agentId/deployments/:deploymentId` as the parent; all responses use the existing `{data,meta}` envelope. Authenticate through OCC, require original deployment actor plus current Agent `deploy` and Configuration `read`, verify the exact revision, latest unsuperseded operation, and running intent. Unsupported capabilities fail explicitly before side effects.

| Operation                                | Request and response                                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST .../auth`                          | Empty body; start or return the current attempt. Response is the consent observation below. Only one current attempt per Agent is allowed.                                                                                                                                  |
| `GET .../auth`                           | Return current consent observation only to the initiating actor; no long polling or persisted device code.                                                                                                                                                                  |
| `POST .../auth/complete`                 | `{attemptId}`; require the current attempt and unexpired authorization. Recheck authority/current intent immediately before native commit. Retry of the same successful commit returns its acknowledgement; an unknown outcome is reread, never converted into a new login. |
| Existing `POST .../agents/:agentId/stop` | Cancel through normal stop authorization, intent ordering, and runtime teardown. No separate cancellation or Disconnect UI is added.                                                                                                                                        |

Consent observations are `preparing`, `waiting`, `authorized`, `committed`, or `failed`. A live attempt includes `attemptId` and `expiresAt`; only `waiting` includes the provider-allowlisted `verificationUrl` and `userCode`. `failed` carries a fixed safe reason (`denied`, `expired`, `cancelled`, `account_mismatch`, or `unavailable`), never provider output. `authorized` means credentials remain in runner memory; Console/CLI automatically calls complete. `committed` does not imply model acceptance. Clients then observe existing `queued|running|succeeded|failed` deployment status until normal activation completes.

The runner alone owns volatile attempt/code state, scoped to immutable Namespace/Agent/revision identity supplied at startup. Process restart invalidates unfinished attempts. Only the OAuth binding is added to persisted Agent/revision shapes; existing work and audit retain outcome/actor evidence. Native profile metadata owns upstream account/user identity, including reconnect matching after refresh rejection. OCC never reads that subject or credential payload.

Extend the selected Compute contract for start/status/complete; keep transport and native-provider details in the implementation. A trusted runtime operation must target the exact owned pending Pod, authenticate with an Agent-scoped transport credential, reject stale revision/attempts, and remain private. A short-lived completion grant bounds uncertain responses; native managed mode checks cancellation/current attempt synchronously after acquiring profile locks and immediately before SQLite replacement. Consent acquisition uses the public SDK; its managed mode suppresses config/default changes and stores exactly one selected OAuth profile. Native writes and audit acknowledgement can have an unknown outcome; fail closed and observe the same attempt instead of destructive compensation.

### Storage, refresh, and recovery

Use the Agent-local native store on the existing [private gateway PVC](../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage), including SQLite WAL/SHM siblings. Keep tokens out of shared workspaces, OCC resources/revisions, ConfigMaps, environment snapshots, URLs, logs, audits, and reports. Operators must encrypt and restrict the disk/backups. The runner receives no controller-wide credential or Kubernetes Secret write authority.

OpenClaw is the sole refresh owner and persists rotated credentials in that store. Disable external CLI discovery and unselected/shared-profile fallback. Restarts reopen the store without reseeding old refresh tokens. Unfinished consent is lost on runner restart and needs a new attempt; committed credentials survive. If the runner dies after commit but before acknowledgement, the lost attempt returns `failed: unavailable`; retain the credential for an explicit deployment retry and native probe without forcing another consent. Reuse only the exact binding/account, then repeat the activation probe.

Runner and normal gateway must not refresh concurrently. Reuse single-replica `Recreate` and hand off before execution starts. RWO is not process fencing: retain operator fencing of uncertain previous writers after partitions or forced replacement. Stopped reconnect deliberately trades availability for one credential owner; seamless replacement is deferred.

Cancellation, revoked authority before commit, stop, supersession, or expiry revokes commit authority first and aborts polling. Discard unfinished credentials; retry uses a new attempt/code. A committed profile whose probe failed remains available for explicit retry, never reported active. Do not automatically restart OAuth grants. Stop or IAM revocation does not revoke an issued provider grant. Document stop followed by provider-side revocation for immediate containment; local profile cleanup uses a reviewed native operator procedure while stopped. A first-class Disconnect UI is deferred. Terminal refresh rejection requires reconnect; transient refresh failure cannot select another credential.

Audit start, cancellation/failure, commit, denial, and activation with actor, Namespace, Agent, revision, and safe reason. Exclude codes, callback payloads, tokens, and raw provider errors. Status does not prove continuing provider availability after activation.

## Implementation

1. Extend the public OpenClaw `runModelsAuthLoginFlow` managed mode using the existing device-code implementation: isolated prompts, cancellation/fencing, Agent-local commit, fixed-profile selection, and safe status. Package an approved pinned image; OCC must not deep-import undocumented modules.
2. Extend [auth contracts](../packages/contracts/src/harness-auth.ts), API schemas, and existing PostgreSQL Agent/revision shape constraints for the OAuth discriminator only. Extend [OCC admission](../packages/occ/src/index.ts), [worker checks](../apps/controller/src/worker.ts), and Compute capability validation. Reuse Agent operations/queue ownership; no OAuth resource, Driver, or durable consent journal.
3. Extend [Kubernetes Compute](../apps/controller/src/drivers/compute/kubernetes/index.ts) and [entrypoints](../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts) for restricted startup, pending-target transport, and native-profile probing. Preserve default-deny networking; allow the selected provider's required auth/token/model endpoints and control transport. API-key probing is not OAuth proof.
4. Add scoped start/status/complete operations and existing-stop cancellation to Agent Console/CLI activation. No token upload or terminal scraping. Update owning harness/Agent references, flows, and operator/testing guides when implementation ships; index this proposal now.

## Verification

The required implementation acceptance checks follow. The OCE branch currently contains binding, deployment auth, CLI/Console, and Kubernetes handoff work reflected in the current references and flow, but this spec remains `Implementing` until the managed-login prerequisite is available in the selected image and genuine provider consent, refresh, restart, and revocation proof is recorded.

| Required outcome          | Evidence                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consent gates activation  | Console/CLI → OCC → worker → real runner integration: no serving route, channels, tools, or successful activation before consent and native model probe; normal activation afterward.     |
| Exact authority/isolation | Two Agents/actors: reject foreign attempts/profiles, revoked authority, stale completion after stop/supersession; inspect exact PVC/Pod/private transport ownership.                      |
| Headless support          | Authorized browser on another machine approves device code; server has no browser/reachable localhost callback. Missing provider support and denied/expired consent fail explicitly.      |
| Usability and custody     | Genuine model turn, native refresh, Pod restart, and redeployment with persisted rotated token; synthetic sentinels check public/config/log/audit surfaces without exposing live secrets. |
| Recovery has one owner    | Cancel/retry, runner crash before/after commit, failed probe, stopped reconnect, and provider-revocation recovery; stale attempt cannot overwrite credentials or activate.                |
| Scope stays explicit      | Unsupported Harness/Compute/model rejected; existing key/account activation retained. Missing infrastructure/credentials is missing proof, never replaced by fake login.                  |

## Dependency and proof gates

The user approved implementation of OpenAI device code, embedded Kubernetes, stopped reconnect, and Agent-local OAuth custody. Browser PKCE, dedicated Codex, and a Disconnect UI remain deferred. Ship a supported managed-login SDK and verify the pinned image before claiming production support; existing personal-account RPC does not establish OCE authority. Genuine provider consent, refresh, restart, and revocation require authorized live evidence; missing infrastructure or credentials is a reported gap.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-09-19 08:07]: Accept implementation direction; define consent API and runtime ownership, retain native same-account checks, and defer Disconnect UI.
- [2026-09-19 06:58]: Draft source-backed options and proposed Agent-owned OAuth activation for independent review.
