---
rfc: index.md
---

# Agent Tasks: failure handling and limits

This companion to [RFC-0024](index.md) lists the proposed failure behavior and first-slice bounds. Values are
proposals for review; nothing here is implemented.

## Failure handling

| Failure | Behavior |
|---|---|
| Duplicate create | `requestId` returns the first Task; without one, two Tasks exist and both are visible. |
| Worker lost during send | The next claim looks up the submission ID. Found: continue. Not found: `delivery_uncertain` and `needs_person`. A person chooses redeliver or cancel. |
| No transcript activity for 30 minutes (configurable per Task, 5 to 240) | `stalled` event and `needs_person`. OCC does not abort the run. |
| Deadline passes (default 2 hours, at most 24) | OCC aborts the run and sets `failed`. |
| Agent stopped, redeployed or deleted during a run | `interrupted` event and `needs_person`; deletion sets `failed`. Redelivery starts a new run in a new session and links the old one. |
| Gateway unreachable before delivery | Normal work retry with backoff, then `needs_person` after the deadline's first quarter. |
| Creator loses `invoke` | The next send fails closed: `needs_person` with an authorization reason. |

The lease that prevents duplicate work is the Task's single active run: an Agent runs at most one Task at a time in
the first slice, and OCC queues the rest in creation order. The bound is deliberate. Sessions of one Agent revision
share its workspace and, with OpenShell, one Sandbox, so two Tasks on one Agent could edit the same checkout. The
Harnesses accept more concurrent sessions (native OpenClaw defaults to 8), so a later phase can raise the bound per
Agent once workspaces are separated per session.

## Limits

| Bound | First-slice value | Enforced by |
|---|---|---|
| Running Tasks per Agent | 1 | OCC state |
| Open Tasks per Namespace | 200 (`429` above) | API |
| Brief, message | 64 KiB, 16 KiB | API |
| Events per Task, projected text per event | 2,000, 4 KiB | Worker |
| Feed page | 1 to 200 events, default 50 | API |
| Transcript polling | Every 5 seconds while running, per Task | Worker |

Model cost follows the Agent's existing model configuration. OCC reports turn counts per Task, not spend.
