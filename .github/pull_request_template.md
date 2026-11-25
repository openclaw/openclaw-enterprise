<!--
Write the title and opening problem statement for OpenClaw Enterprise operators.
Name the affected task and the symptom or outcome, not only the implementation.
Good: fix: explain why an Agent deployment is not ready
Bad: fix: add a revision readiness predicate
For internal-only work, name the actual developer or operator workflow affected;
do not invent an end-user benefit.
-->

## Problem

<!--
In 1–3 plain sentences, say who is affected, what happens today, and why it
matters to them. For a bug, name the trigger if known. For a feature or internal
work, describe the need in the actual workflow without inventing harm.
Could a reader understand the problem without knowing your proposed fix?

Good: "Background checks can use up a new user's model allowance before they've
asked the assistant to monitor anything."
Bad: "Turn off periodic checks on fresh installs."
-->

<!-- What is broken or missing? Link the related issue or prerequisite PR. -->

## Change

<!-- Describe the behavior change and scope. For a stack, name the intended base. -->

## Verification

<!--
Lead with the behavior checked and the observed result in plain language, then
include exact commands and supporting evidence. Put long logs and commit hashes
in links or optional <details>. Keep meaningful gaps, risks, and required
actions visible; do not make readers decode commands to learn what was verified.
-->

<!-- Exact checks and outcomes, including failures, skips, and unrun proof. -->

## Risks

<!-- Security, compatibility, deployment impact, or "none identified" with context. -->

<!-- Keep credentials, tenant data, and private machine details out of this PR.
Report unpatched vulnerabilities privately to security@openclaw.ai instead. -->
