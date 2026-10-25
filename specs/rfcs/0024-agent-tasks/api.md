---
rfc: index.md
---

# Agent Tasks: API, CLI and MCP surface

This companion to [RFC-0024](index.md) lists the proposed operations. Route names, fields and limits are proposals
for review; nothing here is implemented. The OpenAPI contract will own the final shapes.

## REST operations

All routes are under `/namespaces/{namespaceId}`. They accept a human session or a service key, as other Namespace
routes do. Session callers send the CSRF token on writes.

| Operation | Route | Permission | Result |
|---|---|---|---|
| Create | `POST /tasks` | `task:create` on the Namespace and `agent:invoke` on `assigneeAgentId` | `201` with the Task in `queued`. A repeated `requestId` from the same creator returns `200` with the first Task. |
| List | `GET /tasks?state=&assignee=&parent=&limit=&cursor=` | Namespace `read`; returns only Tasks with exact `task:read` | Newest change first, 1 to 100 per page, default 50. |
| Get | `GET /tasks/{taskId}` | `task:read` | The Task, its latest report and open question, if any. |
| Read feed | `GET /tasks/{taskId}/events?after=&limit=` | `task:read` | Events after the sequence number, 1 to 200, default 50, oldest first. |
| Post a message | `POST /tasks/{taskId}/messages` | `task:update` | `202`. A `message` event; the worker delivers it as a follow-up turn. |
| Decide | `POST /tasks/{taskId}/decisions` | `task:update` | Answers an open `decision_requested` event by its sequence number. `409` if no decision is open. |
| Accept or reject | `POST /tasks/{taskId}/review` | `task:update` | Moves `review` to `done` or `failed`. `409` in other states. |
| Redeliver | `POST /tasks/{taskId}/redeliver` | `task:update` and `agent:invoke` | Only from `needs_person` after `delivery_uncertain` or `interrupted`. Starts a new run in a new session. |
| Cancel | `POST /tasks/{taskId}/cancel` | `task:update` | Aborts a running turn, then `cancelled`. Idempotent. |
| Agent feed | `GET /agents/{agentId}/task-events?after=&limit=` | `agent:read` and exact `task:read` per event's Task | Events across this Agent's Tasks, for the per-Agent view. |

Errors follow the existing envelope. Missing or hidden Tasks return `404`. An assignee in another Namespace, an Agent
without a selected revision, or a Compute Driver without a private gateway route rejects creation with a typed error
before any work is queued.

### Create request

```json
{
  "title": "Fix the flaky upgrade preflight test",
  "brief": "## Why\n...\n## Done when\n...",
  "assigneeAgentId": "agt_01J...",
  "parentTaskId": null,
  "deadlineMinutes": 120,
  "stallMinutes": 30,
  "requestId": "lane-fix-upgrade-1025"
}
```

`brief` is the full instruction. OCC prepends a fixed header that names the Task ID and the result block format, so
callers do not repeat it. `requestId` is at most 128 characters and unique per creator and Namespace.

### Result block

The first slice asks the Agent to end its final reply with:

````text
```task-result
outcome: done | needs_person | failed
summary: one paragraph
artifacts:
  - https://github.com/example/repo/pull/123
```
````

OCC accepts at most 20 artifact URLs with the `https` scheme. It records each as an `artifact` event, typed
`pull_request` or `commit` when the URL matches a known repository host pattern, otherwise `link`. OCC does not fetch
the URLs. A malformed block is kept as report text, and the Task moves to `review`.

## CLI

The `occ` CLI adds a `task` command group that uses the same global flags and service key as other commands:

```sh
occ task create --agent agt_01J... --title "..." --brief-file brief.md --request-id lane-x
occ task list --state needs_person
occ task feed tsk_01J... --follow        # polls every 5 s; prints new events
occ task message tsk_01J... --text "Use the existing helper in tests/fixtures."
occ task decide tsk_01J... --event 42 --text "Approved: open the draft PR."
occ task accept tsk_01J...
occ task cancel tsk_01J...
```

## MCP server

`occ mcp` runs a stdio Model Context Protocol server. It is a mode of the CLI, not a new service: each tool calls the
REST API with the CLI's configured URL and service key, and has no other authority. A coding agent adds it to its
local MCP configuration.

| Tool | Calls | Notes |
|---|---|---|
| `list_agents` | `GET /agents` | Returns Agents the key can read, with whether it holds `invoke`. |
| `create_task` | `POST /tasks` | Requires `requestId`, so a retried tool call does not create a second Task. |
| `list_tasks` | `GET /tasks` | Filters by state, assignee and parent. |
| `get_task` | `GET /tasks/{id}` | Includes the latest report and open question. |
| `read_feed` | `GET /tasks/{id}/events` or the Agent feed | Takes and returns a cursor. |
| `post_message` | `POST /tasks/{id}/messages` | |
| `decide` | `POST /tasks/{id}/decisions` | Refused unless the key's principal holds `task:update`. |
| `cancel_task` | `POST /tasks/{id}/cancel` | |

The server exposes no tool to accept or reject a result. A person accepts results in the console or with the CLI.
This keeps "an agent approved its own worker's output" out of the first slice; see the RFC's open questions.

A repository can also ship a short skill file that documents the `occ task` commands for coding agents that do not
use MCP. It needs no additional server.

## Service keys for a coordinating agent

A coordinating agent outside the cluster uses a Namespace-scoped service key whose ServicePrincipal holds
`task:create`, `task:read`, `task:update` and `agent:invoke` on the worker Agents. The key never reaches the worker
Agents. Its actions are audited as that ServicePrincipal, so a person can tell the coordinator's dispatches from
their own.
