---
status: Proposed
implementation_status: Implemented
author: freeqaz
status_note: "Retroactive record of changes landed on main from 2026-09-28 through 2026-10-01, with later corrections identified below. The combined design awaits human review. Review may reopen any decision."
---

# Proposal: When the controller will check a human sign-in password

- **ID:** RFC-0024
- **Created:** 2026-10-01
- **Last updated:** 2026-10-23
- **RFC PR:** [#856](https://github.com/openclaw/openclaw-enterprise/pull/856)

<a id="problem-and-decision"></a>

<a id="summary"></a>

## Decide when ten wrong guesses should block a correct password

A stranger makes ten wrong guesses in a minute for `emma@example.test`. Emma then types the
**correct password** on a new laptop. The controller waits, replies `429` with `Retry-After`, and
**never checks her password**. There is no administrator unlock for this limit. If Emma has no
recognized browser or other sign-in method she can use, she can try after the minute resets, but
someone can spend the next minute’s allowance too.

A browser we recognize gives Emma a separate allowance. For the designated recovery account, we
can still check the password on a new laptop if there is room in the queue. Someone can occupy
both slots and all sixteen waiting places. The person trying to recover has no guaranteed place.

**Proposed amendment to RFC-0007.** Keep the refusal for ordinary accounts and the paced
password check for reserved accounts. This limits guessing at the cost of a renewable lockout.
Pacing and checking every password instead would allow roughly 25 guesses a minute per email,
about 36,000 a day.

An authentication maintainer should decide two cases before accepting the amendment:

1. **Ordinary account, repeated lockout.** If a stranger spends each new window and Emma has
   neither a recognized browser nor another sign-in method, can the controller continue to
   refuse her correct password? If that outcome is unacceptable, specify how she regains access.
2. **Recovery account, full queue.** May the controller return `429` to the designated recovery
   user on a new browser when that email's queue is full, or must the installation provide an
   independent way to regain access under contention?

This record replaces only [RFC-0007's sign-in admission section](0007-human-federated-sign-in/index.md#sign-in-admission).
[RFC-0007](0007-human-federated-sign-in/index.md) still defines GitHub sign-in, browser receipts and session keys; [RFC-0001](0001-oidc-sign-in.md)
defines OpenID Connect (OIDC). For operating instructions, use [password and session authentication](../../docs/reference/authentication.md)
and [external sign-in](../../docs/reference/authentication/external-sign-in.md).

<a id="context"></a>

<a id="decision-as-landed"></a>
<a id="password-admission-both-profiles"></a>

## Follow Emma's attempt through the controller

The password-only configuration calls Better Auth's server API directly, so its router limit
never protected this path. With GitHub, Google or OIDC configured, the controller instead uses
its private `/oce/password` endpoint to check a password and issue a session. Both paths now use
[`passwordFailureAdmission`](../../apps/controller/src/auth/admission.ts). Admission decides whether
to try the password; only a successful sign-in can establish a session.

| What the controller finds                                            | What it does                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room in every applicable budget                                      | Check the password. Allow ten failures per minute for the email **or** verified browser entry, and twenty for the client address when configured. Count in-flight attempts. Success clears this email's or browser's failures, never everyone else's at the address.                                                      |
| A tracked budget is spent; ordinary account                          | Delay, then refuse with `429` and `Retry-After`. That header describes the budget window; it does not reserve Emma's next attempt or mean her password was wrong.                                                                                                                                                         |
| A tracked budget is spent; reserved account                          | With room in the slow lane, check the password and wait out the delay. A correct password can work; a wrong one gets the same `429`, without spending next minute's budget. Reserve this path for an Installation administrator or the designated recovery user; in `recovery-only` mode, reserve it only for the latter. |
| **No budget is exhausted, but the table has no room for a new key.** | If admitted to the slow lane, start the minimum-delay timer and check the password, even for an ordinary account. Hold the slot until both finish. A new key cannot evict an entry in use or one that recorded any failure in its current window, so filling the table cannot erase Emma’s limit.                         |

The slow lane doubles its minimum delay from one second up to eight. For one email, two attempts
can hold slots and sixteen more can wait. Across emails, up to 1,024 attempts can hold or wait for
slots, with at most sixteen account lookups or password checks running at once. We use the same
delay floor and refusal for an unknown, ordinary or reserved email; this is not a claim that
all response times are identical. [#727](https://github.com/openclaw/openclaw-enterprise/pull/727)
removed the old global limit of four password attempts plus one recovery slot. The sixteen-check
limit applies in the slow lane, not to password hashing across the controller.

### What to look for when someone reports a refusal

A password decision normally writes `authentication.login`. Wrong password and unknown email
both yield `401`, spend budget, and record `INVALID_CREDENTIALS` without identifying an account.
If we cannot audit that denial, we fail closed with `503` and still count the guess. The guarded
endpoint signals this internally as `PASSWORD_DENIAL_AUDIT_UNAVAILABLE`. On the spent-budget
reserved path, the caller instead gets `429` whether that denial audit succeeded or failed.
An actual dependency failure, including a Better Auth server error, yields `503`
(`DEPENDENCY_UNAVAILABLE`) and does not count as a wrong guess. See [the controller's error and
budget handling](../../apps/controller/src/auth/index.ts).

Two input boundaries matter when reconciling counts. In the guarded configuration, a password
outside 12–128 characters or an email longer than 254 yields `401` and spends budget without a
login audit. An email containing NUL or an unpaired surrogate instead yields `400 INVALID_REQUEST`
inside admission: both configurations count and audit the refusal without reading device or
account state. It is never reserved; once its budget is spent, it gets the delayed `429`.

<a id="known-device-exemption"></a>

## Why Emma's familiar browser may still work

[`__Host-occ_known_device`](../../apps/controller/src/auth/known-device.ts) gives a browser its
own ten-failure budget and slow-lane slots for this email. Emma still needs her password, and
the address and controller limits still apply. Successful sign-in sets a host-only, HttpOnly,
`SameSite=Strict` cookie for ninety days, with up to three `v2` entries. Without Secure cookies
the name is `occ_known_device`. External sign-in marks the browser only if the account has a
password; on the password-only path, failure to read account state skips marking, not sign-in.

Each entry authenticates an email hash, issue time and nonce, then separately binds the user,
password method and `authentication_version`. The cookie contains no email address. Only a
matching message authentication code (MAC) permits an account-state read. Each entry is limited
to thirty reads a minute and two in progress. Across the controller the limits are six hundred a
minute and sixteen in progress. Both limits apply.
If proof is unavailable, shared admission applies _with_ the signed entry's limits, so losing
proof cannot replenish a spent browser budget.

Resetting the password or recreating the account invalidates old entries. Rotating `OCC_AUTH_SECRET`
invalidates them all. In the guarded configuration only an enrolled, enabled account has password
state. Disabling it suspends recognition; re-enabling it restores recognition if the password did
not change. Attaching an external identity does not invalidate the browser. There is no operation
to revoke just one browser's or one account's entries.

<a id="lockout-and-denial-of-service-trade-offs"></a>
<a id="known-gaps-and-residual-risk"></a>

## Where these protections run out

These are consequences of the recorded limits, **not measured attack costs or availability promises**.

- **Recovery under contention.** Sequential guessing alone does not exclude a recovery holder on
  a new browser. About eighteen simultaneous attempts to that email can occupy both slots and all
  sixteen waiting places. A recognized browser avoids that email queue while proof reads succeed.
- **Loss of browser recognition.** We infer that about twenty MAC-valid entries could spend the
  six-hundred-read minute for everyone. One account holder can retain cookies from twenty sign-ins;
  the three-entry limit is per cookie, not a limit on how many cookies exist.
- **One address for an entire site.** With `OCC_AUTH_TRUSTED_PROXY_CIDRS` set, trust a forwarded
  address only from a trusted socket peer. Otherwise, or for a malformed header, use the peer
  itself. Missing the actual ingress peer in that list silently puts all its browsers in the same
  twenty-failure budget. Log the first slowdown per key per minute as `authentication.sign-in-limited`,
  with the lane and a keyed hash, never the address or email. Reject prefix zero, leading-zero
  prefixes and IPv6 subnets covering `::ffff:0:0/96`; normalize IPv4-mapped addresses to one key.
  An IPv6 client can still rotate addresses within a prefix.
- **Guessing across emails or controllers.** With no trusted-proxy setting we warn
  (`TRUSTED_PROXY_NOT_CONFIGURED`) and apply no address budget, preserving direct-source deployments.
  We infer one source could try roughly 4,096 distinct emails a minute, fill the tracking table
  and keep causing password checks on the shared-delay path. Budgets, the receipt ledger and
  proof-read limits live in one controller's memory. Restart resets them; the recorded chart uses
  one API Pod with `Recreate`.

<a id="alternatives-considered"></a>

A limit on each (address, email) pair let a stranger lock out the only administrator; we reverted
it before launch. Removing the email limit would let distributed guesses avoid it. State-owned
budgets in [#557](https://github.com/openclaw/openclaw-enterprise/pull/557) and
[#565](https://github.com/openclaw/openclaw-enterprise/pull/565) were closed, unmerged proposals.
Durable accounting would add a database round trip and would still leave us to decide whose
password to check. CAPTCHA, proof of work and passkeys were outside launch scope.

<a id="recovery-only-password-sign-in"></a>

## Recovery and external sign-in have different session rules

**Restricting passwords affects new sign-ins.** `OCC_AUTH_PASSWORD_SIGN_IN` defaults to `all`.
With an external provider, an operator may select `recovery-only` (Helm `auth.passwordSignIn`).
The Console then offers _Recovery sign-in_, while `GET /api/auth/providers` reports `password: false`.
For other emails, `/oce/password` hashes the submission and gives the ordinary bad-credential
response without reading an account. Startup warns `EXTERNAL_IDENTITY_MISSING` but continues if
an enabled non-recovery user lacks an identity at a configured provider; that user can be left
with no sign-in path. Existing password sessions, even a previous recovery holder's, can last
eight hours. Revoke them or use `purge-sessions` to end them earlier.

<a id="external-sign-in-invariants"></a>

**Changing an external provider affects existing sessions on use.** The tab exchanges its
two-minute receipt and `attemptId` once for a `sessionKey`; `x-occ-session-key` narrows which cookie
session a request can use. The `v: 2` receipt binds the provider ID before lookup or consumption:
the wrong route leaves it usable at the right one; an unbound receipt requires a new start.
[`currentSession`](../../packages/occ/src/state/human-authentication.ts) checks the provider's
client ID digest and, for OIDC, issuer in the session query. If no longer configured, end the
session and audit `PROVIDER_NOT_CONFIGURED` once, on use. An unused stale row can remain until
expiry but cannot authenticate. Client-secret rotation and password sessions are unaffected.

Start, callback and result allow thirty requests a minute and four active per key, eight active
per step. Without a trusted proxy, start has only the active cap; callback and result use the
attempt and receipt cookies, respectively. Eight occupied starts can block a newcomer (one source without a
trusted proxy, two addresses with one). PostgreSQL keeps 1,000 pending attempts per Installation,
evicting the oldest to admit a new one; a returning user may have to start again. Browser
mutations, including sign-out, result exchange and provider start, require the exact Console
`Origin` and, if sent, `Sec-Fetch-Site: same-origin` for unsafe cookie requests without an API key.
The guarded adapter also hides raw session rows from list and count operations.

Unmatched callbacks increment `occ_sign_in_unmatched_callbacks_total` without a denial audit.
On a matched attempt, audit `EXTERNAL_IDENTITY_REJECTED` or `PROVIDER_UNAVAILABLE`; a provider
refusing our client is the latter. The bound browser can distinguish `provider-unavailable` from
`unavailable` inside OCE. An identity authenticated for a disabled, enrolled account can receive
`account-disabled`; we audit `ACCOUNT_DISABLED` with the user ID. Unattached or unenrolled identities,
attempts predating other account changes, and password refusals stay generic. GitHub's optional
organization or team check can refuse before account lookup, with `MEMBERSHIP_REQUIRED` or
`MEMBERSHIP_UNAVAILABLE`; its separate design is in
[#1229](https://github.com/openclaw/openclaw-enterprise/pull/1229).

<a id="open-questions-for-reviewers"></a>

## What the authentication maintainer still needs to settle

The two admission decisions above govern this amendment. The following choices remain open for
separate review if a maintainer wants to change the surrounding policy:

- Which sign-in methods an installation permits by default when an external provider is configured,
  and whether reconfiguring that provider should invalidate sessions on use.
- When to require trusted proxy configuration, controller-wide hashing limits or durable budgets
  as installations grow beyond one controller.
- How long a browser remains recognized, whether recognition survives account re-enablement,
  and whether to cache proof reads when the account store is under pressure.

Source baseline: `main` at `521549dff`, reviewed through `07590c64e`; relevant controller and
State files compared with `00bbc7cd9` on October 15. The original record cites the implementation
PRs' PostgreSQL integration tests and an OIDC sign-in and provider-removal exercise with Keycloak.
It reports neither a live GitHub App test nor load tests of these lockout scenarios.

For the implementation and its tests, follow the change relevant to the decision:

- Password budgets and denial accounting ([#613](https://github.com/openclaw/openclaw-enterprise/pull/613), [#695](https://github.com/openclaw/openclaw-enterprise/pull/695), [#707](https://github.com/openclaw/openclaw-enterprise/pull/707), [#727](https://github.com/openclaw/openclaw-enterprise/pull/727), [#738](https://github.com/openclaw/openclaw-enterprise/pull/738), [#1343](https://github.com/openclaw/openclaw-enterprise/pull/1343)).
- Recognized browsers and bounded proof reads ([#697](https://github.com/openclaw/openclaw-enterprise/pull/697), [#728](https://github.com/openclaw/openclaw-enterprise/pull/728), [#760](https://github.com/openclaw/openclaw-enterprise/pull/760)).
- Trusted address handling ([#1599](https://github.com/openclaw/openclaw-enterprise/pull/1599), [#1672](https://github.com/openclaw/openclaw-enterprise/pull/1672)).
- Recovery policy and surviving password sessions ([#723](https://github.com/openclaw/openclaw-enterprise/pull/723), [#891](https://github.com/openclaw/openclaw-enterprise/pull/891)).
- Browser origin, tab receipts, pending attempts and provider-bound sessions ([#509](https://github.com/openclaw/openclaw-enterprise/pull/509), [#522](https://github.com/openclaw/openclaw-enterprise/pull/522), [#625](https://github.com/openclaw/openclaw-enterprise/pull/625), [#647](https://github.com/openclaw/openclaw-enterprise/pull/647), [#797](https://github.com/openclaw/openclaw-enterprise/pull/797), [#844](https://github.com/openclaw/openclaw-enterprise/pull/844)).
- Which callback failures the browser can distinguish ([#636](https://github.com/openclaw/openclaw-enterprise/pull/636), [#1202](https://github.com/openclaw/openclaw-enterprise/pull/1202), [#1228](https://github.com/openclaw/openclaw-enterprise/pull/1228), [#1231](https://github.com/openclaw/openclaw-enterprise/pull/1231), [#1610](https://github.com/openclaw/openclaw-enterprise/pull/1610)).
