---
status: Proposed
implementation_status: Implemented
author: freeqaz
---

# RFC: GitHub organization and team allowlist for sign-in

- **ID:** RFC-0019
- **Owner:** freeqaz (design); authentication maintainers for the sign-in callback.
- **Created:** 2026-10-04
- **Last updated:** 2026-10-13
- **RFC PR:** [#1229](https://github.com/openclaw/openclaw-enterprise/pull/1229)
- **Implementation:** [#1231](https://github.com/openclaw/openclaw-enterprise/pull/1231), merged
  2026-10-04. This RFC records the landed behaviour for review; see Delivery.
- **Related:** [RFC-0007 GitHub sign-in](0007-human-federated-sign-in/index.md);
  [external sign-in reference](../../docs/reference/authentication/external-sign-in.md#organization-and-team-allowlist);
  [production settings](../../docs/reference/settings/production.md#github-sign-in-and-trusted-proxies);
  Google's hosted-domain allowlist (`OCC_AUTH_GOOGLE_ALLOWED_DOMAINS`), the nearest precedent.

<a id="problem-and-decision"></a>

## Summary

An operator can optionally list GitHub organizations, and `org/team` slugs, whose members may
use GitHub sign-in. With a list set, the sign-in callback asks GitHub, with the user access
token it already receives, whether the person is an active member of a listed organization or
team. Someone who is not is refused before OCE looks up their account. The refusal is audited
as `MEMBERSHIP_REQUIRED` and the Console tells them why. If GitHub cannot answer the
membership question, sign-in fails closed as `MEMBERSHIP_UNAVAILABLE`, with its own audit
code, operator log line and Console message. The list is off by default. Membership is checked
only at sign-in; live sessions are not rechecked, which stays an open question below.

## Motivation

Without an allowlist, GitHub sign-in admits any GitHub user ID an administrator attached to an
OCE account, whatever that person's organization or team membership. The callback exchanges the code, calls only
[`GET /user`](https://docs.github.com/en/rest/users/users#get-the-authenticated-user), keys
the person by numeric user ID, and discards the token
([`exchangeGithubSubject`](../../apps/controller/src/auth/github.ts)). Sessions last a fixed
8 hours with no refresh.

GitHub suspending or deleting the account does block a fresh sign-in: the token exchange or
`GET /user` then fails, and the callback refuses before any session is issued. Two gaps
remain. Removing someone from the company's GitHub organization or team changes nothing for
their next sign-in, and live OCE sessions keep working until they expire. Offboarding is an
OCE action (disable the account, or detach its GitHub method), as documented for OIDC
([oidc-sign-in.md](../../docs/guides/deploy/oidc-sign-in.md)) and, since #1225, for GitHub.
Operators who already manage access through GitHub organizations and teams want GitHub to be
the gate too, so that removing someone from the team stops their next sign-in without a second
step in OCE. The allowlist closes the first gap, not the second.

<a id="scope"></a>

## Goals

- **Off by default.** With no setting the callback behaves as it did before the allowlist: no
  extra GitHub request, no new audit code (`hasAllowlist` gates the step).
- **Org or team gate at sign-in.** With a list, only an active member of a listed
  organization, or of a listed team (GitHub counts child-team members), gets a session.
  Pending invitations do not count.
- **Least privilege.** No OAuth scope is requested. The check uses the user token GitHub
  already issues and a read-only organization permission.
- **Clear refusals.** A refused person sees why in the Console, and the operator sees a
  distinct audit reason code. A refusal reveals nothing about which OCE accounts exist.
- **Fail closed.** A membership lookup that GitHub cannot answer refuses sign-in and is
  distinguishable from both "not a member" and a token or profile outage.

## Non-goals

- Ending live sessions when membership changes (see
  [Unresolved questions](#mid-session-membership)).
- Creating accounts from membership (signup), or mapping teams to OCE roles.
- Google or OIDC group allowlists. Google already has hosted domains; OIDC groups are a
  separate decision.
- Exempting the recovery account. It signs in with its password, which the allowlist does not
  affect.

<a id="design"></a>

## Design

### GitHub App, not OAuth App

OCE's GitHub sign-in is documented (not enforced) as a GitHub App user-to-server flow; a
classic OAuth App without `read:org` would fail the lookups. The deployment guide registers the
repository integration's GitHub App callback, the controller requests no scopes
(`disableDefaultScope`), and the token GitHub returns is a user access token (`ghu_…`) whose
authority is the App's permissions intersected with the user's. That decides how membership
can be read:

| Option                                                                                                           | What it needs                                                                                   | What else it grants                                                                                                                                | Verdict                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GitHub App user token, `GET /user/memberships/orgs/{org}` and `GET /orgs/{org}/teams/{team}/memberships/{login}` | Organization permission **Members: read** on the App, App installed on each listed organization | The App's installation token can also list that organization's members and teams                                                                   | **Chosen**                                                                                                         |
| OAuth App with `read:org` scope                                                                                  | A new scope on every sign-in                                                                    | Read access to every organization, team and project membership of the user, in every organization; subject to each organization's OAuth App policy | Rejected: broad, and OCE uses a GitHub App                                                                         |
| OAuth App, no scope, `GET /orgs/{org}/public_members/{login}`                                                    | Nothing                                                                                         | Nothing                                                                                                                                            | Rejected: every member must make membership public; no team check                                                  |
| App installation token, `GET /orgs/{org}/members/{login}`                                                        | Members: read and the App private key in the controller                                         | Same as chosen, plus the controller holds the private key                                                                                          | Rejected for sign-in: the key stays with the repository credential service. Kept as an option for periodic recheck |
| List endpoints (`/user/orgs`, `/user/teams`)                                                                     | Members: read, plus paging                                                                      | Reads every membership instead of the listed ones                                                                                                  | Rejected: more data, more requests                                                                                 |

GitHub documents `GET /user/memberships/orgs/{org}` as user-token only with Members: read,
and the team-membership endpoint as Members: read for user and installation tokens
([permissions for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#organization-permissions-for-members)).
Members: read is read-only and covers membership lists, not code or settings. Adding it to an
existing App needs each organization owner to accept the new permission; until they do the
lookup returns 403, which fails closed (below). These permission semantics come from GitHub's
documentation; the tests use fakes.

An operator who wants a smaller blast radius can register a sign-in-only GitHub App with just
Members: read and no repository permissions, so the user token can do nothing else. That
changes the client ID, which is a new provider instance and needs every identity re-attached, so it is an operator choice, not part of this change.

### Configuration

| Variable                        | Helm value                                      | Meaning                                                      |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `OCC_AUTH_GITHUB_ALLOWED_ORGS`  | `auth.github.allowedOrgs` (list, comma-joined)  | GitHub organization logins whose active members may sign in. |
| `OCC_AUTH_GITHUB_ALLOWED_TEAMS` | `auth.github.allowedTeams` (list, comma-joined) | `org/team-slug` entries whose active members may sign in.    |

- Both unset or empty: off. Either set: the check runs, and a person needs to match **any**
  entry in either list.
- `githubLoginConfiguration` in `apps/controller/src/auth/github.ts` trims, lowercases and
  deduplicates entries. Organization logins are letters, digits and hyphens, starting with a
  letter or digit, up to 39 characters (looser than GitHub's current rule, so older names still
  fit); team slugs are lowercase letters, digits, `-` and `_`, up to 100 characters. At most 10
  entries in total, so the number of GitHub requests per sign-in stays bounded. The controller
  counts after deduplicating, the chart and renderer before.
- Anything else fails startup, as does either variable without the GitHub client ID, client
  secret and recovery user ID. The chart (`templates/_helpers.tpl`) applies the same rules at
  render time and also refuses either list without `auth.github.enabled`. The installation
  profile renderer (`scripts/render-installation-profile.mjs`, `controlPlane.github`) refuses
  invalid or non-lowercase entries at preflight.
- API process only, like the other GitHub sign-in settings.

### Check at sign-in

```mermaid
sequenceDiagram
  participant Browser
  participant API as API callback
  participant GitHub
  participant State
  Browser->>API: callback with code (attempt consumed)
  API->>GitHub: token exchange, GET /user (id, login)
  loop each listed organization, then each team
    API->>GitHub: GET /user/memberships/orgs/{org}
    opt team entry and the org membership is active
      API->>GitHub: GET /orgs/{org}/teams/{team}/memberships/{login}
    end
  end
  alt some entry is active
    API->>State: look up attached identity and account state
    API-->>Browser: /console/ (or the usual unattached or disabled refusal)
  else every entry answered "not a member"
    API->>State: audit MEMBERSHIP_REQUIRED
    API-->>Browser: /console/?authError=github&authReason=membership
  else no active entry and a lookup failed
    API->>State: audit MEMBERSHIP_UNAVAILABLE
    API-->>Browser: /console/?authError=github&authReason=membership-unavailable
  end
```

_Implemented flow (`githubMembership` in `github.ts`, `providerMembership` in
`provider-transport.ts`). Unconfigured, the loop is skipped._

- The check runs after `GET /user` and **before** the attached-identity lookup, so a refusal
  says nothing about whether an OCE account exists for that GitHub user. The person already
  knows their own memberships.
- Organization entry: `200` with `state: active` is a match. `404` (not affiliated) and
  `state: pending` are not. Any other `state` is a malformed answer, so a lookup failure.
- Team entry: the team's organization membership is read first (and reused when the same
  organization is also listed). Only an active organization member's team membership is read,
  so a non-member's answer from the team endpoint (which GitHub may give as 403 or 404) never
  has to be interpreted. `200` active is a match; `404` and pending are not.
- Entries are checked in order and the first match wins. A match admits even if an earlier
  lookup failed: the person proved one listed membership.
- The token exchange, profile and membership requests share the existing 10-second deadline
  and the 64 KiB response cap. Requests never follow redirects. The token is used only for
  these requests and then discarded. The login used in the team URL comes from the
  same `GET /user` answer, is validated (a malformed login fails the team lookup), and is
  URL-encoded. Once the deadline passes, no further entry is tried; the first failure seen (a
  timeout, or an earlier `503`) is what is audited.
- A match only clears this step: an unattached identity is still refused
  `EXTERNAL_IDENTITY_REJECTED` and a disabled account `ACCOUNT_DISABLED`. Since membership runs
  first, a disabled account that is also off the allowlist is audited `MEMBERSHIP_REQUIRED`.

### Refusal and audit

Following the reason-code precedent of #1164, the two outcomes have their own
`authentication.login` denial codes in `HumanAuthenticationDenial`
(`packages/occ/src/state/human-authentication.ts`). `MEMBERSHIP_DENIALS` in `github.ts` names them; `refuseMembership` audits
them, and `apps/controller/src/auth/index.ts` maps them to the Console reasons `membership`
and `membership-unavailable`:

| Reason code              | When                                        | `details`                                              | Console message                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMBERSHIP_REQUIRED`    | Every entry answered "not an active member" | `provider: github`, `subject` (numeric GitHub user ID) | "Your GitHub account is not a member of an organization or team allowed to sign in here. If you were invited, accept the invitation on GitHub and try again; otherwise ask an administrator for access." |
| `MEMBERSHIP_UNAVAILABLE` | No match, and at least one lookup failed    | `provider: github`, `subject`                          | "Could not check your GitHub organization membership. Try again later; if this keeps happening, ask an administrator."                                                                                   |

This was the first denial to record the numeric subject. It is safe here because GitHub has already
authenticated the person, and it lets an administrator answer "why can't this person sign in"
from the audit log. Junk callbacks never reach this step, but any GitHub user can create
such a row by starting a sign-in.

The Console (`githubMembershipFailures` in `apps/controller/src/console/console.mjs`) reads
`authReason` only from the fixed values above, and only for `authError=github`; anything else
falls back to the generic provider error. With password sign-in available, the first message
adds "or use your password" and the second becomes "Try again later or use your password."

### GitHub outage

A membership lookup "fails" on a transport error, the deadline, a redirect, any status other
than `200` or `404` (so `401`, `403`, `429` and `5xx`), an oversized body or a malformed
answer. Then:

- the denial is audited as `MEMBERSHIP_UNAVAILABLE` (not `MEMBERSHIP_REQUIRED`, not
  `PROVIDER_UNAVAILABLE`);
- the API logs the existing `authentication.provider-unavailable-warning` at WARN with
  `step: membership` and the bounded `cause`, `status` or transport `code`, never URLs,
  logins, organization names or tokens;
- no session is issued; password sign-in is unaffected.

A `403` here usually means configuration: the organization blocked the App, its owner has not accepted Members: read, or SAML SSO enforcement wants a session the user
lacks. GitHub may instead answer `404` for an organization without the App installed or a
misspelled slug, which refuses every member as `MEMBERSHIP_REQUIRED` with no warning log; the
external sign-in reference gives the check for both. An outage in the earlier token or profile
step stays `PROVIDER_UNAVAILABLE`.

## Residual risk

- **Live sessions outlast membership.** Membership is read only at sign-in. Turning the list
  on applies from the next sign-in after the API restarts; sessions issued before that, and
  sessions of someone removed later, run until they expire (at most 8 hours). Revoke, disable
  or detach in OCE to end them at once.
- **Silent misconfiguration.** A `404` misconfiguration refuses everyone silently (above).
- **Broader App permission.** Members: read also lets the App's installation token list each
  listed organization's members and teams.
- **No live GitHub qualification.** All evidence uses loopback fakes of GitHub; see open
  question 2.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

- **Document only.** Done in #1225; GitHub still is not the gate.
- **OAuth App permissions** and the other lookups: see the table under
  [GitHub App, not OAuth App](#github-app-not-oauth-app).
- **Silent refusal as `EXTERNAL_IDENTITY_REJECTED`**, as Google's hosted-domain check does.
  Rejected: the operator could not tell a membership refusal from an unattached identity, and
  the person would get advice ("ask an administrator to attach your identity") that does not
  help.
- **Treat a lookup outage as "not a member".** Rejected: it would audit a GitHub incident as
  hundreds of membership refusals and give people the wrong advice.
- **Fail open on outage.** Rejected: the list is a security control.

## Unresolved questions

<a id="mid-session-membership"></a>

1. **Membership changes during a session.** Owner: freeqaz. Implemented default: no recheck.
   Someone removed from the organization or team keeps a live session for up to 8 hours, the
   attached identity still exists, and their next GitHub sign-in is refused. Options, none
   implemented:
   - **Shorter GitHub sessions** (a separate session lifetime when the allowlist is on, for
     example 1 hour). Cheap; costs more sign-ins; still a window.
   - **Periodic recheck.** Either keep the user's expiring token and refresh token (stores a
     credential the controller does not hold today), or ask the repository credential service
     to check `GET /orgs/{org}/members/{login}` with its installation token (no new secret in
     the controller, but a new cross-service call and failure mode). Each recheck needs an
     outage policy.
   - **Webhook-driven revoke.** Subscribe the App to `organization` (`member_removed`) and
     `membership` (`removed`) events and revoke sessions for the matching subject. Closest to
     immediate; needs a public webhook endpoint with secret verification and a replay story.
     Invariant either way: OCE disable/detach remains the authoritative offboarding.
2. **What GitHub answers for misconfiguration and SAML.** Unverified against real GitHub (the
   tests use fakes): whether an organization without the App installed, or a SAML-enforced
   organization without an active SAML session, answers `403` (`MEMBERSHIP_UNAVAILABLE`, with a
   warning log) or `404` (`MEMBERSHIP_REQUIRED`, silently). Implemented default: both fail
   closed, and the operator guide names both cases. Needs one check against a real
   organization, and a SAML-enforced one, before we claim support or tune the advice.
3. **Dedicated sign-in App.** Should the guide recommend a sign-in-only App (Members: read,
   no repository permissions) instead of reusing the repository integration's App? Better
   least privilege; costs a client-ID change and re-attachment for existing installations.
   Implemented default: the guide reuses the repository integration's App and adds Members:
   read to it.

## Delivery and verification

The allowlist landed in one pull request,
[#1231](https://github.com/openclaw/openclaw-enterprise/pull/1231)
`feat(auth): optional github org allowlist at sign-in`, merged 2026-10-04 while this RFC was
open (the owner asked not to block implementation on review). It also added the collector's
`step: membership` export (`deploy/logging/collector.yaml`) and the operator docs. #1225 had
documented the earlier behaviour the same day.

Evidence, all against loopback fakes of GitHub, in `tests/integration/`:
`github-login-transport.test.mjs` (admission, each refusal and outage cause, a later match
after a failure, exact request URLs, settings parsing), `sign-in-chart-parity.test.mjs` and
`profile-renderer.test.mjs` (render-time validation), and
`postgres-github-org-allowlist.test.mjs` (no session, persisted audit rows);
`tests/browser/console.test.mjs` covers both messages.

Migration: none. The settings are new and default off; there is no schema change.

## References

- [`apps/controller/src/auth/github.ts`](../../apps/controller/src/auth/github.ts) (exchange
  and callback), [`provider-transport.ts`](../../apps/controller/src/auth/provider-transport.ts)
  (bounded transport and failure causes).
- [GitHub: organization membership for the authenticated user](https://docs.github.com/en/rest/orgs/members#get-an-organization-membership-for-the-authenticated-user)
  and [team membership for a user](https://docs.github.com/en/rest/teams/members#get-team-membership-for-a-user).
- PR #1225 (documented the behaviour without an allowlist); PR #1231
  (implementation). Code comments cite this RFC by its pre-renumbering ID, RFC-0061.
