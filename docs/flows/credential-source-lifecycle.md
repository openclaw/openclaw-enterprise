---
created: "2026-09-26"
updated: 2026-10-09
last_updated_session: 01a11d95-ebef-76e1-b9b9-9d3d2e88e99e
---

# Credential source lifecycle Flow

## Overview

OCC authorizes and records Namespace credential sources, binds them to Agents,
and freezes their identities in revisions. The worker resolves those records
for Compute; the paired Gateway/Sandbox attaches and injects credentials. OCC
stores metadata and Secret references, never values. This flow also covers
updates, withdrawal, deletion, and recovery; [refresh](credential-source-refresh.md)
and [Sandbox provisioning](openshell-sandbox-provisioning.md) own their internal steps.

## Entry Points

- Trigger: `POST`, `PATCH`, or `DELETE /namespaces/:namespaceId/credential-sources[/:credentialSourceId]`,
  Agent create or PATCH and `POST …/agents/:agentId/deploy`, and
  `POST …/agents/:agentId/credential-sources/:credentialSourceId/withdraw`.
- Source: `apps/controller/src/http/credential-sources.ts:createCredentialSource`
- Source: `packages/occ/src/index.ts:createCredentialSource`
- Source: `packages/occ/src/index.ts:deleteCredentialSource`
- Assumptions: the Installation selected a Credential Gateway that belongs to an
  `openshell` Backend, a Sandbox, and bundled Kubernetes Compute; the Namespace
  is `ready`; the caller holds the grants named in each phase.

## Flow

```mermaid
graph TD
  A["<b>POST credential source</b><br/>API request"] --> B{"<b>Catalog and grants</b><br/>type, fields, secret:operate"}
  B -- "invalid or denied" --> X["<b>Reject</b><br/>No gateway call"]
  B -- "valid" --> C["<b>Read Secret values</b><br/>SecretDriver.withValue"]
  C --> R["<b>Commit record</b><br/>state registering"]
  R --> D["<b>registerSource</b><br/>Gateway stores copy"]
  D -- "failed or unknown" --> Y["<b>removeSource</b><br/>Delete record, or keep it deleting"]
  D -- "ready or pending" --> E["<b>Mark ready</b><br/>with audit"]
  E --> F["<b>Bind to Agent</b><br/>actor operate"]
  F --> G{"<b>deployAgent</b><br/>gateway, Sandbox, both grants"}
  G -- "Secret-backed method" --> Z["<b>409 conflict</b><br/>No env fallback"]
  G -- "admitted" --> H["<b>Freeze snapshot</b><br/>sourceId, gateway, type, loginMode"]
  H --> I{"<b>Worker dispatch</b><br/>grants and live record"}
  I -- "mismatch or unavailable" --> W["<b>Permanent failure</b><br/>Revision stays inactive"]
  I -- "ready" --> J["<b>Compute receives source</b><br/>Attachment handoff"]
  J --> P{"<b>Source login mode</b>"}
  P -- "api_key" --> Q["<b>Sandbox provisions Harness</b><br/>API-key placeholder"]
  P -- "chatgptAuthTokens: custom OpenShell" --> T["<b>Driver supplies attachment</b><br/>Placeholder and account metadata"]
  T --> U["<b>Codex entrypoint</b><br/>Ephemeral external-mode auth.json"]
  U --> V["<b>Native model probe</b><br/>Then app-server startup"]
  E --> K["<b>DELETE</b><br/>refused while referenced"]
  K --> L["<b>Mark deleting</b><br/>then removeSource"]
  L -- "gateway failure" --> M["<b>503</b><br/>Record stays deleting"]
  L -- "removed" --> N["<b>Delete record</b><br/>Namespace may empty"]
```

## Execution Trace

Registration and deletion reject active or inherited stale transaction contexts
before effects. Each commits its intermediate record before external calls.

### 1. Admit the registration request

`apps/controller/src/http/credential-sources.ts:createCredentialSource`,
`packages/occ/src/index.ts:createCredentialSource`

The route accepts `name`, `type`, optional `config`, and optional lowercase-keyed
`secrets`. One transaction locks the Namespace, authorizes
`credential_source:create`, requires a selected gateway
(`409 CREDENTIAL_GATEWAY_NOT_CONFIGURED`) and a `ready` Namespace, then calls
`listSourceTypes`. Before credential I/O, an unoffered type raises
`CredentialSourceTypeNotOfferedError` (`409`); unknown or missing fields raise
`ScopeViolationError` (`404`).

### 2. Read Secret values

`packages/occ/src/index.ts:createCredentialSource`

Cross-Namespace Secret references raise `SecretBindingValidationError`
(`400 INVALID_REQUEST`). OCC then authorizes `secret:operate`, locks each Secret
(`404` if absent), and calls its Driver's `withValue` (`503` if unsupported).
The Kubernetes Driver verifies ownership labels, UID, and key before decoding.
Values remain in memory only for the authorized external call.

### 3. Register with the gateway and commit

`packages/occ/src/index.ts:createCredentialSource`,
`packages/occ/src/index.ts:abandonCredentialRegistration`,
`apps/controller/src/drivers/credential-gateway/openshell.ts:registerSource`

The transaction commits a `registering` source and its Secret references before
external effects. OCC resolves Compute's Sandbox namespace and calls Gateway
`registerSource` with a 30-second deadline. OpenShell creates the workspace
profile and labeled provider; replay adopts only matching ownership. Refresh
material goes only to the paired Refresh Driver, with initialization described
in the [refresh flow](credential-source-refresh.md).

A definitive failed/absent result triggers cleanup and record deletion; failed
cleanup leaves `deleting`. A thrown call may still take effect, so cleanup always
retains `deleting` for a later DELETE. Success commits `ready` and mutation audit
atomically. A failed commit leaves `registering`, which blocks binding/admission
but permits deletion. If concurrent DELETE already won, OCC removes the external
copy again and returns `409`.

### Device authorization and configuration

`packages/occ/src/index.ts:startAgentDeviceAuthorization`,
`pollAgentDeviceAuthorization`, `withPluginDiscoveryCredential`

Device authorization registers the source before the paired Refresh Driver
receives issuer material. OCC fences the private session and returns only the
ready source reference. Gateway `withSourceToken` supplies access credentials to
an authorized callback and may trigger external refresh. The
[refresh flow](credential-source-refresh.md#device-authorization-and-configuration)
owns exchange, handoff, retrieval, and cancellation boundaries.

### 4. Bind the source to an Agent

`packages/occ/src/index.ts:authorizeHarnessAuthSource`

PATCH authorizes `credential_source:operate` on already-bound sources without
lookup (`authorizeBoundCredentialSources`), allowing removal after gateway
changes. Create and PATCH authorize requested sources, then reject a missing
gateway with `CredentialGatewayNotConfiguredError` (`409`) before lookups.
Sources must be `ready`, in the exact Namespace, and owned by the selected
gateway. The foreign key on `agents.harness_auth_credential_source_id` prevents
deleting a draft's Harness source.

Every entry of `credentialSources` follows the same checks
(`packages/occ/src/index.ts:authorizeAgentCredentialSources`), which also
requires a credential-source `harnessAuth` to name a listed entry
(`assertHarnessSourceListed`, `AgentCredentialSourceBindingError`, `400`). That
rule runs after every source check, so a caller without `operate` gets `403`
first. The list is stored in
`agents.credential_sources`; the constraint
`agents_harness_credential_source_listed` enforces the same rule, and the trigger
`agent_credential_sources_are_synchronized` mirrors the list into
`agent_credential_sources`, whose foreign key restricts source deletion.

### 5. Admit the deployment

`packages/occ/src/index.ts:deployAgent`, `packages/occ/src/index.ts:admitHarnessAuth`

`assertCredentialGatewayDelivery` rejects `api_key` and `codex_pat` with `409` while a gateway is selected. For
`credential_source`, `admitHarnessAuth` authorizes the Agent service principal's
`operate`, requires a `ready` source, and reads its catalog type, which must
declare `harnessAuth`. The frozen snapshot is `{ method, sourceId,
credentialGatewayId, sourceType, loginMode }`. `admittedCredentialSourceType`
requires a selected Sandbox, and Compute `validateHarnessAuth` requires
a dedicated Codex or native OpenClaw Harness, the paired Sandbox and gateway,
and an `openai`/`api_key` type. Dedicated Codex also accepts an
`openai`/`chatgptAuthTokens` type from a Driver implementing the external-auth
contract. Compute renders no model Secret for either Harness and passes the
resolved source to Sandbox provisioning.
`admitCredentialSources` refuses a list without a selected Sandbox Driver
(`409` with its message), rechecks the caller's binding grants, then authorizes
the Agent principal's `operate` on every listed source, including the Harness source, checks each type against the
catalog, and freezes `{ sourceId, credentialGatewayId, sourceType }` entries in
the revision's `credential_sources`.

### 6. Resolve the source at dispatch

`apps/controller/src/worker.ts:authorizeRevision`,
`apps/controller/src/worker.ts:resolveRevisionSecretContext`

The worker rechecks `credential_source:operate` for the deploying actor and the
service principal; a denial ends the work item with `AUTHORIZATION_DENIED`. It
then compares the snapshot's gateway ID with its selected Driver
(`CREDENTIAL_GATEWAY_MISMATCH` on a difference) and loads the current record. A
missing or `deleting` source, or one whose Driver or type differs, returns
`HARNESS_AUTH_SOURCE_UNAVAILABLE`. Otherwise it passes the snapshot plus the
record to Compute, which rechecks the match in `harnessAuthForRevision`. It
loads each other listed source the same way, skips the Harness source and any
source withdrawn from the revision, and returns `CREDENTIAL_SOURCE_UNAVAILABLE`
for one that is missing or changed.
Compute checks the list in `credentialSourcesForRevision` and attaches it after
the model source. The next owner is the [OpenShell Sandbox provisioning flow](openshell-sandbox-provisioning.md#2-derive-the-provider-owned-harness-request).

For `chatgptAuthTokens`, Gateway `attachForRevision` returns the placeholder and
trusted account metadata. Compute's `credentialSourceEnvironment` passes them to
the native entrypoint, which writes ephemeral external-token `auth.json` before
the model probe and app-server startup. No refresh token reaches Codex.
OpenShell's `sandboxCommand` wraps the stable placeholder as a JWT alias; the
custom injector preserves credential identity across rotations. See the
[external-auth contract](../reference/drivers/credential-gateway.md#external-chatgpt-authentication).
The repository's default pinned images lack the full integration; no legacy Agent refresh bundle is imported.

### 7. Delete the source

`packages/occ/src/index.ts:deleteCredentialSource`,
`apps/controller/src/drivers/credential-gateway/openshell.ts:removeSource`

The transaction authorizes `delete`, requires a selected gateway (`409`), and
locks the source. Agent draft, active revision or pending deployment references
return `409`; withdrawal-only references return `CREDENTIAL_WITHDRAWAL_IN_PROGRESS`;
another owning Driver returns `503`. It moves `registering` or `ready` to
`deleting`; triggers forbid leaving that state or returning to `registering`.
Outside the transaction, OCC removes refresh state through the selected Refresh
Driver, then Gateway `removeSource` confirms deletion of the owned provider,
then its profile if no same-type provider remains. Failure leaves `deleting`
and returns `503`.

Even after removal, OCC retains the record and returns `503` until `CREDENTIAL_REGISTRATION_FENCE_MS`
(70 seconds after `createdAt`): late registration effects and Backend calls each
have a 30-second bound. A second transaction deletes the record and audits it
atomically. Namespace deletion returns `NAMESPACE_NOT_EMPTY` while a record remains.

### 8. Update a source

`packages/occ/src/index.ts:updateCredentialSource`,
`apps/controller/src/drivers/credential-gateway/openshell.ts:updateSource`

One transaction locks the Namespace/source, authorizes `credential_source:update`,
and requires a ready source offered by the catalog (`409` otherwise). For static
sources, it validates replacement references, authorizes every Secret read, and
calls Gateway `updateSource` with Compute's placement. OpenShell requires matching
ownership and nonempty values because `UpdateProvider` merges credentials.
Only subsequently started processes receive the update.

The transaction commits replacement Secret references and audit after the
external write. A failed write rolls back the references; a later commit failure
leaves OpenShell newer until the request is repeated. An absent/failed source
returns `503`. Secret-backed refresh updates use the [Refresh Driver](credential-source-refresh.md#4-update-and-rotation);
device-authorized sources reject PATCH before reading Secrets or changing refresh.

### 9. Withdraw a source from an Agent

`packages/occ/src/index.ts:withdrawAgentCredentialSource`,
`apps/controller/src/worker.ts:processCredentialWithdrawal`,
`apps/controller/src/drivers/compute/kubernetes/index.ts:withdrawCredentialSource`,
`apps/controller/src/drivers/credential-gateway/openshell.ts:withdraw`

The API authorizes `agent:operate` and requires the active revision to list the
source in `credential_sources`. For that revision, each later revision
admitted with the source, and each earlier one not yet retired, it inserts a `pending` `credential_withdrawals` row keyed by revision
and source unless one exists. It makes the caller `requested_by` of
each pending row and queues revision-scoped work with target `credentials_withdrawn`
(`packages/occ/src/state/controller-work.ts:credentialWithdrawalWorkKey`) or
expedites outstanding work. That work never deploys the revision.

The worker rechecks `agent:operate` for each pending withdrawal's
`requested_by` and calls Compute's
`withdrawCredentialSource` for each authorized one in admission order. The work retries while an authorized withdrawal is unconfirmed;
otherwise a denied requester fails it after the others are revoked, unless a
replay reassigned it. Each
revocation is audited for its requester in the pass that confirms it; each
denial or failure, once when the claim ends. The OpenShell Driver calls `DetachSandboxProvider`
on the `harnessResource` Sandbox and reads the receipt's status. Each
attempt records `last_reason` and `last_attempt_at` when its claim ends. `revoked` or `absent`
also marks the row `revoked` and appends
`openclaw.agents.lifecycle.credentials_withdraw`. Other states retry with
backoff. The read
(`packages/occ/src/index.ts:readAgentCredentialWithdrawal`) prefers these
revisions' exhausted rows, then `pending` ones, the active revision's first. Without Compute maintenance, failing the work queues
a bounded later series (`apps/controller/src/worker.ts:scheduleCredentialWithdrawalRecovery`). `withdrawalInProgress` reflects outstanding
work, so `false` means only a replay or maintenance queues another attempt.

Maintenance of the active revision (scheduled only when Compute or repository
credentials set an interval) stops preparing it once its Harness source is
withdrawn
(`apps/controller/src/worker.ts:completeWithdrawnRevisionMaintenance`). While
any withdrawal is `pending`, the pass keeps the chain; once all are `revoked`, it stops. Deploy and repair work never re-attach a withdrawn source:
a Harness source fails them with `CREDENTIAL_WITHDRAWN`. Either maintenance pass re-queues
pending withdrawals with no work outstanding, the other revisions' too
(`apps/controller/src/worker.ts:recoverPendingCredentialWithdrawals`); one denied
or refused waits for a replay. `authorizeRevision` skips the
`operate` recheck for withdrawn sources, so removing their grants cannot end
maintenance.

A withdrawal that finds no Sandbox records `revoked`, yet a create OpenShell
accepted before its worker lost the claim can land later with the source. So
every preparation, and every pass of a Harness-withdrawn revision,
rechecks `revoked` rows
(`apps/controller/src/worker.ts:recheckRevokedCredentialSources`): the OpenShell
Driver detaches the provider again only if `SandboxSpec.providers` lists it.

## Debugging and Verification

- `node --test tests/conformance/credential-source-occ.test.mjs` covers catalog
  validation, grants, registration compensation and recovery, audit, deletion,
  Namespace gating, admission snapshots, and Secret-backed method rejection,
  with an in-process gateway double.
- `node --test tests/conformance/openshell-gateway-wire.test.mjs` checks the
  provider, profile, update, detach, and recheck RPCs against the pinned `v0.1.3-pre.2`
  wire fixture.
- The credential withdrawal cases in
  `tests/integration/postgres-worker-agent-revision.test.mjs` run the real queue
  and worker against PostgreSQL with a Compute double: retries, outages, replays,
  refusals, maintenance, denials, other revisions, lost grants, and late creates.
- The real OpenShell test updates the source and withdraws a `bearer-token`
  source (its placeholder stops reaching an echo service), then the model
  source (the next model turn fails).
- `OCC_TEST_OPENSHELL_K3D_REAL=1 node --env-file="$TEST_ENV_FILE" --test tests/integration/sandbox-driver-openshell-k3d-real.test.mjs`
  registers an `openai` source through the production API against a real
  gateway and reads its live `ready` status. See [OpenShell tests](../testing/openshell.md).
- A source stuck in `deleting` returns `503` on delete until the gateway is
  reachable; `GET` shows its live `status`.
- Worker reason codes `CREDENTIAL_GATEWAY_MISMATCH` and
  `HARNESS_AUTH_SOURCE_UNAVAILABLE` mean a changed selection or an unavailable
  source; `CREDENTIAL_WITHDRAWN` a withdrawn revision source, and
  `CREDENTIAL_WITHDRAWAL_PENDING` an unconfirmed revocation. `CREDENTIALS_WITHDRAWN` and `WITHDRAWAL_REVISION_RETIRED` complete the work,
  and `CREDENTIAL_WITHDRAWAL_UNSUPPORTED`, `COMPUTE_DRIVER_MISMATCH`,
  `CREDENTIAL_WITHDRAWAL_MISCONFIGURED`, `CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT`,
  and `AUTHORIZATION_DENIED` fail it at once.

## Related docs

- [Credential sources](../reference/credential-sources.md)
- [CredentialGatewayDriver contract](../reference/drivers/credential-gateway.md)
- [OpenShell Credential Gateway](../reference/drivers/openshell-credential-gateway.md)
- [Secret storage and delivery](secret-storage-and-delivery.md)
- [OpenShell Sandbox provisioning](openshell-sandbox-provisioning.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-09 20:28: Retain external Harness authentication alongside explicit Agent source-list admission. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - ece639c78)

- 2026-10-09 08:30: Replays take over withdrawal work. (fix-892-894)
- 2026-10-09 06:00: Exhausted withdrawals retry later without Compute maintenance. (fix-887)

- 2026-10-09 17:37: Trace Refresh-owned device authorization in the accompanying merge. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - 1c2fbd2bc2953430e3ddaf68882176c6943ea7b2)

- 2026-10-09 17:01: Trace operator-TLS retrieval and Gateway-owned refresh in the accompanying change. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - 4f902e2ab7738568fc8bb278296e54255355b8b7)

- 2026-10-08 12:47: Trace the experimental OpenShell device-login, warm-read, and JWT-placeholder integration in the accompanying local change. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - ece639c78765727a67753639f6ab225a243e064d)

- 2026-10-08 20:30: Maintenance leaves denied withdrawals for a replay. (fix-853)
- 2026-10-08 17:30: Withdrawal covers unretired predecessors. (fix-816-819)
- 2026-10-08 16:00: Preparation rechecks revoked withdrawals against a late Sandbox create. (fix-790)
- 2026-10-08 14:00: An unoffered source type is a `409` naming the fix, not `404`; worker credential codes have their own status messages. (fix-821-824)
- 2026-10-08 12:00: A withdrawal also covers later revisions admitted with the source. (fix-810)
- 2026-10-08 11:45: DELETE checks gateway ownership before `deleting`. (fix-811-812 - e461e1621)
- 2026-10-08 10:00: Replays take over stranded withdrawals; withdrawn sources skip the grant recheck. (fix-787-788)
- 2026-10-08 09:30: Agent PATCH needs only `operate` on already-bound sources. (fix-782)
- 2026-10-08 09:00: Deploying listed sources without a Sandbox Driver returns `409` with its message, not the generic "already exists". (fix-786)
- 2026-10-08 08:30: Agent binding reports a missing Credential Gateway as `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` and an unlisted Harness source as `400`, after the caller's `operate` checks. (fix-783-784)
- 2026-10-07 18:00: Unified binding: one `credentialSources` list holds every source, and a credential-source `harnessAuth` names a listed entry. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - ee950468c)
- 2026-10-07 12:07: Unify imported and managed PAT authentication while preserving source ownership and existing OAuth behavior. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - be5006e62)
- 2026-10-06 21:30: Keep tool-withdrawal recovery scheduled after model revocation without preparing the revision again. (pr-851-rebase - bb6c7449b)

- 2026-10-07 17:36: Trace source-owned device authorization and warm configuration discovery; remove legacy OAuth fallback. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - da984340ae4aafb03bb0c66bfd94ba40252625a5)

- 2026-10-07 00:22: Documented the external ChatGPT placeholder and account-metadata handoff into native Codex in the accompanying change. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - ca0df6314ddddabc2f039de791f35c2e5de7ec43)
- 2026-10-03 18:00: Registration and update reject a Secret reference to another Namespace as an invalid request instead of not-found, as Secret bindings do. (binding-400b)
- 2026-10-03 16:00: Report `withdrawalInProgress` so an exhausted withdrawal no longer reads as in progress; maintenance re-queues only where it is scheduled. (fix-withdrawal-exhausted)
- 2026-10-02 10:00: Authorized each batched withdrawal by its own requester and recovered pending non-model withdrawals during maintenance. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 92e33389d)

- 2026-10-01 21:30: Added non-model sources bound through `credentialSources`, their admission, dispatch and withdrawal. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 9a202599b)
- 2026-10-01 20:30: Report a missing Credential Gateway as `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` at registration. (fix-d93-d100)
- 2026-10-01 11:37: Updated the OpenShell wire-fixture pin to v0.1.3-pre.2. (authoring-run/f1f395c4-2594-4b07-9e92-ae829a5b5dd4 - f22a584e6ce21d505b40a72fdb5ae1c6e74c1c84)
- 2026-09-30 21:14: Updated the independent OpenShell wire-contract verification pointer to v0.1.3-pre.1. (authoring-run/b158c89c-3010-42ae-95b4-350b05de7441 - 37bbee705ea3808ad000413dd54bdcc718980179)

- 2026-09-30 04:00: Recorded withdrawal attempt reasons, replay deduplication, and maintenance of a withdrawn revision; corrected the update ordering. (pr-553-alignment - 3a5e48035)
- 2026-09-28 18:00: Added source update and per-Agent withdrawal through worker-executed revocation. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 7cd4a210)
- 2026-09-28 05:13: Documented the controller transaction boundary for credential source writes. (authoring-run/5da74b2e-b249-44da-87e4-ca85f018c832 - 646b067220f6b7f8f3059eaa0710db2654b61499)
- 2026-09-27 22:51: Extended credential-source Harness delivery to dedicated native OpenClaw without projecting the model Secret. (authoring-run/88764ea7-c6bb-4ac8-919f-c21071946c37 - 859c0b11e5f1c350acda231c89ad3573504324eb)
- 2026-09-26 14:29: Documented credential source registration, Agent binding, admission, dispatch resolution, and retried deletion for the uncommitted Credential Gateway change. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 849b2b24111fe237b12da5be1d4b411d3146cefb)
