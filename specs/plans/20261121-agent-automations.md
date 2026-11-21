---
status: In progress
rfc: ../rfcs/20261121-agent-automations.md
---

# Implementation plan: Agent automation admission and scheduling

- **ID:** RFC-20261121-agent-automations
- **Delivery status:** In progress
- **Owner:** Kevin Lin
- **Authority:** [Submitted RFC](../rfcs/20261121-agent-automations.md), PR #6850
- **Source baseline:** `d4a3ab0c9603ce9678995160776dd78d94a7a688`

## Outcome and scope

Implement the RFC's six HTTP operations through the selected Agent Gateway.
The current work adds admission and refusal paths. Scheduling, creator-owned
job access, approved-tool execution, retained history, and indeterminate mutation
handling remain incomplete. No runtime is qualified for this API.

OpenClaw owns scheduling and storage. OCE must not patch or vendor OpenClaw, grant
machine administration to callers, or reconstruct native execution authority.
Upstream changes and submissions require separate human approval.

## Contract and source touchpoints

- `packages/contracts/src/api/agent-automations.ts` owns closed request schemas.
- `packages/contracts/src/api/routes.ts` registers the six real HTTP routes.
- `apps/controller/src/http/agent-automations.ts` checks human sessions, Origin,
  exact-Agent authority, selected revision, native configuration and Compute owner.
- `packages/contracts/src/drivers/compute/index.ts` reserves the distinct
  `automation` delegation mode. Kubernetes refuses it before credential lookup.
- Native dispatch will use the supported Gateway client after the upstream
  contract is qualified. It must not use the browser admin connection.

## Implementation

1. **Admission, in progress:** integrate the six routes with session admission,
   Native IAM, existing request audit and CSRF. Reject unsupported runtimes without
   dispatch. The implemented response contract exposes errors only.
2. **Native qualification, blocked:** obtain an approved upstream implementation,
   then qualify an immutable packaged runtime. The current pin is
   `cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef`.
3. **Dispatch, blocked on qualification:** preserve native normalized schedules;
   check creator and effective-Agent authority before eligibility, including
   DELETE; validate the full PATCH read against the expected revision and forward
   it to atomic mutation. Filter reads before pagination and totals.
4. **Effects and recovery, blocked on qualification:** bind each request to its
   selected revision; audit successful, denied and indeterminate operations with
   metadata only. A lost mutation reply, post-dispatch revision change, or failed
   audit append after acknowledgement returns `503 UNKNOWN_OUTCOME`, with no replay.
5. **Proof and delivery:** extend the real Agent QA workflow, run all five RFC
   acceptance criteria, fix independent review findings and complete the
   [PR readiness checklist](../../.agents/skills/local-dev/references/pr-readiness.md).
   Publish a regular PR only when the requested implementation is ready.

## Upstream qualification blockers

The pinned [method authorization](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/src/gateway/server-methods/method-authorization.ts)
and [scoped history admission](https://github.com/openclaw/openclaw/blob/cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef/src/gateway/server-methods/cron-runs.ts)
do not establish the required contract. Qualification must cover:

- A strict ceiling of `cron.add`, `cron.list`, `cron.get`, `cron.update`,
  `cron.remove` and `cron.runs`; no run, scratch, transfer or binding authority.
- Authenticated server-owned creator-only or Agent-wide management scope.
  Caller parameters cannot establish either scope or the effective Agent.
- Creation that commits creator identity and admitted execution authority.
  Missing `toolsAllow` and trusted scheduling defaults cannot establish a bounded
  approved-tool grant. Public `cron.get` omits required execution evidence.
- Current restrictions across native and dedicated Harness tools, Gateway dynamic
  tools and configured apps/MCP, including policy reduction before execution.
- Per-run creator and effective-Agent evidence after deletion or job-ID reuse,
  authorization before disclosure, and filtering before totals.

## Verification

| Required outcome | Check and prerequisites | Result or remaining proof |
| --- | --- | --- |
| Refuse all six operations safely | Existing native-admin HTTP integration, real OCC app/session/IAM and in-memory persistence; upstream is a no-dispatch tripwire | Passed; surrounding native-access and serialization suites: 31 tests, zero failures or skips. Expanded admission case also passed. |
| Native schedule normalization, lifecycle and history | Real packaged Gateway, selected Harness and approved model/tool credentials | Blocked on upstream qualification |
| Native creator, Agent and execution authority | Real scoped creation, denied tool calls, policy reduction, dedicated Harness and MCP/app checks | Blocked on upstream qualification |
| Replacement, lost replies and audit failures | Owned Kubernetes fixture and real Gateway; no fake mutation acknowledgement | Blocked on dispatch implementation and runtime qualification |
| Types, formatting, OpenAPI and docs | Node 24.22.1, pnpm 11.15.1 and Bun 1.4.4 | Passed: typecheck, lint, formatting, OpenAPI generation/check, workspace boundary, CI manifest audit and docs checks |
| Independent review | Shared autoreview helper, local diff from the source baseline, GPT-6 Astra, P0–P2, fallback disabled | Blocked at isolation preflight: selected launcher had no isolated cached binary and its bootstrap returned HTTP 403. Normal login-shell bootstrap also failed because its cache metadata was read-only. No reviewer started; no report or clean verdict. |

## Open decisions

Product and security owners still decide whether revoking the creator's OCE
`operate` grant disables existing schedules. This does not relax current native
execution restrictions. The upstream delegation and qualification evidence must
be agreed before OCE can implement successful dispatch.

## Delivery record

The current [reference](../../docs/reference/agent-automations.md) and
[flow](../../docs/flows/agent-automations.md) describe admission and refusal only.
No database entity, environment variable, runtime source pin or architecture
primitive changes. Required real-runtime proof remains outstanding. The existing
native-access guide and reference, Compute reference, and RFC remain coherent
single topics between 1,500 and 2,500 visible words; short links preserve their
scope. The documentation check passes without a new length exception.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-20 20:28: Record passing local admission checks and the blocked independent review; native acceptance remains unrun.

- 2026-11-20 20:23: Record admission work and upstream qualification blockers (source `d4a3ab0c9603ce9678995160776dd78d94a7a688`; authoring run `01a1fc52-9d88-7223-b8a1-3c98595d3fbe`).
