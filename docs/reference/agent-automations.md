# Agent automation API availability

The Agent automation HTTP API currently performs admission and refuses native
operations. It cannot create, list, inspect, edit, delete or read the execution
history of jobs. No runtime is qualified for successful dispatch.

The [RFC](../../specs/rfcs/20261121-agent-automations.md) defines the proposed
scheduling contract. The [implementation plan](../../specs/plans/20261121-agent-automations.md)
tracks incomplete work and native qualification requirements.

## Admission

All six paths begin with `/namespaces/{namespaceId}/agents/{agentId}/automations`:

| Method | Suffix                 | Request                                                  |
| ------ | ---------------------- | -------------------------------------------------------- |
| POST   | Collection             | Required `name`, `enabled`, `schedule` and `prompt`      |
| GET    | Collection             | Optional `offset` and `limit`                            |
| GET    | `/{automationId}`      | No query fields                                          |
| PATCH  | `/{automationId}`      | `expectedConfigRevision` and at least one editable field |
| DELETE | `/{automationId}`      | Required `expectedConfigRevision` query field            |
| GET    | `/{automationId}/runs` | Optional `offset` and `limit`                            |

A human controller session needs exact-Agent `operate` to create an automation.
The other five operations accept exact-Agent `operate` or `administer`.
Service keys are refused. Mutations require the configured Origin and session
CSRF checks. Requests cannot supply native routing or authority headers, creator
identity, native Agent identity, tool grants or extra body fields.

Request limits are 200 characters for the name, 16,384 for the prompt, 256 for a
cron expression and 128 for its time zone. Page limits are 1–100; offsets are
0–999,999,999. PATCH and DELETE revisions are nonempty strings of at most 128
characters. Request schemas admit `at`, `every` and `cron` schedule shapes;
no native scheduling semantics are exercised while dispatch is blocked.

## Refusals and effects

After authorization, OCC checks native access enablement, running Agent state,
selected revision, Compute ownership, replacement state and native configuration.
An unavailable dependency returns `503 DEPENDENCY_UNAVAILABLE`. If those checks
pass, OCC returns `503 AUTOMATIONS_UNQUALIFIED` before credential resolution or
Gateway dispatch. There is no configuration switch to bypass qualification.

Invalid input returns 400. Denied human or resource authority and failed Origin
checks return 403. An authorized lookup of an absent exact resource returns 404.
Existing OCC request audit records apply; requests never persist an automation
or send its prompt to a Gateway. No successful mutation or `UNKNOWN_OUTCOME`
path is implemented yet.

## Driver boundary

The delegated Compute contract reserves `mode: "automation"` separately from
browser `admin` and `chat`. A qualified delegation must admit only
`cron.add/list/get/update/remove/runs` and authenticate creator and effective-Agent
scope. Kubernetes currently returns no transport for this mode, before reading
credentials. The HTTP handler also refuses all Drivers until native qualification
and dispatch are implemented.

See [native browser access](agent-native-admin.md) for the existing browser
workflow and [the automation flow](../flows/agent-automations.md) for source order.
