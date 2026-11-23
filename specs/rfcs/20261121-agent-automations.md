---
status: Proposed
implementation_status: Partially implemented
author: kevinlin-openai
---

# Proposal: Wrap native cron with Agent automation APIs

- **ID:** RFC-20261121-agent-automations
- **Created:** 2026-11-21
- **Last updated:** 2026-11-23
- **RFC PR:** [#6850](https://github.com/openclaw/openclaw-enterprise/pull/6850)
- **Implementation plan:** [Agent automation APIs](../plans/20261121-agent-automations.md)

## Decision

OpenClaw Control Plane (OCC) exposes six Agent HTTP operations that wrap native
OpenClaw cron. OCC authenticates and authorizes the request, selects the Agent's
running revision, forwards one allowed cron request, and records mutation audit
evidence. OpenClaw owns job IDs, definitions, schedule normalization, execution,
and run history. OCC does not add a scheduler or persist a second job record.

Each operation requires a human session with exact-Agent `operate`. As with
[workspace file access](../../docs/flows/workspace-files.md#5-occ-admits-one-exact-agent-file-operation),
OCC authorizes the exact resource and operation before it privately uses the
shared trusted Gateway machine identity. That identity has `operator.admin`;
the human does not receive it. OCC limits this API to the six cron methods.

An operator can manage all native jobs for the Agent, regardless of creator, and
can create persistent trusted native runs that use the Agent's native tools.
The API does not enforce creator-only access or guarantee that a scheduled run
has authority equivalent to the caller.

## Interface

All paths start with
`/namespaces/{namespaceId}/agents/{agentId}/automations`.

| Method and path | Native method | Request | Result |
| --- | --- | --- | --- |
| POST collection | `cron.add` | `name`, `enabled`, `schedule`, `prompt` | 201 and native job |
| GET collection | `cron.list` | Optional `offset`, `limit` | 200 and native list |
| GET `/{automationId}` | `cron.get` | Native job ID | 200 and native job |
| PATCH `/{automationId}` | `cron.update` | `expectedConfigRevision` and editable fields | 200 and native job |
| DELETE `/{automationId}` | `cron.remove` | `expectedConfigRevision` query | 204 |
| GET `/{automationId}/runs` | `cron.runs` | Optional `offset`, `limit` | 200 and native history |

The public automation ID is the opaque native job ID. The schedule can use
native `at`, `every`, or `cron` form. Native cron validates and normalizes
the schedule. PATCH can change the name, enabled state, schedule, or prompt.
Native cron owns revision conflicts and history retention.

## Security and failure behavior

OCC checks exact-Agent `operate` before it opens the private Gateway transport.
Service keys cannot use these human-session routes. Mutations retain existing
Origin and CSRF checks. OCC limits native requests to the six methods above and
does not expose a general RPC endpoint. Audit records identify the caller,
Agent, and operation; they exclude prompts and credentials.

A stopped or unavailable Agent cannot accept a cron request. Map native invalid
input, missing jobs, and revision conflicts to the appropriate public errors.
If a sent mutation has an uncertain outcome, return `UNKNOWN_OUTCOME` and do
not retry it automatically.

## Scope and verification

This change does not qualify scheduled tools, MCP servers, models, or runtime
images. It does not add tool caps, creator records, database tables, Compute
Driver operations, proxy routes, Kubernetes policy, or result delivery. A job
uses native cron execution behavior under the Agent's existing configuration.
The API makes no additional promise about scheduled tool permissions.

Extend one existing Agent/native-admin integration workflow to exercise the six
routes, denied callers, Origin/CSRF protection, a stale revision conflict, and audit evidence. Run the
required contract generation and standard PR checks. Model execution and MCP
qualification are outside this API change.

## Delivery status

Implementation and focused integration verification are in progress. The
[plan](../plans/20261121-agent-automations.md) owns the delivery record.
