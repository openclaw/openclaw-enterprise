---
rfc: ../rfcs/0032-oidc-account-enrollment.md
---

# Implementation plan: OIDC account enrollment

- **ID:** RFC-0032
- **Delivery status:** In progress
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

| Required outcome | Proof | Status |
| --- | --- | --- |
| Enrollment and initial access | Real callback, PostgreSQL, native IAM and Agent API integration | 14 focused checks pass; full authentication lane passed 172 checks before this expansion |
| Configuration and retirement | Helm/profile checks, API generation and retired-input rejection | Profile and transport checks pass; 20 chart checks pass; final packaging check pending |
| Generic OIDC chat | Explicitly attached default user, browser sign-in and real model reply | Login and Agent creation pass; model reply timed out; diagnosis in progress |
| GitHub through OIDC chat | Real broker sign-in, qualified membership claim, same account and model reply | Test app created; live validation in progress |
| Quality and documentation | Typecheck, lint, formatting, workspace, docs and independent review | Static checks pass; independent review incomplete and must be repeated |

## Delivery record

Implementation is in progress. Live acceptance and independent review remain pending. Missing live prerequisites
must remain explicit gaps; fixture results do not establish live acceptance.

## Test retention audit

The direct GitHub browser consumer is removed. Repository credential consumers
remain unchanged. Reviewed history includes the original team-enrollment change
`bfc205fd1`, shared result handling `b6a07b787`, and OIDC chat `5cf15141c`.

| Previous test | Disposition and remaining proof |
| --- | --- |
| `github-login-transport.test.mjs`: transport and allowlist cases | Delete retired GitHub HTTP/allowlist behavior. Google/OIDC transport cases retain deadlines, bounded bodies, token validation and shared admission. Move “guarded adapter never lists, counts or mutates raw session rows” unchanged to Google coverage. |
| `postgres-github-org-allowlist.test.mjs`: org/team denial | Delete direct membership lookup coverage; signed-claim admission now belongs to `postgres-oidc-enrollment.test.ts`. Live broker qualification separately checks its GitHub membership source. |
| `postgres-github-team-enrollment.test.ts`: account/Group creation | Replace with OIDC enrollment coverage for exact identity, verified profile, conflict, scoped initial grants, Groups, concurrency, rollback and stale attempts. |
| `postgres-github-sign-in.test.mjs`: existing-account Console sign-in | Existing OIDC and Google suites retain callback, session, account, transport and recovery behavior. The real OIDC Agent journey covers browser adoption and chat. |
| `postgres-github-tab-binding.test.mjs` | Remove the duplicate shared tab-binding invocation; retain `postgres-oidc-tab-binding.test.mjs`. |
| GitHub-named account scope, attach, cookie commit, outage and recovery tests | Preserve the scenarios through OIDC; keep shared cookie behavior in `postgres-human-session-cookie.test.mjs`. |

Run the `postgres-auth` lane and Google/OIDC transport files for these changes.
Fixture provider responses prove controller behavior, not live membership or chat.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-09: Created the delivery plan after refreshing the source baseline.
