# Enable Google sign-in

Google sign-in is an optional second identity provider next to
[GitHub sign-in](production-installation.md#enable-github-browser-sign-in). Email and
password stay the default. An Installation administrator attaches a person's Google
identity to an existing OpenClaw Enterprise (OCE) account; that person can then sign in
with Google or with the account password. Google sign-in creates no account, performs
no signup, and never matches accounts by email address.

Google uses the same guarded
[single-controller profile](../../reference/authentication/external-sign-in.md#github-sign-in-for-existing-accounts)
as GitHub: the exact `Origin` checks, PKCE (`S256`), one-use state, the host-only
`__Host-` browser-binding cookie, the keyed admission limiter, the eight-hour session
rules, and the `attemptId`, login receipt, and one-use result exchange. Password
fallback, account disablement, detach, and the recovery account work unchanged. You can
enable Google alone or together with GitHub.

## Requirements

- Everything the [GitHub profile](../../reference/authentication/external-sign-in.md#github-sign-in-for-existing-accounts)
  requires: one serving controller, PostgreSQL State, native IAM, one canonical HTTPS
  Console origin, and `agentNativeAdmin.enabled: false`.
- A controller image that includes Google sign-in: a
  [published image](production-installation.md#use-published-images) from a revision that
  has it, or [your own build](production-installation.md#build-and-publish-production-images).
- A Google Cloud project where you can create an OAuth client.
- API Pod HTTPS egress to `oauth2.googleapis.com` (code exchange) and
  `www.googleapis.com` (signing keys). Browsers, not the API, reach
  `accounts.google.com`.

## Create the Google OAuth client

1. In the Google Cloud console, configure the OAuth consent screen. For a Google
   Workspace organization, choose **Internal** so only your organization's accounts can
   consent. The controller requests only the `openid` and `email` scopes.
2. Under **APIs & Services > Credentials**, create an **OAuth client ID** of type
   **Web application**.
3. Add exactly one authorized redirect URI: `OCC_AUTH_BASE_URL` followed by
   `/api/auth/providers/google/callback`, for example
   `https://occ.example.com/api/auth/providers/google/callback`. The controller builds
   this URI from `OCC_AUTH_BASE_URL`; any difference makes Google reject the request.
   No JavaScript origin is needed.
4. Save the client ID and client secret to protected files.

The controller uses Google's documented
[OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
endpoints as fixed values. It does not fetch the discovery document at runtime.

## Configure the chart

Create a dedicated Secret. It must differ from every other Secret the chart reads,
including `auth.github.secretName`:

```bash
kubectl -n openclaw-system create secret generic occ-google-login \
  --from-file=client-id=/secure/occ/google-client-id \
  --from-file=client-secret=/secure/occ/google-client-secret
```

Then set these protected values:

```yaml
auth:
  recoveryUserId: "<recovery administrator user ID>"
  google:
    enabled: true
    secretName: occ-google-login
    clientIdKey: client-id
    clientSecretKey: client-secret
    allowedDomains: [] # optional, for example ["example.com"]
    egressCidrs: [] # optional IPv4 CIDRs
agentNativeAdmin:
  enabled: false
```

`auth.recoveryUserId` is required whenever GitHub or Google is enabled, including a
Google-only install. It names an existing local password administrator; read it as that
administrator from `data.user.id` of `GET /api/auth/session`. The chart passes it as
`OCC_AUTH_GITHUB_RECOVERY_USER_ID`, which designates the recovery account for either
provider. Rendering fails on incomplete Google values, a shared Secret, an HTTP base URL,
native administration, an invalid CIDR, or an allowed domain that is not a DNS name. It
also fails when `allowedDomains` is set without `auth.google.enabled`.

The chart adds the API-only NetworkPolicy
`openclaw-enterprise-api-google-login-egress` on TCP 443. Empty
`auth.google.egressCidrs` allows any address except link-local `169.254.0.0/16`. Google
publishes no small, stable address range for these hosts, so narrow egress with an egress
proxy rather than static CIDRs.

The API reads these variables; see
[production settings](../../reference/settings/production.md#google-sign-in):

| Variable                           | Source                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| `OCC_AUTH_GOOGLE_CLIENT_ID`        | `auth.google` Secret key `clientIdKey`                    |
| `OCC_AUTH_GOOGLE_CLIENT_SECRET`    | `auth.google` Secret key `clientSecretKey`                |
| `OCC_AUTH_GOOGLE_ALLOWED_DOMAINS`  | `auth.google.allowedDomains`, comma-joined when non-empty |
| `OCC_AUTH_GITHUB_RECOVERY_USER_ID` | `auth.recoveryUserId`                                     |

## Restrict hosted domains

With `allowedDomains` empty, any Google account whose identity an administrator attached
can sign in. With one or more domains set, the ID token must also carry a hosted-domain
(`hd`) claim equal to one of them and `email_verified: true`. Personal Google accounts
carry no `hd` claim and are refused. The controller compares domains in lowercase. The
email address itself is never used for identity or authorization.

## Enable it

Enable Google during the same stopped maintenance as the
[GitHub procedure](production-installation.md#enable-github-browser-sign-in): verify
password recovery, create the Secret, set the values above, close ingress, stop
identity writers, run `helm upgrade`, and verify through restricted access before
reopening ingress. If the guarded profile is already active through GitHub, adding
Google needs no new activation, but still use one serving controller and stopped
writers for the upgrade.

`GET /api/auth/providers` then returns `google: true`, and the Console shows
**Continue with Google**. Once every ordinary account has an identity,
[recovery-only password sign-in](../../reference/authentication/external-sign-in.md#recovery-only-password-sign-in)
leaves passwords to the recovery account. Activation is one-way: keep at least one provider configured,
or startup refuses. To return to password-only sign-in, follow
[sign-in maintenance](auth-maintenance.md#deactivate-external-sign-in), then set
`auth.google.enabled: false` as well; without Helm also remove the
`OCC_AUTH_GOOGLE_*` variables.

## Find a person's Google subject

OCE identifies a Google account only by the ID token's `sub` claim, a stable account
identifier. Email addresses can change owners and are never identity keys.

- **Google Workspace:** the user's `id` from the Admin SDK
  [Directory API](https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/get)
  equals the OpenID Connect `sub`. An administrator can read it with
  `GET https://admin.googleapis.com/admin/directory/v1/users/<email>` and the
  `id` field of the response.
- **Consumer Google accounts:** there is no administrator lookup. The person must supply
  their `sub`, for example from an ID token they obtain themselves. Verify that the
  person controls that account through your own identity process.

## Attach and detach

As a human Installation administrator, [sign in as a human administrator](../../reference/authentication/service-api-keys.md#sign-in-as-a-human-administrator)
so `OCC_URL`, `OCC_ORIGIN` and `OCC_SESSION_COOKIE_JAR` are set, and set `USER_ID` to the
account's `id`. Read the account's current version, then attach the subject:

```bash
VERSION="$(curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" -H "Origin: $OCC_ORIGIN" \
  "$OCC_URL/api/auth/accounts/$USER_ID" | jq -er .data.version)" &&
jq -n --arg subject '<google sub>' --argjson version "$VERSION" \
  '{subject: $subject, expectedVersion: $version}' |
  curl --fail-with-body --silent --show-error \
    --cookie "$OCC_SESSION_COOKIE_JAR" -H "Origin: $OCC_ORIGIN" \
    -H 'Content-Type: application/json' --data-binary @- \
    "$OCC_URL/api/auth/accounts/$USER_ID/providers/google"
```

The subject is 1–255 printable ASCII characters without spaces. The call returns `409`
when Google is not configured, the version is stale, the account is disabled, or another
account holds the subject ("The external identity is already assigned."). Attachment
advances the account version and ends the account's existing sessions. The account read then lists a method whose `providerId` starts with
`google:`. Detach it with
`POST /api/auth/accounts/:userId/methods/:methodId/detach`, as for GitHub. Detaching ends
every session of the account, password sessions included; the password keeps working for
new sign-ins.

## Rotation and outages

The provider instance is derived from the client ID. A new client ID is a new provider
instance: reattach every Google identity, then detach the old methods by `methodId`.
Sessions signed in under the old client ID, or with Google once it is removed, end on
their next request.
Rotating only the client secret keeps attachments and invalidates pending sign-in
attempts. Rotating `OCC_AUTH_SECRET` also fails attempts in flight.

A Google outage, blocked egress, or rejected ID token fails that sign-in closed and
returns the browser to `/console/?authError=google`; password sign-in is unaffected.
Google start and callback share GitHub's admission budget, so enabling both does not
raise the external sign-in limits.

## Related

- [Authentication reference](../../reference/authentication.md)
- [Production installation](production-installation.md)
- [Sign-in maintenance](auth-maintenance.md)
- [Production settings](../../reference/settings/production.md#google-sign-in)
