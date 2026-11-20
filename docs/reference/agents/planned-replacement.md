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
