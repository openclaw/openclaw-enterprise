# Agent automation API

Use the Agent automation API to create and manage native OpenClaw cron jobs.
The Agent must be running. Each request requires a human session with
`administer` permission on that exact Agent. Service keys are not accepted.

All paths start with
`/namespaces/{namespaceId}/agents/{agentId}/automations`.

| Method and path            | Action                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| POST collection            | Create a native cron job from `name`, `enabled`, `schedule`, and `prompt`. |
| GET collection             | List native jobs; accepts optional `offset` and `limit`.                   |
| GET `/{automationId}`      | Read a native job.                                                         |
| PATCH `/{automationId}`    | Update editable fields with `expectedConfigRevision`.                      |
| DELETE `/{automationId}`   | Delete a job with the `expectedConfigRevision` query.                      |
| GET `/{automationId}/runs` | Read native run history; accepts optional `offset` and `limit`.            |

`automationId` is the opaque job ID returned by native cron. Schedules use
native `at`, `every`, or `cron` form; OpenClaw validates and normalizes
them. The generated [HTTP API reference](api.md) owns the complete schemas.

Administrators of the Agent can manage its native jobs regardless of who
created them. OCC does not store job definitions or creator ownership. Native
cron owns execution, result delivery behavior, deletion, and history retention.
These routes do not add tool permission checks or qualify scheduled MCP use.

Mutations use the existing Origin and CSRF protection. A stale revision returns
a conflict. If OCC returns `UNKNOWN_OUTCOME`, do not repeat the mutation
without first checking the job through a read operation. A stopped or unavailable
Agent cannot serve these requests.

See the [runtime flow](../flows/agent-automations.md) for implementation details.
