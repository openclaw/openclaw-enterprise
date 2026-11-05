---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Proposal: Refresh mapped GitHub team memberships between sign-ins

- **ID:** RFC-0030
- **Created:** 2026-11-03
- **Last updated:** 2026-11-05

When Maya leaves a GitHub team, OCE should be able to withdraw the access she
received through that team even if she never signs in again. We propose checking
each mapped team's roster every six hours. An administrator who knows Maya has
left can withdraw that membership immediately, even during a GitHub outage.

The [default users proposal (#4207)](https://github.com/openclaw/openclaw-enterprise/pull/4207)
defines sign-in verification, provider mappings, accounts, Groups and Roles. It
also owns deployment and Agent credential grants. This companion covers what
happens **after sign-in** for an existing GitHub team mapping.

## What changes after a roster check?

Suppose Maya and Eli both joined the Support Group through the same GitHub team.
When GitHub confirms that Maya has left, OCE withdraws only the contribution
that mapping made to her Support membership. Eli retains his membership. If a second
team maps Maya to Support, or an administrator added her directly, she still
belongs to Support through that source. Her independent grants and the shared
Agent, its credentials and its running work survive the withdrawal.

The mapping and sign-in work in #4207 (slices 4 and 5) must give IAM a durable
record of each contribution, identifying the rule, account attachment and target
Group. Several rules can independently support the same membership. Only trusted
verification can establish new provenance. Leave legacy memberships with unknown
origins intact.

A roster read grants nothing. After an automated withdrawal, a new verified
sign-in can restore the contribution. An administrator's local withdrawal applies
to the exact rule and attachment. It takes effect immediately and persists until
an authorized administrator clears it and the person verifies membership again.

## Which roster can change access?

Before enabling refresh for a mapping, verify that an authorized background
reader can enumerate the entire team without a member's sign-in session. Bind
the mapping to the provider instance and immutable GitHub organization and team
IDs. Use the same membership criteria as sign-in and match immutable provider
subject IDs to the original account attachments. A rename leaves the team's
identity intact. A replacement team with the same slug supplies no evidence
about the original team.

Every six hours, stage every page of the [GitHub team roster](https://docs.github.com/en/rest/teams/members#list-team-members).
People can move between page numbers during a read. An omission makes someone a
candidate for a membership check. Before withdrawing them, obtain authoritative
evidence that this subject lacks active membership in this team. Establish that
the reader can see the team and its memberships and that any names used in the
lookup still resolve to the pinned IDs at verification. An ambiguous `404`,
lost visibility or an unverifiable identity leaves the decision pending.

Both sign-in and refresh must capture the current rule, attachment and membership
decision versions **before** reading GitHub. Each may commit only if those
versions still match. A withdrawal advances the decision version, so a delayed
sign-in cannot restore membership using pre-withdrawal proof. A delayed refresh
likewise cannot undo a newer sign-in. Once every page and candidate check
succeeds for the current mapping, commit the withdrawals, their audit records
and the time of the last complete refresh together. Show administrators that
time and any subsequent incomplete attempt.

A missing page, rate limit, permission error or unreadable team leaves the last
committed decisions in force. A restart or missed run does the same. Previously
verified members can keep working past six hours, so a departure during an
outage can go undetected until GitHub confirms it. New identities still
need verified sign-in. Webhook-driven refresh is future work.

## When does a withdrawal take effect?

The next protected request from an existing session must use current access.
Queued work must also pass a current authorization check at the point where
OCE admits a new write or external effect. Order that decision against the
withdrawal. If withdrawal wins and no other authority applies, refuse the
effect. Work already admitted stays with its existing owner for settlement.

## How to verify the decision

- Start the next six-hour check with Maya on page one and Eli first on page two.
  After fetching page one, remove Maya from the provider team so Eli shifts onto
  the already-read page. Verify Eli keeps access despite the omission. On the
  next pass, confirm Maya's departure, record one withdrawal and refuse her
  next team-only action. Eli and the Agent continue working.
- Fail the final page, return an ambiguous membership result, rate-limit the
  reader, and restart mid-read. Verify the last complete time survives, an
  unconfirmed member retains access, and a roster-only identity gains nothing.
- Pause sign-in after it verifies Maya but before it commits. Confirm her
  departure in a refresh, then resume sign-in and verify the stale grant fails.
  Restore her on GitHub and verify a fresh sign-in succeeds. Repeat with a local
  withdrawal and verify sign-in and refresh respect it until cleared.
- Withdraw one of two mapping contributions to Support. Verify the other
  still grants access, administrator and legacy memberships survive, and a
  queued effect relying solely on the withdrawn contribution cannot start.
