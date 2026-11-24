# Agent automation API

Use the Agent automation API to create and manage native OpenClaw cron jobs.
The Agent must be running. Each request requires a human session with
`operate` permission on that exact Agent. Service keys are not accepted.

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

`automationId` is the opaque job ID returned by native cron. Use one of
these schedules. OpenClaw validates and normalizes it.

| `schedule.kind` | Fields in `schedule`                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| `at`            | `at` date-time string, up to 64 characters                                            |
| `every`         | `everyMs` integer interval in milliseconds, 1 to 9007199254740991                     |
| `cron`          | `expr` cron expression (1–256 characters), optional `tz` time zone (1–128 characters) |

Read the job's current `configRevision` and send it as `expectedConfigRevision`.
For PATCH, include it in the body with at least one of `name`, `enabled`,
`schedule`, or `prompt`. For DELETE, pass it in the query. See the
[HTTP API reference](api.md) for examples.

An operator can manage all native jobs for the Agent, regardless of who created
them. An operator can also create persistent trusted native runs that use the
Agent's native tools. OCC privately uses a shared Gateway machine identity with
`operator.admin`; it does not give that identity to the human. The API does not
enforce creator-only access or guarantee caller-equivalent execution authority.

OCC does not store job definitions or creator ownership. Native cron owns
execution, delivery, deletion, and history retention. Jobs created through
this API use `delivery.mode` of `none`. PATCH cannot change delivery.
Check the job's run history. These routes do not add tool
permission checks or qualify scheduled MCP use.

Mutations use the existing Origin and CSRF protection. A stale revision returns
a conflict. A stopped or unavailable Agent cannot serve these requests.

If you lose the response or OCC returns `UNKNOWN_OUTCOME`, the change may
have taken effect. After POST, if you have no job ID, list the Agent's jobs,
check all pages, and inspect possible matches. After PATCH or DELETE, read
the job by ID to check its current settings or whether it still exists.
These reads cannot prove which request made a change. Do not repeat the
mutation while its outcome is unclear.

See the [runtime flow](../flows/agent-automations.md) for implementation details.
