# Operate OIDC sign-in

These procedures keep a running [OIDC sign-in](oidc-sign-in.md) working: rotating the
client secret and signing keys, reading an IdP outage, offboarding a person, and
checking the audit record. Commands use the chart's `openclaw-system` namespace and
the default Secret `occ-oidc-login`. For a named provider, use its Secret name and
keys from [Configure the chart](oidc-sign-in.md#configure-the-chart).

## Rotate the client secret

The API reads the client secret at startup. Replace the Secret and restart the
API. The worker keeps running. The issuer and client ID identify the provider,
so attachments and existing sessions survive. Start any pending sign-in again
after the restart.

1. Create the new secret in the IdP. If the IdP can keep the previous secret valid for a
   grace period, as Keycloak's client-secret rotation policy can, sign-in keeps working
   until step 3. If the IdP refuses the old secret, sign-in through this provider
   fails as `PROVIDER_UNAVAILABLE` with `cause: client_rejected` until the API
   restarts. In this case, do steps 2 and 3 together.
2. Save the new secret to the protected file and replace the Secret in place. The plain
   `kubectl create secret` command fails once the Secret exists:

   ```bash
   kubectl -n openclaw-system create secret generic occ-oidc-login \
     --from-file=client-id=/secure/occ/oidc-client-id \
     --from-file=client-secret=/secure/occ/oidc-client-secret \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

   `kubectl apply` may warn that the Secret lacks its last-applied annotation; it
   patches the Secret anyway.

3. Restart the API and wait for it:

   ```bash
   kubectl -n openclaw-system rollout restart deployment/openclaw-enterprise-api
   kubectl -n openclaw-system rollout status deployment/openclaw-enterprise-api --timeout=5m
   ```

   The API Deployment uses `Recreate`, so it answers `503` while the old Pod stops and
   the new one starts. The worker keeps running.

4. Sign in through the IdP in a browser at the Console, and check the recovery
   administrator's password sign-in. Then retire the old secret in the IdP if it kept one.

On the production qualification install, sign-in was unavailable for about 14 seconds
end to end, about 7 of them as API `503`s.

Changing the issuer or client ID creates a new provider instance; see
[Changes, rotation and outages](oidc-sign-in.md#changes-rotation-and-outages).

## Rotate the IdP signing key

The API reads the JWKS on every callback, without a cache, so a signing-key rotation
needs no OCE change or restart. Add the new key in the IdP and make it active, then
disable the old one. Existing OCE sessions are unaffected: they do not depend on ID
tokens after sign-in.

## Read an outage

An IdP outage looks different depending on when the IdP fails:

- **The IdP is down before the person reaches it.** This is the common case. The
  browser shows its own connection error at the IdP's host name. OCE receives no
  request, so the Console shows no message and OCE writes no audit row or log line.
  Check the IdP itself.
- **The IdP fails after the person signed in there**, at the token or JWKS step, or the
  API cannot reach it (blocked egress, DNS, TLS), or it refuses the configured client.
  The API waits at most 10 seconds, then returns the browser to
  `/console/?authError=oidc/keycloak&authReason=provider-unavailable` for a
  provider named `keycloak`. The legacy route uses `authError=oidc`. The Console says that
  sign-in with the IdP is unavailable right now and to try again later; where password
  sign-in is `recovery-only`, it tells administrators to use **Recovery sign-in**. The
  audit row has reason `PROVIDER_UNAVAILABLE`, and the API logs
  `authentication.provider-unavailable-warning` at WARN with the failing `step` and
  `cause`, such as `timeout`, `connect_refused` or `client_rejected`; see the
  [external sign-in reference](../../reference/authentication/external-sign-in.md#external-sign-in-profile).

During an outage, existing sessions keep working. Users can sign in through
another configured provider on their account. The recovery administrator can
sign in with a password, as can every password account under `passwordSignIn: all`.
When the IdP answers again, users can retry sign-in.

Other refusals look different. An identity that is not attached, or an ID token that
fails verification, returns the provider's `authError`; the Console suggests asking an
administrator to attach the identity, and the audit reason is
`EXTERNAL_IDENTITY_REJECTED`. A disabled account returns `authReason=account-disabled`.
If OCE's own database or audit store fails during the callback, the browser returns
with `authReason=unavailable`.

## Offboard a person

OCE does not learn when the IdP disables someone. Disabling the user in the IdP stops
new sign-ins at the IdP, before OCE sees them, so OCE writes no audit row. The person's
OCE sessions continue until they expire (at most 8 hours, and a person may hold
several), and their service keys work until revoked.

To end access, follow [Remove a person](../topics/iam.md#remove-a-person): disable the
OCE account, which ends every session at once, then find and revoke the person's service
keys. Disable the user in the IdP as well. Sign-out in OCE is local: while the IdP
session lives, one click signs the person in again.

## Check the audit record

OCE has no API or Console view for audit events. Read `occ.audit_events` through your
approved database access; see the [audit log](../topics/audit-log.md). Sign-in rows have
the action `authentication.login`, an `outcome` of `success` or `denied`, the provider
in `details.provider` (denials only) and the reason code in
`details.__occAuditMetadata.reasonCode`:

```sql
SELECT occurred_at, outcome,
       details -> '__occAuditMetadata' ->> 'reasonCode' AS reason_code,
       details ->> 'provider' AS provider
FROM occ.audit_events
WHERE action = 'authentication.login'
  AND occurred_at > now() - interval '1 hour'
ORDER BY occurred_at;
```

Account changes have their own actions, such as `authentication.method.attach` and
`authentication.account.disable`.

## Related

- [Enable OIDC sign-in](oidc-sign-in.md)
- [Keycloak for OIDC sign-in](oidc-keycloak.md)
- [Sign-in maintenance](auth-maintenance.md)
- [External sign-in reference](../../reference/authentication/external-sign-in.md)
