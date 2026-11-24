# Operate OIDC sign-in

These procedures keep a running [OIDC sign-in](oidc-sign-in.md) working: rotating the
client secret and signing keys, reading an IdP outage, offboarding a person, and
checking the audit record. Commands assume the chart's `openclaw-system` namespace and
the `occ-oidc-login` Secret from [Configure the chart](oidc-sign-in.md#configure-the-chart).

## Rotate the client secret

The API reads the client secret from the Secret only at startup, and OCE stores
nothing derived from it, so a secret-only change needs one API restart. It needs no
writer stop, no worker restart and no ingress closure. Attachments remain, because the
provider instance comes from the issuer and client ID. Sign-ins started before the
restart are invalidated and must be started again; existing sessions survive.

1. Create the new secret in the IdP. If the IdP can keep the previous secret valid for a
   grace period, as Keycloak's client-secret rotation policy can, sign-in keeps working
   until step 3. Otherwise the IdP refuses the running API from this moment: every OIDC
   sign-in fails as `PROVIDER_UNAVAILABLE` with `cause: client_rejected` until the API
   restarts, so do steps 2 and 3 at once.
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

For a planned rotation, publish the new public key under a distinct `kid` in
the IdP's JSON Web Key Set (JWKS) before switching signers. Verify a fresh
sign-in. Keep the old public key published until callbacks using it finish.
The API fetches the JWKS after token exchange. No API restart is needed, and
existing OCE sessions survive rotation.

## Read an outage

- **The browser cannot reach the IdP.** Check the IdP and the browser's
  connection. If no callback reaches OCE, there is no callback failure for
  OCE to log or audit.
- **The API cannot complete token exchange or fetch the JWKS.** Both requests
  share a 10-second deadline. For provider unavailability, the API returns the
  browser to `/console/?authError=oidc&authReason=provider-unavailable`.
  The Console suggests trying later or using **Recovery sign-in** in
  `recovery-only` mode. Check the `PROVIDER_UNAVAILABLE` audit reason and
  the `step` and `cause` in the
  [`authentication.provider-unavailable-warning` log](../../reference/authentication/external-sign-in.md#external-sign-in-profile).

For `timeout` or `connect_refused`, check API egress, DNS, TLS and IdP health.
With valid settings, restored connectivity needs no API restart. For
`client_rejected`, check the client ID, secret, authentication method and
authorization-code grant. If only the secret changed,
[update the Secret and restart the API](#rotate-the-client-secret).

Existing sessions remain valid during an IdP outage. The recovery account
can sign in with its password. Under `passwordSignIn: all`, other enabled,
enrolled users can also use a known password. OIDC enrollment provides none.

For `EXTERNAL_IDENTITY_REJECTED`, the Console can suggest attaching an identity
at `/console/?authError=oidc`. Token verification can fail the same way.
Check ID token verification, including signature, issuer, audience, expiry
and nonce. Confirm the provider instance before changing attachments.
A disabled account returns `authReason=account-disabled`. A callback failure
in OCE's database or audit store returns `authReason=unavailable`.

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

Use approved database access to read sign-in records in `occ.audit_events`.
To find a specific attempt, see [Investigate an external sign-in](../topics/audit-log.md#investigate-an-external-sign-in).

Sign-in rows have the action `authentication.login` and an `outcome` of `success`
or `denied`. For external sign-ins, `details.provider` identifies the provider.
A denial records its reason in `details.__occAuditMetadata.reasonCode`.

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
