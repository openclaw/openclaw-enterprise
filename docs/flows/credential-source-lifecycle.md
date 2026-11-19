---
created: "2026-09-26"
updated: 2026-11-19
last_updated_session: authoring-run/3443474d-ea8c-4273-8c4f-3b3755f1eee1
---

# Credential source lifecycle Flow

## Overview

OCC authorizes source admission, stores references and hands live sources to Compute.
[Protected sources](credential-source-egress.md) skip Gateway copies and require
unbound migration. Protected revisions refuse legacy attachments.
[Codex OAuth](credential-source-refresh.md#device-authorization-and-configuration)
retains its Gateway and Refresh owners after Git Proxy selection; fresh OAuth is
outside the Git-only static model exception. Without a Proxy, Gateway/Refresh
continues. See [Sandbox provisioning](openshell-sandbox-provisioning.md).

## Entry Points

- Trigger: `POST`, `PATCH`, or `DELETE /namespaces/:namespaceId/credential-sources[/:credentialSourceId]`,
  Agent create or PATCH and `POST …/agents/:agentId/deploy`, and
  `POST …/agents/:agentId/credential-sources/:credentialSourceId/withdraw`.
- Source: `apps/controller/src/http/credential-sources.ts:createCredentialSource`
- Source: `packages/occ/src/index.ts:createCredentialSource`
- Source: `packages/occ/src/index.ts:deleteCredentialSource`
- Assumptions: a `ready` Namespace; an Installation selecting a Credential Gateway in an
  `openshell` Backend, a Sandbox and bundled Kubernetes Compute; and per-phase caller grants.

## Flow

```mermaid
graph TD
  A["<b>POST credential source</b><br/>API request"] --> B{"<b>Catalog and grants</b><br/>type, fields, secret:operate"}
  B -- "invalid or denied" --> X["<b>Reject</b><br/>No gateway call"]
  B -- "valid" --> P0{"<b>Installed source policy</b>"}
  P0 -- "prepared, credential-free or protected static" --> P1["<b>Admit protected source</b><br/>No Gateway copy"]
  P0 -- "no Proxy or validated Git-only static model" --> C["<b>Read Secret input</b><br/>withValue"]
  P0 -- "unsupported or retired" --> X
  P1 -- "live static" --> E
  P1 -- "prepared or credential-free" --> R
  C --> R["<b>Commit record</b><br/>state registering"]
  R -- "Gateway copy" --> D["<b>registerSource</b><br/>Gateway stores copy"]
  R -- "protected source" --> PR["<b>Finalize protected source</b><br/>Prepare issuer if required"]
  PR --> E
  PR -- "lost to DELETE" --> PX["<b>Recorded-owner cleanup</b><br/>No Gateway cleanup"]
  D -- "failed or unknown" --> Y["<b>removeSource</b><br/>Delete record, or keep it deleting"]
  D -- "ready or pending" --> E0["<b>Attempt mark ready</b><br/>Gateway registration"]
  E0 -- "marked" --> E["<b>Commit ready</b><br/>with audit"]
  E0 -- "lost to DELETE" --> Y
  E --> F["<b>Bind to Agent</b><br/>actor operate"]
  F --> G{"<b>deployAgent</b><br/>gateway, Sandbox, both grants"}
  G -- "Secret-backed method" --> Z["<b>409 conflict</b><br/>No env fallback"]
  G -- "admitted" --> H["<b>Freeze snapshot</b><br/>sourceId, gateway, type, loginMode"]
  H --> I{"<b>Worker dispatch</b><br/>grants and live record"}
  I -- "mismatch or unavailable" --> W["<b>Permanent failure</b><br/>Version stays inactive"]
  I -- "ready" --> J["<b>Compute receives source</b><br/>Attachment handoff"]
  J --> P{"<b>Source login mode</b>"}
  P -- "api_key" --> Q["<b>Sandbox provisions Harness</b><br/>API-key placeholder"]
  P -- "codex_pat" --> Q1["<b>Sandbox provisions Codex</b><br/>PAT placeholder"]
  P -- "chatgptAuthTokens: paired OpenShell" --> T["<b>Driver supplies attachment</b><br/>Placeholder and account metadata"]
  T --> U["<b>Codex entrypoint</b><br/>Ephemeral external-mode auth.json"]
  U --> V["<b>Native model probe</b><br/>Then app-server startup"]
  E --> K["<b>DELETE</b><br/>refused while referenced"]
  K --> L["<b>Mark deleting</b><br/>then removeSource"]
  L -- "gateway failure" --> M["<b>503</b><br/>Record stays deleting"]
  L -- "removed" --> N["<b>Delete record</b><br/>Namespace may empty"]
```

## Execution Trace

Registration and deletion reject active or stale inherited controller transactions
with `ResourceConflictError`. OCC commits intermediate state before
`registerSource` or `removeSource`.

### 1. Admit the registration request

`apps/controller/src/http/credential-sources.ts:createCredentialSource`,
`packages/occ/src/index.ts:createCredentialSource`

The route accepts `name`, `type`, optional `config` and lowercase-keyed `secrets`.
OpenAPI publishes the [proposed TokenService schemas](../../packages/contracts/src/api/token-service-sources.ts)
as standalone components. OCC authorizes `credential_source:create`, locks the ready
Namespace and reads the selected Driver's catalog in one transaction.
An unoffered type returns `CredentialSourceTypeNotOfferedError` (`409`). Invalid
values or unknown or missing catalog fields return `400 INVALID_REQUEST` before
Secret reads, record creation or Gateway writes. OCC validates and stores normalized
configuration.

`apps/controller/src/drivers/credential-source-endpoint.ts:validateOpenAiSourceBaseUrl` validates
OpenShell destinations for requests and stored sources: field-specific `400` errors
for requests, `409` for stored endpoints. It normalizes explicit URLs and preserves
omission. Sources require an exact DNS host; Compute and Proxy retain broader URL rules.

OAuth2 validation resolves OpenShell placement to reject token endpoints in the
Gateway's Namespace. Registration repeats the check with tenant placement.
Static OpenAI validation skips placement. The recorded Driver owns source cleanup.

With a selected Proxy, new sources require protected admission except for static
Harness model sources on the validated Git-only installation. Refresh, device login,
OAuth and plugin enrollment are ineligible for that exception. Prepared and
credential-free types use their Proxy owner; protected static admission reads the
live Secret without a Gateway copy.

`packages/occ/src/index.ts:newSourceAdmission` permits configured ordinary Gateway
delivery. Otherwise `staticEgressProvider` selects the external Driver’s first matching
provider. A bundled owner with retirement policy requires one eligible provider for the
type; missing or ambiguous choices refuse before Secret reads. Updates validate the original
profile and eligible successor. Admission rechecks the Gateway, Sandbox pairing, provider,
Proxy references and callbacks through audit.

`packages/occ/src/index.ts:credentialSourceProtection` reports live model protection
on create, GET and list. It checks the exact provider, lifecycle, backend, sender and
resolver. Invalid registrations report `unavailable`; readback does not attest running enforcement.

### 2. Read Secret values

`packages/occ/src/index.ts:readCredentialSourceSecrets`,
`packages/occ/src/index.ts:admitStaticEgressSource`

Cross-Namespace references raise `SecretBindingValidationError` (`400 INVALID_REQUEST`).
OCC authorizes `secret:operate`, then locks each Secret (`404` if absent).
Gateway copies use Secret Driver `withValue` (`503` if unsupported), keeping values
in memory for the authorized call. Live static admission requires
`readCredentialInput` with `retention: "none"`: validate without retaining; reject
missing version evidence or invalid `authoritativeObservedAt` (`503`). `withValue`
alone is insufficient. Kubernetes verifies ownership labels, UID and key before decoding.

### 3. Register with the gateway and commit

`packages/occ/src/index.ts:createCredentialSource`,
`packages/occ/src/index.ts:abandonCredentialRegistration`,
`apps/controller/src/drivers/credential-gateway/openshell.ts:registerSource`

Live static sources atomically commit `ready` and audit, then recheck the record. Other
sources commit `registering`; Gateway registration resolves Compute's Sandbox namespace
and calls `registerSource` (30-second deadline).
OpenShell checks provider ownership before changing the source-owned profile,
creates the labeled provider and rechecks collisions. Calls are non-atomic.
Only Refresh receives refresh material.

Codex PAT profiles include native app metadata and MCP transport; the
[Driver reference](../reference/drivers/openshell-credential-gateway.md#source-type-catalog)
owns the exact source-wide routes.

Definitive failure/absence triggers cleanup and deletion; failed cleanup retains
`deleting`. Thrown calls may take effect, so cleanup retains `deleting` for another
DELETE. Success atomically commits `ready` and audit. Failed commits leave
`registering`: binding/admission fail, deletion remains possible.

If DELETE wins after a Gateway write or Refresh configuration/mint, POST
compensates through the original Drivers. Prepared issuer withdrawal belongs to
DELETE; POST does not replay configuration.

### Device authorization and configuration

`packages/occ/src/index.ts:startAgentDeviceAuthorization`,
`pollAgentDeviceAuthorization`, `withPluginDiscoveryCredential`

OCC registers the source before login. The [refresh flow](credential-source-refresh.md#device-authorization-and-configuration)
traces polling, cancellation, and source use.

### 4. Bind the source to an Agent

`packages/occ/src/index.ts:authorizeHarnessAuthSource`

PATCH checks `credential_source:operate` on existing bindings without looking them
up, so callers can remove a binding after its Driver changes. For each requested
source, OCC checks `operate`, locks the ready source in the Agent's Namespace and
requires its recorded Gateway or Proxy. Harness authentication requires a Gateway.

Missing `operate` returns `403` before checking Harness source membership (`400`).
PostgreSQL mirrors `agents.credential_sources` into `agent_credential_sources`,
preventing deletion of referenced sources.

### 5. Admit the deployment

`packages/occ/src/index.ts:deployAgent`, `packages/occ/src/index.ts:admitHarnessAuth`

`assertCredentialGatewayDelivery` rejects `api_key` and both sources of
`codex_pat` with `409` while a gateway is selected. For `credential_source`,
`admitHarnessAuth` authorizes the Agent principal's `operate`, requires a ready
source whose catalog type declares `harnessAuth`, and freezes `{ method,
sourceId, credentialGatewayId, sourceType, loginMode }`.
`admittedCredentialSourceType` requires a Sandbox. Compute `validateHarnessAuth`
requires dedicated Codex or native OpenClaw, paired Drivers, and
`openai`/`api_key`. Dedicated Codex also accepts `codex-pat`/`codex_pat` or
`openai`/`chatgptAuthTokens` from an external-auth Driver. Compute renders no
model Secret and passes the resolved source to Sandbox provisioning.

`admitCredentialSources` requires a Sandbox (`409`) and rechecks caller and Agent
`operate` on every source. The recorded owner must still offer its type;
a matching Proxy type cannot replace a withdrawn Gateway type.
The revision records `sourceId`, `sourceType` and the owner's `credentialGatewayId`
or `credentialProxyId`. Older sources keep their Gateway owner, even when a Proxy
with the same Driver ID enforces the revision's egress plan.

Both State adapters call
`packages/occ/src/state/platform-state.ts:assertRevisionAuthAvailable` from
`createRevision`. Each listed or Harness snapshot must match a ready same-Namespace source by ID,
type, owner capability and Driver ID; otherwise, `ScopeViolationError`.
`packages/occ/src/state/postgres-state.ts:createRevision` locks all unique source
IDs in one ordered `SELECT FOR SHARE` and holds them through commit. Source-bearing
insertions first take a shared Namespace lock and an Agent key-share lock, following
OCC admission's Namespace, Agent, then source order. Both adapters copy input
before awaiting, then validate, persist and return that copy without reordering
snapshots. Memory checks its transaction snapshot. These checks reject stale or
forged owners on insertion; historical snapshots remain readable after legitimate
source deletion.

### 6. Resolve the source at dispatch

`apps/controller/src/worker.ts:authorizeRevision`,
`apps/controller/src/worker.ts:resolveRevisionSecretContext`

The worker rechecks the deploying actor's and Agent's
`credential_source:operate` (`AUTHORIZATION_DENIED`), the selected Gateway/Proxy
snapshot (`CREDENTIAL_GATEWAY_MISMATCH`) and live source ownership/type.
Unavailable sources return `HARNESS_AUTH_SOURCE_UNAVAILABLE` or
`CREDENTIAL_SOURCE_UNAVAILABLE`. Withdrawn sources stay detached; Compute repeats
snapshot checks before
[Sandbox provisioning](openshell-sandbox-provisioning.md#2-derive-the-provider-owned-harness-request).

Before attachment or release, Kubernetes preparation and activation recheck the
selected Gateway catalog. On a validated Git-only installation, unprotected revisions
without repositories require a static model source. Refresh, device authorization or `chatgptAuthTokens`
stops release. Gateway-only installations and protected plans keep their existing rules.

`apps/controller/src/composition/installation-config.ts` shares the internal
`OpenShellCredentialAttachments` handler only with bundled Sandbox/Gateway
instances on one Backend; Compute verifies those exact instances.
`staticOpenAiAttachmentsForRevision` selects it for unprotected dedicated
Codex/OpenClaw revisions without an egress plan or additional admitted sources:
one admitted `openai`/`api_key` Harness source on the selected Gateway. The
source must match Namespace and snapshot, without an egress binding.
Refusal never retries through Gateway methods.

`apps/controller/src/drivers/sandbox/openshell-credential-attachments.ts` implements
`attachForRevision`, `attachmentStatus` and `withdraw`, shared with public Gateway attachment consumers.

For `chatgptAuthTokens`, `credentialSourceEnvironment` forwards trusted metadata
and a placeholder into ephemeral `auth.json`. OpenShell's `sandboxCommand` wraps
it as a stable JWT alias; upstream injection preserves identity across rotation.
Neither refresh tokens nor legacy bundles reach Codex. See the
[external-auth contract](../reference/drivers/credential-gateway.md#external-chatgpt-authentication).

### 7. Delete the source

`packages/occ/src/index.ts:deleteCredentialSource`,
`apps/controller/src/drivers/credential-gateway/openshell.ts:removeSource`

OCC authorizes `delete`, locks the source and refuses Agent, revision or
pending-deployment references (`409`) and unfinished withdrawal
(`CREDENTIAL_WITHDRAWAL_IN_PROGRESS`). After matching the recorded owner, it
irreversibly marks the source `deleting`.

Prepared material calls issuer `withdraw`; a possibly valid token returns
`409 CREDENTIAL_TOKEN_UNSETTLED`. Credential-free sources have no material.
Otherwise Refresh removes refresh state, then Gateway `removeSource` verifies
ownership and removes the provider and profile.
Existing Gateway-owned live sources still use Compute placement and Gateway removal
on DELETE, including sources whose registration made no Gateway write.
Unknown ownership or a failed read cannot establish absence. Failure leaves
`deleting` (`404` for refused ownership, `503` for an unavailable dependency).

For 70 seconds after `createdAt`, OCC retains the source against late registration.
`packages/occ/src/errors.ts:RetryLaterError` retains the remaining seconds;
`apps/controller/src/http/errors.ts:canonicalFailure` sends `503 DEPENDENCY_UNAVAILABLE`,
`error.reason: "credential_registration_pending"` and `Retry-After`.
After that delay, retry DELETE to remove the record and commit its audit.
Until deletion, the Namespace remains nonempty.

### 8. Update a source

`packages/occ/src/index.ts:updateCredentialSource`,
`apps/controller/src/drivers/credential-gateway/openshell.ts:updateSource`

One transaction authorizes `credential_source:update`, reads the Namespace,
locks the source, and requires a ready catalog source (`409` otherwise).
Device-authorized sources reject PATCH before Secret reads or refresh
changes. Protected updates recheck admission after the success audit. Gateway sources
authorize `secret:operate` and read replacements through `withValue`. Gateway `updateSource` uses
Compute's placement under the source lock; OpenShell requires matching
ownership and nonempty values because `UpdateProvider` merges credentials.
Only newly started processes receive updates.

OCC commits replacement Secret references and mutation audit after the external
write. Failure rolls back references and audits possible Gateway changes. A failed
commit may leave OpenShell newer until retry. An absent/failed source returns `503`. Secret-backed refresh
updates use the [Refresh Driver](credential-source-refresh.md#4-update-and-rotation).

### 9. Withdraw a source from an Agent

`packages/occ/src/index.ts:withdrawAgentCredentialSource`,
`apps/controller/src/worker.ts:processCredentialWithdrawal`,
`apps/controller/src/drivers/compute/kubernetes/index.ts:withdrawCredentialSource`,
`apps/controller/src/drivers/sandbox/openshell-credential-attachments.ts:withdraw`

The API requires `agent:operate` and the source in the selected version's
`credential_sources`. It records a `pending` `credential_withdrawals` row per
version/source, if absent, for the selected version, later versions admitted with that source,
and earlier unretired versions. It reassigns pending rows' `requested_by` to the
caller and queues or expedites version-scoped `credentials_withdrawn` work
(`packages/occ/src/state/controller-work.ts:credentialWithdrawalWorkKey`). It
never deploys a version.

The worker rechecks each requester's `agent:operate` and calls Compute's
`withdrawCredentialSource` for authorized requesters in admission order. Authorized but unconfirmed withdrawals
retry; denied requesters fail after other revocations, unless replay reassigns them.
Revocations audit each requester on confirmation; denials and failures audit once at claim
end. Compute uses the admitted attachment selection above for withdrawal and rechecks.
The shared OpenShell handler calls `DetachSandboxProvider` on the `harnessResource`
Sandbox and reads its receipt status.

`packages/occ/src/credential-policy-reduction.ts:reduceCredentialPolicy` sends protected
reductions only for the selected version. Other versions await replay or candidate
activation, which queues one attempt. Claim completion records `last_reason` and
`last_attempt_at`; `revoked` or `absent` also marks the row revoked and audits
`openclaw.agents.lifecycle.credentials_withdraw`. Other states retry with backoff.
`packages/occ/src/index.ts:readAgentCredentialWithdrawal` prefers exhausted rows,
then pending ones, with the selected version first. Without Compute maintenance,
`apps/controller/src/worker.ts:scheduleCredentialWithdrawalRecovery` caps recovery at
15 series. A false `withdrawalInProgress` requires replay or maintenance to queue more work.

Maintenance requires a Compute or repository credential interval.
`apps/controller/src/worker.ts:completeWithdrawnRevisionMaintenance` stops preparing
a version whose Harness source was withdrawn. The chain continues until all
withdrawals are revoked. Deploy and repair never reattach a withdrawn source;
a withdrawn Harness source fails with `CREDENTIAL_WITHDRAWN`. Either maintenance
pass requeues pending withdrawals without outstanding work, including other versions
(`apps/controller/src/worker.ts:recoverPendingCredentialWithdrawals`);
denied or refused withdrawals await replay. `authorizeRevision` skips withdrawn
sources' `operate` check so removing grants cannot end maintenance.

An absent Sandbox counts as revoked, but a previously accepted create can still land.
`recheckRevokedCredentialSources` rechecks every preparation and withdrawn-Harness pass;
OpenShell detaches again only if `SandboxSpec.providers` still lists the provider.

## Debugging and Verification

- [OCC conformance](../../tests/conformance/credential-source-occ.test.ts) exercises grants,
  recovery and version admission with a gateway double.
- [API integration](../../tests/integration/credential-source-api.test.mjs) covers Fastify,
  IAM, OCC and the OpenShell Driver; storage and Compute are doubles.
- [Wire conformance](../../tests/conformance/openshell-gateway-wire.test.ts) checks provider,
  profile, update, detach and recheck RPCs against the `v0.1.5` fixture.
- [Worker integration](../../tests/integration/postgres-worker-agent-revision.test.mjs)
  exercises withdrawals, retries, replays and late creates with PostgreSQL and a Compute double.
- [Real OpenShell cases](../testing/openshell.md#openshell-sandbox) register, inspect, update
  and withdraw PAT or API-key sources; the tool token disappears and the next model turn fails.
- A source stuck in `deleting` returns `503` on delete until the gateway is
  reachable; `GET` shows its live `status`.
- Worker reason codes `CREDENTIAL_GATEWAY_MISMATCH` and
  `HARNESS_AUTH_SOURCE_UNAVAILABLE` mean a changed selection or an unavailable
  source; `CREDENTIAL_WITHDRAWN` a withdrawn version source, and
  `CREDENTIAL_WITHDRAWAL_PENDING` an unconfirmed revocation. `CREDENTIALS_WITHDRAWN` and `WITHDRAWAL_REVISION_RETIRED` complete the work,
  and `CREDENTIAL_WITHDRAWAL_UNSUPPORTED`, `COMPUTE_DRIVER_MISMATCH`,
  `CREDENTIAL_WITHDRAWAL_MISCONFIGURED`, `CREDENTIAL_WITHDRAWAL_OWNERSHIP_CONFLICT`,
  `CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT` and `AUTHORIZATION_DENIED` fail it at once.

## Related docs

- [Credential sources](../reference/credential-sources.md)
- [CredentialGatewayDriver contract](../reference/drivers/credential-gateway.md)
- [OpenShell Credential Gateway](../reference/drivers/openshell-credential-gateway.md)
- [Secret storage and delivery](secret-storage-and-delivery.md)
- [OpenShell Sandbox provisioning](openshell-sandbox-provisioning.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-19 09:25: Keep the standalone TokenService schemas alongside the current source admission flow. (authoring-run/3443474d-ea8c-4273-8c4f-3b3755f1eee1 - abc218e67e3325ea0db6ae3687413abd34713aff)

- 2026-11-19 03:15: Keep the flow current while moving catalog enforcement to a separate change. (authoring-run/b0e8e24d-3e5e-40a1-ae3b-10e0dfe3e6a8 - ea34779cc)

- 2026-11-18 14:02: Check the selected catalog type during registration. (authoring-run/f10d3e7e-18d9-4ae8-9bdb-8004b6815fb7 - 293833c72)

- 2026-11-18 12:46: Check catalog field names and report malformed config keys. (authoring-run/f10d3e7e-18d9-4ae8-9bdb-8004b6815fb7 - 4875ab0f5)

- 2026-11-18 06:42: Remove source-create protection selection and report admitted provider protection. (authoring-run/deb16d3b-e25e-4b06-b8b5-fa14f7121a08 - 73a9c6467899a076dc9e0a5f8162fcf4f2af0cf6)

- 2026-11-18 05:30: Expose the recorded live model authorization profile in source metadata. (authoring-run/37e75cb4-4947-44ab-8be4-6a3f6726be01 - 514390283e7f2a3638eeee5427846e8215556c84)

- 2026-11-17 19:44: Distinguish the published TokenService schemas from the current registration handler. (01a1eb01-0dea-7f01-8613-761574377d3f - 23b54e285)

- 2026-11-17 19:24: Correct session ownership. (authoring-run/a1a47d55-3248-4349-81a2-ca786027b634 - c5ddcd80cb4cfcd0b969a52ef5c4cafff552a8e8)

- 2026-11-13 15:44: Recheck the Git-only model lifecycle before Kubernetes attachment and release. (authoring-run/f3a542b0-ca6b-426f-8759-3ca2500f79ce - a14ccd99)

- 2026-11-11 19:04: Keep ordinary Gateway model delivery independent of Git Proxy selection. (authoring-run/1e8e6ab1-7c1b-4d49-a362-2dc060e32bbb - aea0cb511)

- 2026-11-11 16:45: Expose structured retry guidance for the existing registration deletion fence. (authoring-run/b642b758-0314-4f01-a300-5e37962b8fb4 - 5eed51d18d8ea86a6c9450c352e967b433fa47da)

- 2026-11-03 16:57: Correct catalog-field refusal status. (authoring-run/4d0e1a9c-b86a-4b59-be3e-d4306d5da9fc - 82a04653d)

- 2026-11-03 15:09: Document shared provider routing and separate destination authorization. (authoring-run/4d0e1a9c-b86a-4b59-be3e-d4306d5da9fc - 47e0e95df)

- 2026-10-30 02:05: Resolve fresh static provider identities consistently with source updates. (authoring-run/ddbd21a8-0432-4c61-b4ad-e48d12268c8c - 262a2188226cbcd2ee22630040617f6c39969352)

- 2026-10-29 21:40: Validate an owned revision snapshot under ordered storage locks. (authoring-run/833462ab-9c82-438a-95c4-53d1dbb2e7e9 - a9884d11bf325a39f3308f787a5ea266ebab5144)

- 2026-10-29 20:41: Validate static source endpoints without Gateway placement. (authoring-run/cf8bb25e-ffb8-4349-9770-a0b07d6bf50f - 2eed3c36a)

- 2026-10-29 19:11: Use the recorded owner’s catalog for fresh source admission. (authoring-run/d88f92d2-4a34-4001-aaa0-70d424201741 - 3a4244461)

- 2026-10-29 15:48: Preserve DELETE ownership when live registration loses readiness without an external write. (authoring-run/0f4f447d-cd98-4f49-9d16-217bf7500d1d - 6ead449d5)

- 2026-10-23 08:05: Refuse unselected protected withdrawals. (fix-2235 - 860eea712)

- 2026-10-16 22:08: Distinguish OpenShell-owned OAuth from protected source admission. (authoring-run/9fd90bae-7158-4df5-8f2e-62b0bd548272 - 4f98051f14)

- 2026-10-15 22:26: Reconcile current main behavior with OpenShell OAuth contracts in the accompanying merge. (authoring-run/41e4bb7a-c8eb-4332-b1f9-07fb8e234f63 - b747cf5b6402ad36ce9f1ae6dbed08928ddcf3dc)

- 2026-10-15 18:17: Pin OpenShell v0.1.4. (authoring-run/openshell-014-rebase-20261015 - 64a3424a9)

- 2026-10-14 14:04: Scope PAT authentication and OpenShell prerequisites. (authoring-run/dba0a6cb-33d9-40fd-b38b-e20cddf4b75f - 96a2b79fa)

- 2026-10-13 20:30: Document provider-managed Codex PAT authentication. (01a136ee-8824-7043-b9e2-49eccacac3bd - ed9018c09)

- 2026-10-14 01:11: Reconcile endpoint validation and provider ownership with external OAuth custody in the accompanying merge. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - c5fb4880ebf2df2aedae12f99adb1992a930ba1b)

- 2026-10-13 20:07: Check provider ownership before profile updates. (authoring-run/01a136d4-3550-7042-834c-cf11f51f41f2 - 146c80ef66b5860cb9bea296d2574156468a103c)

[Credential source lifecycle documentation history](credential-source-lifecycle/history.md) preserves the older dated entries.
