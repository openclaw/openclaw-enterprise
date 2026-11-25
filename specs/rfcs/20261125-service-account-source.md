---
status: Proposed
implementation_status: Implemented
author: stevenlee-oai
---

# Proposal: Simplify ServiceAccount credentials

- **ID:** RFC-20261125-service-account-source
- **Created:** 2026-11-25

## Summary

A ServiceAccount represents an identity managed by an upstream issuer. Its issued PAT is an ordinary static Credential Source owned by TokenService. Store the association as `credentialSourceId` and remove the unused Secret-backed credential alternatives.

## Proposal

Keep account creation, PAT issuance and issuer revocation separate. The selected ServiceAccount Driver enrolls a fresh PAT in TokenService and returns its Source ID. OCC verifies the exact ready Source, grants the creator access, and saves the ID on the account. The Agent selects that Source through normal Harness authentication. Existing authorization, compensation, external revocation and independent Source retirement remain in place.

## Interface changes

### APIs

Return optional `credentialSourceId` on ServiceAccount responses. Remove `PATCH /namespaces/:namespaceId/service-accounts/:serviceAccountId/credential`, which manually attaches an API-key or OAuth Secret reference that Agent authentication does not consume. Keep the account creation, issuance, read and delete operations.

### IAM

No changes. Issuance requires exact account `update` and Namespace Source `create`; binding the Source requires its own `operate` grant.

### Database entities

Use the existing `service_accounts.credential_source_id` as the stored association instead of deriving it from a redundant credential JSON object. Preserve issued Source IDs, Namespace ownership, uniqueness and ready static PAT validation. Discard obsolete manual Secret associations without deleting the Secrets.

### Driver contracts

Change `ServiceAccountDriver.createCredential(account)` from returning `ServiceAccountCredential` to returning `Promise<string>` containing the exact enrolled Source ID. Remove the `ServiceAccountCredential` union and expose `ServiceAccount.credentialSourceId?: string`.

## Simplifications

Remove the duplicate credential kind, manual Secret association API, JSON representation and corresponding obsolete tests. Keep the distinction between managing an external identity and storing a credential.

## Acceptance Criteria

- Issuing a PAT through the real account API returns an authorized static Source ID without exposing the bearer; the Agent can bind that Source.
- Issuance denies callers missing either required grant before issuer effects, and existing issuer compensation and revocation still work.
- The removed manual association endpoint is unavailable. Upgrading preserves issued Source associations and unrelated Namespace Secrets.

## Implementation

The [ServiceAccount reference](../../docs/reference/service-accounts.md) describes the supported account and Source lifecycle.
