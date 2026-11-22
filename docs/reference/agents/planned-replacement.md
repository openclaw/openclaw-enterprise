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

## Automation grants

A successor must preserve every unretired automation's captured operations and
binding identities. Deployment admission checks the proposed revision under the
Namespace and Agent locks; the worker repeats the check before binding or
preparing a runtime. Paused jobs and uncertain creation records still constrain
the successor. OCC-managed startup/recovery cannot use an earlier successful check
to admit a changed binding. A kubelet restart of the same immutable live revision does not
call the controller again; it can run native catch-up under its captured grant.

Adding an unrelated operation does not enlarge an existing job. Removing a
captured operation, changing its endpoint or identity, or widening its action or
approval authority blocks replacement. Delete and retire the affected automation
first, deploy the narrower policy, then recreate scheduling if needed. Retirement
keeps authorized history; pausing does not release the grant. See
[automation policy changes](../agent-automations.md#policy-changes-and-retained-grants)
for confirmed deletion, absent jobs and uncertain outcomes.

Changing the Installation's endpoint attestation alone does not stop running
native cron. Disable/delete jobs to stop future scheduling; service-side denial
blocks further provider calls, while an in-flight call can complete.
