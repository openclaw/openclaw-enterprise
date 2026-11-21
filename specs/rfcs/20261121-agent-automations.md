---
status: Proposed
implementation_status: Partially implemented
author: kevinlin-openai
---

# Proposal: Schedule model-only Agent automations through OCC

- **ID:** RFC-20261121-agent-automations
- **Created:** 2026-11-21
- **Last updated:** 2026-11-21
- **RFC PR:** [#6850](https://github.com/openclaw/openclaw-enterprise/pull/6850)
- **Implementation plan:** [Broker implementation](../plans/20261121-agent-automations.md)
- **Related:** [Native administration](../../docs/reference/agent-native-admin.md), [Gateway managed mode](../../docs/reference/agents/gateway-managed-mode.md), [runtime pin](../../deploy/runtime/openclaw-source.json)

## Decision and scope

OpenClaw Control Plane (OCC) brokers six HTTP operations for **model-only** Agent
automations. OCC owns human authorization, creator records and attributable audit.
OpenClaw owns job definitions, scheduling, model execution and run history.

Every OCC-created scheduled Agent turn has explicit `payload.toolsAllow: []`.
OCC reasserts that empty list on relevant updates. There is no caller-selected
tool field, wildcard, alias, default or automatic tool grant. The scheduled model
must receive no callable tools: no code, shell, file, delegation/subagent,
messaging, dynamic, app or MCP tools. GitHub reports and connector actions are
not part of this feature.

This requirement concerns model-initiated tool calls. Scheduler activity, model
requests, runtime/bootstrap processing, history persistence and configured failure
alerts are outside the no-tools claim. Ordinary Agent chat, native administration,
and their existing tools and approval policies remain unchanged.

## Trust boundary

The guarantee applies to OCC-managed writes while trusted writers leave those
jobs unchanged. Ordinary chat and native administrators are trusted and can
alter native jobs outside OCC. This is **not** a tamper-resistant sole-writer
guarantee. There is no native-edit prevention, import, ownership adoption or
background reconciliation service. Unregistered native jobs remain outside OCC
inventory and management.

OCC authorizes its callers; it does not claim that the administrative native
transport is a non-owner Agent identity. The private Gateway credential never
reaches an HTTP caller. A scheduled model request uses the selected Agent's
runtime authentication, not the human creator's controller-session credentials.

<a id="unresolved-execution-authority"></a>

## Why the tool-bearing design was narrowed

At the pinned `cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef`, direct administrative
cron creation produces trusted operator authority. Native
[execution context](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/src/cron/execution-context.ts#L322)
and [sender projection](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/src/cron/execution-context-registry.ts#L176)
do not establish a non-owner caller. Approved
[`sessions` actions](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/src/agents/tools/sessions-tool.ts#L193)
can therefore have controls that explicit non-owner callers lack. Target
visibility still applies; cross-session effects have not been demonstrated.
OCE's [managed policy](../../apps/controller/src/drivers/compute/gateway-tool-policy.ts)
forbids Gateway administration tools, so Gateway restart was not demonstrated as
reachable in deployed OCE.

A finite nonempty allowlist does not repair actor/action authority and
[disables Codex's native shell/file surface](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/extensions/codex/src/app-server/dynamic-tool-build.ts#L523).
The selected alternative is an explicit empty list, not a partial deny list or
a global restriction on ordinary Agent chat. No upstream changes are authorized.
Source support for an empty list is not production runtime qualification.

## Goals and non-goals

Support one-shot, interval and cron schedules; native normalization; CRUD,
pause/resume and retained run history; exact-Agent authorization; and explicit
uncertainty without duplicate dispatch.

Immediate execution, result-delivery recipients, commands, scripts, event
triggers, scheduled tools/connectors, service-principal HTTP access, Console
controls and CLI commands are out of scope. Native edits outside OCC remain
trusted activity outside this feature's guarantee.

## Authorization and interface

All paths start with `/namespaces/{namespaceId}/agents/{agentId}/automations`.
Public automation IDs are UUIDs; they are distinct from native job IDs.

| Method and path | Request | Result |
| --- | --- | --- |
| POST collection | `name`, `enabled`, `schedule`, `prompt` | 201 and normalized job, after qualification |
| GET collection | Optional `offset`, `limit` | 200 and authorized summaries |
| GET `/{id}` | No query | 200 and supported job |
| PATCH `/{id}` | Expected revision and editable fields | 200 and updated job |
| DELETE `/{id}` | `expectedConfigRevision` query | 204 |
| GET `/{id}/runs` | Optional `offset`, `limit` | 200 and authorized native history |

Creation requires a human session and exact-Agent `operate`; `administer` alone
does not substitute. Management and history require creator `operate` or
exact-Agent `administer`. Reuse these IAM actions and the Agent resource kind.
Service keys are refused. Mutations retain existing CSRF and Origin checks.

Authorize before native access or resource disclosure. Foreign and absent
ownership records return indistinguishable 404 responses. Filter by the final
authority decision before public pagination, totals and snapshot hashes; losing
administration must not expose a previously loaded all-creator view. Malformed
UUIDs are 400 input errors, not database errors.

Bodies are closed. Clients cannot select native Agent IDs, creators, tool grants,
RPC methods, native scopes, credentials or delivery targets. PATCH can edit the
name, prompt, schedule and enabled state. Stale native revisions return 409.

## Native contract and ownership

Resolve the selected running Agent revision through its existing Compute Driver
and private endpoint. Verify runtime provenance, native access, administrative
transport, required methods and an unambiguous server-selected native Agent.
Typed native calls are limited to `cron.add`, `cron.list`, `cron.get`,
`cron.update`, `cron.remove` and `cron.runs`; this ceiling belongs to OCC, not to
the underlying native credential.

Creation maps to `sessionTarget: "isolated"`, `wakeMode: "now"`, an `agentTurn`
payload with the requested prompt and **explicit empty** `toolsAllow`, and
`delivery.mode: "none"`. Never omit the cap or substitute a wildcard/default.
Relevant native updates must preserve/reassert `[]`; an unqualified or unsupported
shape must not be activated as model-only work.

Before native create, reserve a public OCC UUID with its exact Namespace, Agent,
human creator, selected native Agent and creation time. Commit reservation and
admission audit atomically. Supply `occ-automation:<OCC UUID>` as the native
declaration key and create disabled. OpenClaw allocates the native ID. Bind it
durably once before a separate update enables the job if requested.

Creator/target fields are immutable; a native ID cannot be rebound or shared by
two records for one Agent. Store no prompt, credential, duplicate definition or
second scheduler. Agent deletion removes its ownership rows. Native job deletion
retains them so the same creator/admin boundary authorizes history afterward.
Native history expiry still applies, and a deleted job that never ran returns 404.

A lost create reply can leave a disabled job. Read recovery matches the reserved
declaration key and fills a missing binding once, with audit; it neither replays
create nor automatically enables the job. If transport proves no send, or native
rejects create and inventory confirms absence, conditionally discard only the
original creator's unbound reservation with audit in the same transaction.
Concurrent binding and failed audit must prevent deletion. Admission evidence
survives cleanup.

## Concurrency, failures and audit

PATCH uses the same full native read for eligibility and revision comparison,
then sends that revision to native atomic update. DELETE also uses a revision
precondition. A concurrent edit cannot silently overwrite the winner. Inventory
reads require a consistent native snapshot and expose only authorized summaries.

Recheck session, authority and selected revision around dispatch and before
returning a result. A sent mutation with a lost/malformed reply, changed revision
or failed post-commit audit returns `503 UNKNOWN_OUTCOME`. Keep the ownership
record and return its `Location` when known. Do not automatically replay. A
missing live job does not prove it never ran; consult retained history.

Use ordinary 400/403/404/409 errors for invalid input, denied authority, hidden or
missing records, and conflicts. Unsupported or unqualified execution remains a
503 refusal. Stopped or unavailable runtimes do not admit native access.

Audit admission, successful mutations, binding/recovery, definite-create cleanup,
denials and uncertain outcomes with Principal, Namespace, Agent, selected
revision, operation and known public/native IDs. Exclude prompts, transcripts,
credentials and native payloads. Preserve metadata established before a denial.

## Qualification and acceptance

Qualification uses the actual packaged embedded OpenClaw and dedicated Codex
Harnesses. Fixed `[]` in source or a native CRUD fixture is insufficient. No
mocked model/tool outcome, invented endpoint or test-only qualification bypass
can satisfy these criteria.

- **AC1 — Model-only execution:** create all schedule forms through OCC and retain
  native normalization. Each packaged Harness completes a real model-only
  one-shot, deletes it natively, and exposes its retained history through OCC.
- **AC2 — Lifecycle and persistence:** edit, pause, resume and delete with native
  CAS. Preserve public/native identity, creator ownership, paused state, the empty
  cap and available history across supported revision/Gateway replacement.
- **AC3 — No tools and authorization:** reject client-selected tool fields and
  prove the scheduled model has no shell/file, code, dynamic, subagent/delegation,
  messaging, app or MCP tools. Use genuine runtime evidence and independent
  absence-of-effect checks, not the model's claim alone. Agent policy changes
  must not widen an existing managed job's empty cap. Preserve creator/admin
  separation, administer-only create refusal, CSRF/Origin, service-key refusal,
  demotion safety and UUID validation. Ordinary chat/native administration remain
  outside the restriction.
- **AC4 — Recovery:** prove lost replies, native CAS races, post-commit audit and
  revision failures without duplicate dispatch. Distinguish native/container proof
  from PostgreSQL-backed production placement and model proof.
- **AC5 — Durable audit and cleanup:** prove PostgreSQL ownership constraints,
  reservation/binding audit atomicity, safe failed-create cleanup with concurrent
  binding, post-deletion authorization, and Agent deletion with sibling retention.

## Delivery status

The previous tool-bearing route remains gated. The model-only implementation and
its runtime qualification must replace it before activation is completed. The
[plan](../plans/20261121-agent-automations.md) records exact tested commits, results,
missing credentials and remaining proof. No implementation PR or release-readiness
claim is authorized until the requested outcome is ready.
