---
rfc: ../rfcs/0033-oidc-account-linking.md
---

# Implementation plan: OIDC account linking

- **ID:** RFC-0033
- **Delivery status:** In progress
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

Implementation: [PR #5201](https://github.com/openclaw/openclaw-enterprise/pull/5201).
The live installation uses controller commit `e13c2cc56` and the approved
OpenClaw runtime at `513c12703`, with a real `gpt-6.1-sol` model. Later commit
`cf93d56b2` corrects response-schema documentation and stores the existing
recovery-only policy as a boolean in the policy digest. These changes do not
change the recorded Console screens. The later merge of `main` at `49e3f601c`
preserves the linking entry and adds its password-discovery behavior. All 85
selected Console browser checks passed after that merge; rebuilt linking
screens and the confirmation interaction were inspected again.

| Required outcome                     | Evidence and result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing password owner              | Real Console, Keycloak, PostgreSQL, deployed Agent, streaming model reply, Stop/reconnect and denied administrative/sibling access passed. Both account-creation settings passed in separately prepared databases.                                                                                                                                                                                                                                                                                                                             |
| Existing external owner              | A real Keycloak identity proved ownership; a different subject completed a separate fresh challenge. Confirmation and ordinary sign-in through both subjects passed, including reuse of the IdP session.                                                                                                                                                                                                                                                                                                                                       |
| GitHub acceptance                    | `kevinlin-openai` authenticated through the test GitHub OAuth app and Keycloak broker. The manually created default-user OCE account linked, signed in normally, received a real Agent/model reply and was denied `GET /installation`.                                                                                                                                                                                                                                                                                                         |
| Persisted identity and access        | The GitHub run added exactly one method and advanced the original account version once. User records, Principal, access bindings and Group memberships were unchanged. The audit records the account owner and `source: self-service`.                                                                                                                                                                                                                                                                                                         |
| Freshness, conflicts and concurrency | All 12 controller/PostgreSQL checks passed. They cover stale/missing/future authentication time, competing accounts, replay, proof expiry during a row-lock wait, policy changes, both orderings of disable/revoke/detach versus confirmation, and a disabled owner's identity remaining unavailable for transfer.                                                                                                                                                                                                                             |
| Atomicity and recovery               | A real audit constraint failure rolled back attachment. Dropping the actual COMMIT acknowledgement returned an uncertain result with one durable attachment; a fresh restart was a no-op. Existing Console sessions were invalidated. Old browser credentials returned Console `401` and native Agent `403`, with no redirects.                                                                                                                                                                                                                |
| Existing behavior                    | 57 authentication/enrollment/tab-binding/admin-attachment checks and 49 token/transport/configuration checks passed. The added linking configuration parity check passed.                                                                                                                                                                                                                                                                                                                                                                      |
| Database                             | All 207 PostgreSQL migration compatibility checks passed, including logical restores, repeated migrations and rollback.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Console                              | Seven rebuilt `Pages/Sign in/OIDCLink*` stories were inspected. Native screenshots and a video are [attached to the PR](https://github.com/openclaw/openclaw-enterprise/pull/5201#issuecomment-6762770192), explicitly labeled as simulated UI proof. The second live recording includes the GitHub selection, blank broker password prompt, new attachment, ordinary sign-in and another real reply. [Live videos and screenshots](https://github.com/openclaw/openclaw-enterprise/pull/5201#issuecomment-6763389590) are attached to the PR. |

The GitHub test uses a required post-broker password challenge in Keycloak.
This proves fresh broker authentication even when GitHub reuses its browser
session. It does not claim that GitHub itself requested a new password. The
application still verifies the signed `auth_time` and token issue time.

The enabled-creation run initially timed out while rendering prior chat history
after reconnect. A rerun with failure screenshots enabled passed the complete
streaming, Stop, persisted-history and follow-up-reply checks. No application
logic or assertions changed for the rerun. This remains a recorded intermittent
runtime/UI observation, not evidence of a fixed reconnect defect.

The installed external-owner test lets the IdP's one-second authentication
timestamp advance before each repeated challenge. It observes a fresh password
prompt for each proof; signed-token tests independently reject stale or missing
authentication time.

## Delivery record

Runtime implementation, configuration, current reference, operator guidance,
source-backed flow, generated API documentation and CI registration are present.
The owning contract is [OIDC account linking](../../docs/reference/authentication/account-linking.md).
Lint, typecheck, formatting, workspace isolation, documentation links/length and
generated OpenAPI checks passed including the final test-isolation changes.

Independent review remains pending. Automatic approval review rejected sending
private source to the configured review service; the explicit approval request
is unanswered. This is not a claim of review completion or release readiness.
The PR remains a draft pending that review. The live fixture, disposable
databases and k3d cluster were removed; the original Dex forwarder was restored
and its discovery endpoint was verified.

The OIDC guide and external-sign-in reference remain coherent single workflows
within the 2,500-word limit; their sections above 1,500 words keep prerequisites,
configuration, limits and recovery together. Temporary credentials and media
stay outside the checkout. The unrelated RFC-0032 user edits are preserved.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-10: Created the authorized implementation plan against `af35ce905`.
