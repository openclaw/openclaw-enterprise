# Planned replacement

## Common stop boundary

Exclusive admission records the selected predecessor and candidate on the Agent
as `pre-stop`. Native access remains subject to current permissions. Admitting a
candidate alone does not disconnect the serving revision.

Before closing credentials or invoking stop, the worker commits `stopping` under
the live Work claim and Namespace/Agent locks. Native administration reads this
same fact. The boundary cannot move backwards for the same predecessor, including
when a candidate fails or a later candidate is admitted. Legacy replacements with
no record keep the previous refusal behavior.

Ordinary superseded maintenance cannot recreate a predecessor. Continuing
maintenance during a planned wait requires Driver-owned immutable runtime inputs;
the boundary alone does not enable completion waiting.

Replacement closes earlier credential sessions and stops every earlier revision,
including failed candidates, before preparing its successor. A failed stop blocks
the successor. Repeated stops must confirm release while preserving workspace data.
This policy can cause downtime; recovery deploys a newer revision.

## Bounded predecessor completion

The worker owns one predecessor operation on the Agent. Eligible replacement
passes preserve its completion start and execution identity across retries,
Controller restarts and candidate changes. They renew a short Gateway lease and
yield the existing Work claim while admitted tasks or delivery remain active.
This interval, capped at 30 minutes, does not consume the ordinary convergence
budget. Other Agents continue independently.

A ready observation is not permission to stop. The Driver calls the worker's
claim-checked `commitStopping` callback, then commits a handoff to that exact
Gateway process. This is the same durable boundary used by ordinary replacement;
no separate completion worker or queue is introduced. An unconfirmed handoff
continues normal bounded stopping without claiming task completion. Expiry,
unsupported runtimes and a changed Gateway process also continue normal stopping.
Stop, deletion and authorization withdrawal do not wait for task completion.

## Release observation window

For [eligible planned image replacements](../drivers/kubernetes-compute.md#planned-image-replacement),
the original task and result delivery may finish for up to 30 minutes before the
Gateway and Harness stop. Independent new requests are rejected during this wait;
V1 does not buffer them. Users can retry after the upgrade. Unsupported revisions
and first adoption retain the previous replacement behavior.

The helper defaults to a 60-minute Agent replacement observation window after
dispatch, covering completion waiting and subsequent replacement. Other phases,
including Doctor, retain their 15-minute default. `--timeout-seconds` overrides
both defaults; a shorter operator window can end before a busy Agent finishes.
