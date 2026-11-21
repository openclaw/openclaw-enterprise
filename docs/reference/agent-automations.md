# Agent automations

The OpenClaw Control Plane (OCC) automation broker retains human ownership and
manages native jobs. Creation and activation are gated; safe disabling edits,
deletion, reads and recovery remain available for retained OCE-owned jobs.
See the [management guide](../guides/agent-automations.md).

## Execution qualification

The RFC requires non-owner Agent service authority. The pinned direct native
administrative route instead produces trusted `operator-schedule` authority.
Tool allowlists do not establish the required actor or action restrictions.
The [RFC's source-backed limitation](../../specs/rfcs/20261121-agent-automations.md#unresolved-execution-authority)
records the gap and pending decision. Valid model credentials cannot resolve it.

POST and explicit activation return `503 AUTOMATIONS_UNQUALIFIED`. PATCH also
refuses an edit that would leave an existing job enabled, using the same native
read and revision precondition as the mutation. An atomic disabling edit is allowed.

The gate does not disable Gateway-wide cron, which also serves native Agent
functions. It is not cancellation of existing work. Pause/delete a retained enabled
job, or use ordinary Agent stop if a turn is already in flight. There is no native
import/reconciliation service or caller-controlled qualification override.

## Ownership and authority

A human controller session needs exact-Agent `operate` to create a job. The same
permission admits reads and mutations of that creator's records. Exact-Agent
`administer` admits management of all OCE-owned jobs for the Agent, but does not
replace `operate` for creation. Service keys are refused. Foreign and absent
ownership records return the same 404 response.

OCE is the sole automation manager. Native edits, imports and reconciliation with
other managers are outside the supported workflow. Native jobs without an OCC
ownership record are not exposed through this API.

Scheduled execution under the Agent's service authority remains a requirement,
not verified behavior of this operator transport. Human creator identity controls
management access and does not supply personal credentials. Revoking `operate`
removes that human's management access; it does not delete retained jobs.

## Requests and responses

All paths start with `/namespaces/{namespaceId}/agents/{agentId}/automations`.

| Method | Suffix                 | Request                                           | Success                   |
| ------ | ---------------------- | ------------------------------------------------- | ------------------------- |
| POST   | Collection             | Required `name`, `enabled`, `schedule`, `prompt`  | 503, unqualified          |
| GET    | Collection             | Optional `offset`, `limit`                        | 200, authorized summaries |
| GET    | `/{automationId}`      | No query                                          | 200, job                  |
| PATCH  | `/{automationId}`      | Expected revision and at least one editable field | 200, job                  |
| DELETE | `/{automationId}`      | `expectedConfigRevision` query                    | 204                       |
| GET    | `/{automationId}/runs` | Optional `offset`, `limit`                        | 200, run history          |

Create and edit accept `at` with an RFC3339 timestamp, `every` with a positive
integer `everyMs`, or `cron` with `expr` and an IANA `tz`. Native validation owns
schedule semantics. Responses preserve normalized `anchorMs` and `staggerMs`
when present. A job also returns `id`, `configRevision`, `name`, `enabled`,
`prompt`, `nextRunAtMs` and `lastRunStatus`.

Request limits are 200 characters for the name, 16,384 for the prompt, 256 for a
cron expression and 128 for its time zone. Page limits are 1–100 (default 50);
offsets are 0–999,999,999 (default 0). Expected revisions are nonempty strings of
at most 128 characters. Mutations require the configured Origin and existing
session CSRF checks. Native routing/authority headers and extra body fields are
rejected; callers cannot choose native Agent IDs, creators or tool grants.

Lists omit prompts and filter ownership before paging and totals. The public
`snapshotRevision` describes only authorized summaries. Restart a paged scan if
it changes. A registered unsupported job returns only ID, name, enabled state,
schedule kind and revision; GET and PATCH reject it. An Agent administrator can
remove it using the observed revision.

PATCH checks its `expectedConfigRevision` against the full job read used for
eligibility, then passes that revision to the native atomic mutation. DELETE
also uses a native revision precondition. Refresh after a 409; do not overwrite
another request's changes blindly.

## Persistence and history

The deferred create path reserves a new UUID and its creator, exact Namespace,
Agent and native Agent before native create. The current HTTP gate prevents entry
to that path. The reservation and admission audit commit together.
OpenClaw chooses the native job ID. OCC creates disabled using its unique
declaration key, binds the returned native ID durably, then enables the job if
requested. A native ID cannot be rebound or shared by two records for the Agent.

A reservation does not prove a native job exists. Inventory or exact lookup can
recover a disabled native job and fill the missing ID binding. This writes only
OCC bookkeeping and audit; it never replays create or activates the job. A create
that fails after native creation can therefore leave a disabled job to inspect.

If transport proves create was not sent, or native rejects create and a subsequent
inventory confirms no job exists, OCC conditionally removes the unbound reservation
and records that outcome in the same transaction. Admission audit remains. Cleanup
cannot remove another creator's reservation or a bound native identity. Lost replies,
failed absence checks and other uncertain outcomes retain the recovery record.

Ownership records survive native one-shot deletion and explicit deletion, so OCC
can authorize history afterward. Native history retention still applies; an
expired history or a deleted job that never ran returns 404. Agent
deletion removes its ownership rows with its lifecycle. There is no native-edit
import or automatic ownership adoption.

History returns run IDs, start/finish timestamps, execution and completion status,
delivery status, and available summary/error fields. Native payloads and history
content are excluded from OCC mutation audit.

## Runtime and failure boundaries

Both Installation and Agent native access must be enabled. OCC requires a running
selected revision, matching Compute ownership, a usable private endpoint and
runtime-image provenance for each main Gateway/Harness container. The current
source eligibility pin is `cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef`; a new pin
needs management-protocol proof before admission is extended. This pin does not
qualify scheduled execution. Missing provenance or
an unsupported source is refused before native cron dispatch.

The private connection must grant native administration, advertise all six cron
methods and identify one unambiguous native Agent. OCC's typed adapter enforces
the six-method surface; the underlying native credential has broader authority
and never reaches the caller. Browser chat scopes are unchanged.

A stopped, replacing or unavailable runtime returns `503 DEPENDENCY_UNAVAILABLE`.
Missing transport and unqualified creation or enabling return `503 AUTOMATIONS_UNQUALIFIED`.
Invalid requests return 400; human/Agent denials return 403; absent or hidden jobs
return 404; conflicts and unsupported job shapes return 409.

A lost mutation reply, malformed acknowledgement, selected-revision change after
dispatch, or failed success-audit append returns `503 UNKNOWN_OUTCOME`. OCC records
an indeterminate outcome when audit is available and does not replay the request.
Use the response's `Location` path to inspect the automation or its `/runs`
history before deciding whether to issue another mutation. A missing live job
does not prove it never ran. A disconnect cannot guarantee cancellation of a
native effect, and a lost HTTP response can also lose its recovery reference.

## Verification status

The refusal and ownership checks exercise the real HTTP application, session and
Native IAM boundaries. PostgreSQL coverage checks durable ownership, immutable
application-role access, atomic reservation/audit rollback and ownership cleanup
through the Agent deletion worker. These checks do not prove native model execution.

The native protocol case in `tests/integration/workspace-files-native.test.ts`
uses a real Gateway with a transparent fault proxy and in-memory OCC persistence.
It checks CRUD, owner filtering, concurrent native CAS, lost replies, post-commit
audit failure and revision fencing. It also replaces the real Gateway container
on retained native storage and verifies the paused job, native ID and OCC ownership
record remain unchanged, without recreating or enabling the job. No model runs.
OCC storage and Compute remain fixtures; this is not PostgreSQL-backed OCC restart
or production Kubernetes cutover proof.

The `agent-automations` [QA scenario](../testing/ci/qa-advisory.md) exercises the
regular deployed Agent workflow to verify execution refusal. It does not prove scheduled turns or tool policy. Required positive
model/tool-policy, one-shot history and production-runtime proof
remain recorded in the [implementation plan](../../specs/plans/20261121-agent-automations.md).
See the [source-backed flow](../flows/agent-automations.md) for implementation order.
