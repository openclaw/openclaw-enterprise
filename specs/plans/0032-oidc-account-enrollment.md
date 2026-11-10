---
rfc: ../rfcs/0032-oidc-account-enrollment.md
---

# Implementation plan: OIDC account enrollment

- **ID:** RFC-0032
- **Delivery status:** Implemented and locally verified; final CI pending
- **Authority:** [OIDC account enrollment](../rfcs/0032-oidc-account-enrollment.md)
- **Source baseline:** `origin/main`, refreshed before implementation on 2026-11-09.

## Outcome and scope

Deliver the RFC's generic OIDC admission and enrollment policy, initial native IAM
grant, default Group enrollment, and replacement of direct GitHub browser login.
Keep existing account attachment explicit and preserve repository credentials.

## Implementation

1. Extend the existing OIDC verifier and human-login callback to consume signed
   claims and bind attempts to the resolved enrollment policy. Validate deployment
   configuration at activation and reject retired GitHub login inputs.
2. Extend the existing PostgreSQL account transaction and native IAM composition
   for multiple Groups and a creation-only Role binding. Preserve account freshness,
   uniqueness, and attributable transactional audit evidence.
3. Remove direct GitHub browser exchange, account inputs, discovery, and Console
   controls. Preserve generic recovery and Google login. Update Helm/profile
   configuration, generated API references, authentication flow, and upgrade docs.
4. Extend real callback/PostgreSQL integration coverage and register the supported
   Agent workflow in the QA matrix. Prove initial grants, repeated login, explicit
   attachment, admission denials, conflicts, concurrency, and transaction rollback.
5. Run both RFC browser acceptance scenarios with real model replies. Use a real
   GitHub account through an OIDC broker and validate the membership source and
   freshness. Record evidence without credentials or tokens.

## Verification

| Required outcome              | Proof                                                                         | Status                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Enrollment and initial access | Real callback, PostgreSQL, native IAM and Agent API integration               | 14 focused checks pass; full authentication lane passed 172 checks before this expansion                           |
| Configuration and retirement  | Helm/profile checks, API generation and retired-input rejection               | 55 transport/chart checks, 20 final chart checks and 109 packaging checks pass                                     |
| Generic OIDC chat             | Explicitly attached default user, browser sign-in and real model reply        | Pass: Keycloak, real Agent reply, streaming stop/resume and administrative denials                                 |
| GitHub through OIDC chat      | Real broker sign-in, qualified membership claim, same account and model reply | Pass: GitHub through Dex, explicit attachment, unchanged account/access and real Agent reply                       |
| Quality and documentation     | Typecheck, lint, formatting, workspace, docs and independent review           | Static checks pass; completed independent review finding corrected; stale CI test expectations corrected |

## Delivery record

On 2026-11-09, both live acceptance paths passed against implementation commit
`c6735e928` with documentation correction `d22324d7c`. The generic OIDC test
completed in 144 seconds without skips. It used a disposable Keycloak provider,
PostgreSQL, a Helm-installed controller and a real Agent on a local k3d cluster.
Earlier attempts failed because a model reply timed out, a startup model probe
was rate-limited, and a restarted provider was not ready. The final run passed.

The GitHub scenario used a disposable OAuth app and Dex v2.46.1. An administrator
created the OCE account with the default user Group and attached its verified
OIDC subject explicitly. Browser login retained the same account, Principal,
AuthenticationMethod and access. The Agent returned the requested test marker.
An Installation read using that user session was denied.

Removing the test team membership blocked a fresh login within the observed
52-second test interval; restoring membership allowed the same account to sign
in again. Dex queried GitHub during each login and emitted the qualified team
claim. This measurement is a qualification result, not a guaranteed revocation
latency. Existing OCE sessions are outside that fresh-login check.

CI follow-up corrected the retired-provider fixtures: 83 Console browser checks,
12 authentication-maintenance checks, 13 production startup checks, and the
changed CI browser-preparation check pass. Four logging-packaging checks retain
the shared sign-in Secret isolation case through Google. The API and profile/chart parity checks
also pass. Broader local CI-preparation tests require Linux `setsid`; their
unrelated cases cannot run on this macOS host. Final hosted CI remains pending. A separate review of the test follow-up found
no P0–P2 issues. The disposable cluster and databases were removed after verification.

Current behavior is documented in
[external sign-in](../../docs/reference/authentication/external-sign-in.md) and
[OIDC upgrade](../../docs/guides/deploy/oidc-upgrade.md). Review media and live
acceptance evidence are attached to
[PR #5144](https://github.com/openclaw/openclaw-enterprise/pull/5144).

## Callback simplification

Commit `65aa5bd78` resolves default Groups and the policy fingerprint at startup,
passes the validated profile as data, and distinguishes missing identities from
refused existing identities in one lookup. Enrollment and session transactions
retain their freshness and concurrency checks. Operator configuration is unchanged.

The 176 PostgreSQL authentication checks pass across the full run and a targeted
rerun after correcting the detached-identity expectation. All 50 Google/OIDC
transport and token checks pass. Typecheck, lint, formatting, workspace isolation,
OpenAPI and documentation checks pass. Independent review found no P0–P2 issues.

Both live acceptance paths were repeated against this refactor. The generic OIDC
workflow passed in 141 seconds without skips, including real chat and streaming
stop/resume. GitHub/Dex login retained the same account, Principal, methods,
default-user Group and Agent grant; chat returned the requested marker and
Installation access was denied. Two earlier generic runs stopped at Agent startup
because of model-provider rate limits. Selecting another real model resolved that
failure. The earlier GitHub team-removal qualification was not repeated.

## Test retention audit

The direct GitHub browser consumer is removed. Repository credential consumers
remain unchanged. Reviewed history includes the original team-enrollment change
`bfc205fd1`, shared result handling `b6a07b787`, and OIDC chat `5cf15141c`.

| Previous test                                                                | Disposition and remaining proof                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-login-transport.test.mjs`: transport and allowlist cases             | Delete retired GitHub HTTP/allowlist behavior. Google/OIDC transport cases retain deadlines, bounded bodies, token validation and shared admission. Move “guarded adapter never lists, counts or mutates raw session rows” unchanged to Google coverage. |
| `postgres-github-org-allowlist.test.mjs`: org/team denial                    | Delete direct membership lookup coverage; signed-claim admission now belongs to `postgres-oidc-enrollment.test.ts`. Live broker qualification separately checks its GitHub membership source.                                                            |
| `postgres-github-team-enrollment.test.ts`: account/Group creation            | Replace with OIDC enrollment coverage for exact identity, verified profile, conflict, scoped initial grants, Groups, concurrency, rollback and stale attempts.                                                                                           |
| `postgres-github-sign-in.test.mjs`: existing-account Console sign-in         | Existing OIDC and Google suites retain callback, session, account, transport and recovery behavior. The real OIDC Agent journey covers browser adoption and chat.                                                                                        |
| `postgres-github-tab-binding.test.mjs`                                       | Remove the duplicate shared tab-binding invocation; retain `postgres-oidc-tab-binding.test.mjs`.                                                                                                                                                         |
| GitHub-named account scope, attach, cookie commit, outage and recovery tests | Preserve the scenarios through OIDC; keep shared cookie behavior in `postgres-human-session-cookie.test.mjs`.                                                                                                                                            |

The shared Console tests now use Google for fixed-provider focus, recovery,
callback and return-destination behavior. The obsolete GitHub allowlist-message
case is replaced by unknown-reason handling; signed-claim admission remains in
the OIDC integration tests. Profile/chart parity keeps the supported Google and
OIDC combinations and removes GitHub-only Secret collisions. CI browser setup
tracks the retained PostgreSQL OIDC sign-in test. The startup-phase assertion
reflects identity and Compute validation before enrollment-aware authentication.

Run the `postgres-auth` lane and Google/OIDC transport files for these changes.
Fixture provider responses prove controller behavior, not live membership or chat.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-09: Created the delivery plan after refreshing the source baseline.
