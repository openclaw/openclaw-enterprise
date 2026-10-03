---
status: Proposed
status_note: "Retroactive record. Every decision below is already implemented on main (PRs 2026-09-28 to 2026-10-01). It records those decisions for human review; it is not accepted, and review may reopen any of them."
---

# Proposal: Human sign-in hardening

- **ID:** RFC-0045
- **Owner:** freeqaz (record). Auth design review: needed.
- **Created:** 2026-10-01
- **Last updated:** 2026-10-03
- **Source baseline:** `main` at `521549dff`. Every symbol and number below was read there; rechecked at `04d01d02e`.
- **Related:** [RFC 31](31-human-federated-sign-in/index.md) owns GitHub sign-in, the attempt,
  receipt and session-key design, and the original sign-in admission section, which this record
  supersedes for password and external sign-in. [RFC-0042](0042-oidc-sign-in.md) owns generic OIDC. Current
  behavior: [authentication](../../docs/reference/authentication.md),
  [external sign-in](../../docs/reference/authentication/external-sign-in.md).

<a id="problem-and-decision"></a>

## Summary

PRs merged between 2026-09-28 and 2026-10-01 changed how people sign in. Each was reviewed on
its own; no human has reviewed the combined design. This record states what landed, why, and
what it costs, so a reviewer can accept, change, or reopen it.

Password sign-in in both profiles uses one failure-counting limiter, keyed on email and (only
behind a trusted proxy) client address. Spent budgets pace attempts instead of dropping them.
Administrators and the recovery account are paced, never refused by sequential guessing. A
browser that signed in before gets its own lane through a known-device cookie. Operators can
limit password sign-in to the recovery account. External sign-in keeps RFC 31's flow with
tighter edges, and sessions from a removed or reconfigured provider end.

## Context

Before [#613](https://github.com/openclaw/openclaw-enterprise/pull/613), the password-only
profile called Better Auth's server API directly, which skips its router limiter, so guessing
was unlimited. An earlier fix (10 per minute per address and email) was reverted before launch
because anyone who knew the only administrator's email could lock them out. The analysis
behind the follow-ups named five threats: T1, per-email lockout of a known user; T2, crowding an
administrator out of a paced lane; T3, budgets in memory per controller; T4, without a trusted
proxy every browser behind the ingress shared one budget; T5, anyone could spend the recovery
account's lane. Enabling GitHub or Google was not a mitigation: every account kept a password,
under an older, harsher limiter.

## Decision as landed

### Password admission (both profiles)

`passwordFailureAdmission` in [`admission.ts`](../../apps/controller/src/auth/admission.ts),
behind the `PasswordSignInAdmission` seam. [#727](https://github.com/openclaw/openclaw-enterprise/pull/727)
moved the external-provider profile's `/oce/password` onto it from attempt-counting
`keyedAdmission` and dropped that profile's global 4+1 password concurrency cap.

- **Lanes.** 10 failures per minute per email; 20 per client address, only when
  `OCC_AUTH_TRUSTED_PROXY_CIDRS` resolves the address. In-flight attempts count, so concurrent
  guesses cannot overrun a lane. Successes never spend budget, and a success in the shared lane
  clears the email's failures, not the address's
  ([#613](https://github.com/openclaw/openclaw-enterprise/pull/613),
  [#695](https://github.com/openclaw/openclaw-enterprise/pull/695)).
- **Refusals create nothing.** Admission checks existing entries before claiming any. A claim
  never evicts an entry that is in flight or has spent budget this window, so flooding new keys
  cannot reset someone's budget. The table holds 4,096 entries; when it is full of spent
  entries, a new key goes to the slow lane and its password is still checked.
- **Slow lane.** Past the budget, an attempt waits for one of two slots for its email (16 may
  wait, 1,024 across all emails, 16 password checks at once) and holds the slot for a floor
  that doubles from 1 s to 8 s. Only a reserved account's password is then checked. Every
  other outcome is `429` with `Retry-After` after the same floor, so status and timing do not
  reveal whether the email exists or is reserved. Reserved means an Installation administrator
  (`passwordAdministrator`) or, with an external provider, the designated recovery account;
  under `recovery-only`, only the recovery account.
- **Audit.** Password-only sign-ins write `authentication.login`; a wrong password or unknown
  email is denied with `INVALID_CREDENTIALS` and no account. Audit writes fail closed (`503`).
  A wrong password whose denial audit fails still counts as a failure (`DenialAuditUnavailable`,
  `countsAsSignInFailure`), so an audit outage cannot open unlimited guessing
  ([#707](https://github.com/openclaw/openclaw-enterprise/pull/707) password-only,
  [#738](https://github.com/openclaw/openclaw-enterprise/pull/738) guarded, via
  `refusePassword` and `PASSWORD_DENIAL_AUDIT_UNAVAILABLE`).
- **Visibility** (#695). Without a trusted proxy, startup logs
  `authentication.sign-in-limit-warning` (`TRUSTED_PROXY_NOT_CONFIGURED`) and Helm NOTES warn;
  nothing fails, since a source-preserving load balancer needs no proxy. The first slowed
  attempt per lane per minute logs `authentication.sign-in-limited` with the lane and a keyed
  hash, never the email or address.

### Known-device exemption

[`known-device.ts`](../../apps/controller/src/auth/known-device.ts)
([#697](https://github.com/openclaw/openclaw-enterprise/pull/697),
[#728](https://github.com/openclaw/openclaw-enterprise/pull/728),
[#760](https://github.com/openclaw/openclaw-enterprise/pull/760)):

- Every successful sign-in (external only when the account has a password) sets `__Host-occ_known_device` (`occ_known_device` when cookies are not Secure, as on an HTTP base URL): HttpOnly, `SameSite=Strict`, host-only, 90 days,
  up to three `v2` entries. Each entry is a MAC over a hash of the email, the issue time and a
  nonce, plus a second MAC binding it to the account's password state (user, password method,
  that method's `authentication_version`; in the guarded profile only enrolled, enabled
  accounts have a state). The cookie never carries the email and never authenticates.
- A verified entry replaces the email lane with a per-entry lane of the same size and its own
  slow-lane slots. The address lane still applies. A wrong password with a valid cookie is
  `401` and spends that browser's lane.
- Revocation: a password reset or account recreation revokes every earlier entry; a disabled
  account's entries verify nothing while it stays disabled; rotating `OCC_AUTH_SECRET` revokes
  all. The account's own `version` is excluded so attaching an identity does not strand a
  browser.
- Verification reads account state only after the entry's MAC matches the attempted email.
  Those reads are bounded (`knownDeviceReads`): 30 per entry per minute and 2 active, 600 per
  minute and 16 active per controller. A refused or failed read grants no exemption, and the
  entry keys stay as extra constraints on the shared lane, so losing proof cannot reopen a spent
  device budget.

### Recovery-only password sign-in

`OCC_AUTH_PASSWORD_SIGN_IN` (`passwordSignInPolicy`; Helm `auth.passwordSignIn`) is `all` by
default or `recovery-only`, which requires GitHub, Google or OIDC
([#723](https://github.com/openclaw/openclaw-enterprise/pull/723)). Under `recovery-only`,
`/oce/password` answers every non-recovery email with the ordinary bad-credential refusal
after hashing the password, without reading an account. `GET /api/auth/providers` reports
`password: false` and the Console shows a **Recovery sign-in** link instead of the form.
Startup warns (`EXTERNAL_IDENTITY_MISSING`) about enabled non-recovery accounts with no
identity at a configured provider; it still starts.

### External sign-in invariants

RFC 31 and RFC-0042 own the flow. These PRs tightened it:

- **Tab binding** ([#522](https://github.com/openclaw/openclaw-enterprise/pull/522), RFC 31
  M2): a two-minute receipt cookie plus `attemptId` is exchanged once for a `sessionKey`, and
  `x-occ-session-key` can only narrow which cookie session a request uses.
- **Receipt names its provider instance**
  ([#844](https://github.com/openclaw/openclaw-enterprise/pull/844)): `signLoginReceipt` writes
  `v: 2` with the provider ID; `verifyLoginReceipt` checks it before the session lookup or
  consumption. A wrong-route refusal leaves the receipt usable at its own route; old unbound
  receipts force a restart.
- **Pending attempts** ([#625](https://github.com/openclaw/openclaw-enterprise/pull/625)):
  State keeps at most 1,000 (`pendingAttemptCapacity`) and evicts the oldest instead of refusing
  new starts.
- **Lanes** (#727): start, callback and result each have 30 per minute and 4 active per key, 8
  active per step. Behind a trusted proxy the key is the address; without one, callback and
  result key on the browser's attempt or receipt cookie and start has only the active cap.
- **Origin** ([#509](https://github.com/openclaw/openclaw-enterprise/pull/509),
  [#647](https://github.com/openclaw/openclaw-enterprise/pull/647)): every unsafe
  cookie-authenticated request without an API key needs the exact Console `Origin` and, when
  present, `Sec-Fetch-Site: same-origin` (`verifyControllerRequest` →
  `requireSessionMutationOrigin`). Sign-out, the result exchange and, since #647, provider
  start apply the same gate. #647 also made the guarded adapter hide raw session rows from
  listing and counting.
- **Denial codes** ([#636](https://github.com/openclaw/openclaw-enterprise/pull/636)):
  callbacks audit `INVALID_ATTEMPT`, `PROVIDER_UNAVAILABLE` or `EXTERNAL_IDENTITY_REJECTED`.
- **Provider removed or reconfigured**
  ([#797](https://github.com/openclaw/openclaw-enterprise/pull/797)):
  `PostgresHumanAuthentication.currentSession` checks, in its one query, that an external
  session's provider instance (client ID digest, plus issuer for OIDC) is in
  `externalProviderIds`; if not, it deletes the session and audits `authentication.session.end`
  (`PROVIDER_NOT_CONFIGURED`) once. Password sessions and client secret rotation are unaffected.

## Lockout and denial-of-service trade-offs

Who can keep whom out, after these changes. "New browser" means no valid known-device entry.

| Target                                                  | Attacker needs                                                                                                                        | Result                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary account, known browser                         | Spend the email lane                                                                                                                  | No effect while proof reads succeed                                                                                              |
| Ordinary account, new browser (password-only, or `all`) | 10 failures per minute at the email, from anywhere                                                                                    | `429` for that minute, renewable (T1 remains)                                                                                    |
| Administrator or recovery, new browser                  | About 18 concurrent attempts at the email                                                                                             | Crowded out of the slow lane; fewer only delays them (T2 remains)                                                                |
| Administrator or recovery, known browser                | Spend the email lane                                                                                                                  | No effect: own lane and slots                                                                                                    |
| Any known browser                                       | 600 proof reads per minute across about 20 MAC-valid entries, which only a signed-in user can mint                                    | Every known browser falls back to the shared lane for that minute (inferred from code, not tested)                               |
| Everyone, no trusted proxy                              | Spray failures at about 4,096 distinct emails per minute from one source                                                              | Each attempt hashes a password; the table fills and new keys are paced by one shared floor (up to 8 s), still checked (inferred) |
| External start                                          | Keep 8 starts active (one source without a trusted proxy, two addresses with one), or about 1,000 starts during one user's round trip | Other starts get `429`, or that user's attempt is evicted and must restart                                                       |

Reserved accounts are paced, not refused: guessing continues at about 15 per minute per email
past the budget so a stranger cannot keep them out sequentially. The per-email lane accepts T1
for new browsers; without it a distributed attacker guesses each email freely.

## Alternatives considered

- **Per-(address, email) limit with no bypass:** reverted before launch; locks out the only
  administrator.
- **Pace everyone, refuse no one:** removes T1 but allows about 36,000 guesses per email per day
  and spreads T2 to every account.
- **Require a trusted proxy in Helm:** rejected for valid source-preserving setups and existing
  upgrades; warnings instead.
- **Durable State-owned budgets (#557, #565):** drafts closed unmerged. They fix T3, not who can be locked out,
  and add a database round trip to every sign-in. The seam remains.
- **Bind known devices to the account version:** rejected; identity attach would strand browsers.
- **Captcha, proof of work, passkeys:** out of scope for launch.

## Known gaps and residual risk

- T1, T2 and the inferred floods in the table above.
- T3: budgets, the receipt ledger and proof-read limits live in one controller's memory. A
  restart resets them; the chart runs one API Pod with `Recreate`.
- No global cap on concurrent password hashing in the shared lane since #727.
- Re-enabling an account restores entries issued before the disable if the password did not
  change. There is no per-device or per-account revoke short of a reset or secret rotation.
- Address keys hash the full address, so an IPv6 client can rotate within its prefix.
- `recovery-only` strands accounts without an external identity; startup only warns.
- #797 ends sessions on next use; an unused stale session never authenticates but stays until
  it expires.
- `recovery-only` gates new password sign-ins only. Existing password sessions keep working for
  up to 8 hours (`session.expiresIn`), as does the former holder's after the recovery
  designation moves; revoke or `purge-sessions` ends them
  ([#891](https://github.com/openclaw/openclaw-enterprise/pull/891) documents this).
- Evidence is source review and PostgreSQL integration tests in each PR. There is no live
  GitHub App test. A dogfood install exercised OIDC sign-in against Keycloak and the #797
  session end; the lockout trade-offs above have not been load-tested.

## Open questions for reviewers

1. Should `recovery-only` become the default when an external provider is configured?
   **Implemented:** `all`.
2. Should a missing trusted proxy fail installation when external sign-in is enabled?
   **Implemented:** warn only.
3. Are 90 days and three entries right for known devices, and should disabling revoke for good?
   **Implemented:** 90 days, three entries; re-enable restores unchanged-password entries.
4. Should the shared lane cap concurrent password hashing per controller?
   **Implemented:** no cap.
5. Is losing known-device exemptions under proof-read saturation acceptable, or should reads be
   cached? **Implemented:** fail closed to the shared lane, no cache.
6. Do we need an administrator unlock or durable budgets before running more than one
   controller? **Implemented:** neither; one controller.
7. Should ending a provider's sessions on reconfiguration require an operator step instead of
   happening at restart? **Implemented:** automatic, audited once per session.
