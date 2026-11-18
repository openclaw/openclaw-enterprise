---
rfc: ./index.md
---

# Collect a browser sign-in result through any compatible API instance

**Proposed.** A tab that completes a GitHub, Google or OIDC callback should be able to collect its session key once from any compatible API instance in the same installation, including after the issuing instance stops. PostgreSQL Human Authentication State would own the outstanding result. This proposal covers result exchange only. Deployment topology and request admission remain separate decisions.

## Issue and collect

At callback, State records the outstanding result in the same transaction as the session, method binding and login audit. The installation and original tab attempt uniquely identify the result. It belongs to the exact session record and configured provider instance. State sets a deadline at most 120 seconds ahead on the database clock. The API uses that deadline in the signed, versioned receipt and sends the cookies after commit. The result row holds only identifiers and the deadline. The OAuth attempt and its PKCE material have a separate lifetime ending before provider exchange.

To collect, the tab presents the original attempt, signed receipt and signed session cookie to the provider’s result route with the exact configured Origin. State serializes consumption with competing requests and revocation. After any lock wait it checks the database deadline, receipt bindings, current session lifetime, enabled account, Principal, account and method versions, and configured provider instance. A mismatched request leaves the result available to the original tab.

State atomically deletes one matching outstanding row. Only after confirmed commit does the API clear the receipt cookie and return the original session’s narrowing key. The original session and its expiry stay intact. An uncertain commit produces a generic service-unavailable response without a key. If the response is lost after commit, collection stays final and the user can sign in again. Session deletion removes associated results. During issuance, State prunes expired rows in bounded batches through an expiry index sized to keep pace with issuance.

## Compatibility and delivery

Ship the additive table, migration catalog and application-role grants before activating the new receipt format. Qualify the preparatory image on retained data as a return target for an activation release using the same catalog. Preserve the migration and acknowledged writes on return. Each supported image pair must pass the [upgrade](../../../docs/guides/deploy/production-upgrade.md) and [recovery](../../../docs/guides/deploy/production-upgrade-recovery.md) procedures. A return image must recognize the retained migration catalog.

Compatible instances share the database, signing configuration and provider bindings. On replacement, an outstanding result retains only its remaining lifetime and a collected result stays spent. Across an incompatible transition, stop the outgoing writers and keep incompatible readers from serving together. Each reader refuses receipts outside its supported format. A tab with an incompatible receipt starts a new sign-in, including after rollback.

## Acceptance criteria

Use independent API processes, synthetic providers and one disposable PostgreSQL database with the application role. Complete a callback on one instance and collect from another after the issuer stops. Verify that concurrent requests produce exactly one key and that subsequent collection on a replacement fails. Check the clearing cookie, key binding and original session expiry.

Hold a revocation transaction open, start redemption in a second process, then commit revocation. The waiting request must be denied. If redemption commits first, later revocation still ends the session. Cover expiry during a lock wait, disabled accounts, invalidated methods, changed provider configuration, mismatched request bindings, uncertain commit and lost response. Rehearse the supported release and return pairs with retained data and verify fresh sign-in on each side.

Parent decision: [RFC-0007](./index.md).
