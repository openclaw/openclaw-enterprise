---
rfc: ../rfcs/0032-oidc-account-enrollment.md
---

# Implementation plan: OIDC account enrollment

- **ID:** RFC-0032
- **Delivery status:** Planned
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
| Enrollment and initial access | Real callback, PostgreSQL, native IAM and Agent API integration | Not run |
| Configuration and retirement | Helm/profile checks, API generation and retired-input rejection | Not run |
| Generic OIDC chat | Explicitly attached default user, browser sign-in and real model reply | Not run |
| GitHub through OIDC chat | Real broker sign-in, qualified membership claim, same account and model reply | Not run |
| Quality and documentation | Typecheck, lint, formatting, workspace, docs and independent review | Not run |

## Delivery record

Implementation and acceptance verification are pending. Missing live prerequisites
must remain explicit gaps; fixture results do not establish live acceptance.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-09: Created the delivery plan after refreshing the source baseline.
