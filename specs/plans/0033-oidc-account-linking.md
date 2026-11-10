---
rfc: ../rfcs/0033-oidc-account-linking.md
---

# Implementation plan: OIDC account linking

- **ID:** RFC-0033
- **Delivery status:** Planned
- **Owner:** kevinlin-openai
- **Authority:** [RFC-0033](../rfcs/0033-oidc-account-linking.md)
- **Source baseline:** `af35ce905`

## Outcome and scope

Implement the explicit linking flow and AC-1 through AC-6. The user authorized
implementation and live GitHub-backed OIDC verification on 2026-11-10. Keep the
existing account, Principal, ownership and grants. Publish real video evidence
on the implementation PR, with the tested revision and verification limits.

## Implementation

1. Submit the RFC for review before changing authentication contracts. Add
   configuration parity across environment, Helm and installation profiles.
2. Extend PostgreSQL human authentication with browser-bound linking records,
   one-use ownership/candidate proofs, atomic attachment, session invalidation
   and audit. Reuse the existing account and method invariants.
3. Extend the guarded human-login routes and OIDC verifier with explicit linking
   purposes and signed authentication freshness checks. Keep enrollment outside
   the linking flow. Add Console entry, reauthentication, confirmation and recovery.
4. Extend controller/PostgreSQL coverage for proof isolation, conflicting owners,
   concurrency, revocation and uncertain commits. Extend the real installed
   OIDC Agent workflow for linking, subsequent sign-in, chat and denied access.
5. Update authentication references, operator guidance, flow docs, API/database
   cheat sheets, Storybook and test registration. Run proportional validation and
   independent review before publishing the final implementation.

## Verification

| Required outcome  | Real check and prerequisites                                                                                                               | Result       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| AC-1, AC-2, AC-3  | Controller and PostgreSQL with a signed-token IdP; installed Keycloak/OIDC Agent scenario                                                  | Not run      |
| AC-4, AC-5        | Two controllers sharing disposable PostgreSQL, existing fault harness                                                                      | Not run      |
| AC-6              | Rebuilt Storybook and supported Console controls                                                                                           | Not run      |
| GitHub acceptance | Existing authorized GitHub test app and account, qualified OIDC broker, manually created OCE account, deployed Agent and actual model chat | Not run      |
| Video evidence    | Record the live GitHub-backed linking/sign-in/chat workflow, upload native GitHub attachment, verify playback                              | Not recorded |

The prior PR's screen-capture failure is not proof for this implementation.
Check browser recording and upload capability before the live acceptance run.
Do not substitute synthetic identity claims or a simulated chat for GitHub proof.
If the existing broker cannot prove fresh authentication, qualify a supported
broker without weakening RFC-0033's proof requirements.

## Delivery record

Implementation and verification pending. Temporary credentials and media stay
outside the checkout. Preserve unrelated user edits in RFC-0032.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-10: Created the authorized implementation plan against `af35ce905`.
