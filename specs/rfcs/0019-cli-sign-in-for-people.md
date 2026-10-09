---
status: Proposed
implementation_status: Not implemented
author: freeqaz
---

# Proposal: Short-lived CLI sign-in for people

- **ID:** RFC-0019
- **Owner:** freeqaz (proposal and auth review). Scope and release: OCE maintainers.
- **Created:** 2026-10-04
- **Last updated:** 2026-10-07
- **RFC PR:** [#1235](https://github.com/openclaw/openclaw-enterprise/pull/1235)
- **Implementation plan:** none yet; delivery steps are listed below.
- **Related:** [Authentication](../../docs/reference/authentication.md);
  [external sign-in and account controls](../../docs/reference/authentication/external-sign-in.md);
  [service API keys](../../docs/reference/authentication/service-api-keys.md);
  [authorization](../../docs/reference/authorization.md#principals);
  [RFC-0001 OIDC sign-in](0001-oidc-sign-in.md); RFC #924 token service (proposed).

<a id="problem-and-decision"></a>

## Summary

`occ login` gives a person a CLI credential that acts as that person and no one else. The
person runs `occ login`, signs in to the console the usual way (password, GitHub, Google or
OIDC), and approves the code shown in the terminal. `occ` receives a **CLI session**: an
opaque credential that admits the person's own Principal, so every request is checked
against their current grants. It never outlives the browser session that approved it, has
no refresh, and ends on that session's sign-out or expiry, or when the account is disabled,
revoked or loses its sign-in method. Automation and CI keep service API keys.

## Motivation

Dogfood round 15 (findings D386, extending D39) set up two teams through Keycloak and found
that a scoped person cannot use `occ` at all:

- `occ` authenticates only with `--service-key-file`
  ([client](../../internal/occclient/client.go) sends `x-api-key`). A browser session cannot
  reach the CLI: the controller rejects `Authorization`, and the documented session recipe
  is password-only.
- Only an Installation administrator can issue a key, and only for an existing non-Agent
  ServicePrincipal; members get `403`. Until #1600 nothing created one, so in practice only
  the bootstrap admin principal had keys.
- A key lasts 1 to 365 days (`expiresIn: 3600` returns `400 … at least 86400`). It
  represents the ServicePrincipal, not the person, so it survives the issuer's sign-out and
  disable.

So a person gets no CLI, or a long-lived key that is not theirs, which defeats the SSO goal.
Scoping works in the console and API, but not in the CLI.

<a id="scope"></a>

## Goals

- A person uses `occ` with exactly their own authority. What the console refuses, `occ`
  refuses, and the reverse.
- The credential is bounded by the approving browser session (at most 8 hours today) and
  has no refresh.
- Every existing control that ends a person's access also ends their CLI sessions, with no
  new step.
- The flow is the same for every sign-in method and works on headless hosts (SSH,
  containers, port-forwarded installs).

## Non-goals

- Shortening key lifetimes. Namespace ServicePrincipals for automation are #1600 (D386
  option b).
- Accepting IdP or GitHub tokens as OCC credentials, or making OCE a general OAuth server
  for third-party clients.
- Down-scoping below the person's grants, beyond an optional Namespace pin. Read-only
  sessions are future work.
- Noticing an IdP-side disable. As in the browser, the session lifetime bounds it.
- Agent or workload authentication (RFC #924 and the deferred workload-identity work).

<a id="design"></a>

## Proposal

### Flow: device authorization, approved in the console

`occ login` follows the RFC 8628 device-authorization shape. OCE is both the authorization
server and the resource server, so the IdP sees nothing beyond the person's ordinary
console sign-in.

```mermaid
sequenceDiagram
  participant CLI as occ (terminal)
  participant API as OCC API
  participant Console as Console (signed-in person)
  CLI->>API: POST /api/auth/cli/device-authorizations {clientLabel, namespaceId?}
  API-->>CLI: deviceCode, userCode, verificationUri, interval, expiresIn (600 s)
  Note over CLI: prints userCode and /console/cli-login; no pre-filled link
  Console->>API: POST /api/auth/cli/device-authorizations/lookup {userCode}
  API-->>Console: requester address, client label, Namespace pin, resulting expiry
  Console->>API: POST /api/auth/cli/device-authorizations/decide {userCode, approve|deny}
  loop every interval
    CLI->>API: POST /api/auth/cli/token {deviceCode}
    API-->>CLI: authorization_pending / slow_down / access_denied / expired_token
  end
  API-->>CLI: once approved: CLI session token and expiresAt
```

_Proposed flow; nothing here is implemented._

- **Start** is unauthenticated and bounded like provider start: 30 per minute per trusted
  client address and 1,000 pending in total, with the oldest evicted. The device code is
  at least 128 random bits. OCE stores only SHA-256 hashes of the device code and user
  code, plus the caller-reported `clientLabel` (at most 64 printable characters, shown as
  unverified), the requesting address, an optional Namespace pin and a 10-minute expiry.
- **The user code** has 8 characters from a 20-letter consonant alphabet (about 34 bits),
  shown as `BCDF-GHJK`. The person types it at `/console/cli-login`. OCE offers no
  `verification_uri_complete`, so a phishing link cannot carry a code to a one-click
  approval. `lookup` and `decide` carry the code in the POST body, never the URL, and
  share a budget of 5 wrong codes per minute keyed on both the account and the client
  address.
- **Approval** needs a current human browser session, the configured `Origin`, and the
  tab's `x-occ-session-key` (optional elsewhere; mandatory here on purpose). The page names
  the account, says the CLI gets its current permissions and never more, shows the
  requesting address, unverified client label, Namespace pin and exact expiry, and warns
  "only approve a code you just started yourself", louder when the requesting address
  differs from the browser's. Without
  [trusted proxies](../../docs/reference/settings/production.md#github-sign-in-and-trusted-proxies)
  both addresses are the ingress's, which the docs state. Deny is final.
- **Token exchange** is one transaction: approved to consumed, the `cli_sessions` insert
  and the `issue` audit commit together. On audit failure it rolls back, and the CLI gets
  `503` and polls again. A consumed code cannot be replayed; a session whose response was
  lost shows in the person's list and the audit, and can be revoked.

These routes are unrelated to `/namespaces/:ns/agents/device-authorizations`, where OCE is a
device-flow _client_ for Agent credentials; only its code display is reused.

### Credential shape and lifetime

A CLI session is a row in `occ.cli_sessions`, with these columns:

- `token_hash`: SHA-256 of the token, never the token itself;
- `user_id` and `parent_session_id`, a foreign key to `occ.session` with `ON DELETE CASCADE`;
- `namespace_id?`, `client_label`, `created_at` and `expires_at`;
- `method_id`, `version` and `method_version`, copied from the parent's
  `human_authentication_sessions` row.

The token is 256 random bits, base64url-encoded, with an `occcli_` prefix so secret
scanners can recognize it.

The three binding columns exist only in the guarded profile, which an external provider
enables. In the password-only profile they are null, and verification checks only that the
parent session still exists and has not expired. That is the same guarantee browser
sessions have there: no online disable or revoke, only sign-out, expiry and
`purge-sessions`.

- `expires_at = min(parent.expires_at, now + cliSessions.maxLifetimeSeconds)`. The setting
  ranges from 900 to 28,800 seconds and defaults to 28,800. The approval page shows the
  result and says that signing in again gives a full-length session.
- **No refresh.** OCE learns of an IdP-side disable only at the next sign-in, so the
  lifetime is the only bound on someone who has left. On expiry, `occ` tells the person to
  run `occ login`.
- **Header.** `x-occ-cli-session`; `Authorization` stays reserved for the workload or OAG
  evidence [admission](../../apps/controller/src/admission/admission-verifier.ts)
  anticipates. As with keys, an explicit token never falls back to a cookie, both headers
  together get `401`, a bad token gets `401`, and no `Origin` is needed. Controller logs and
  `occ` errors must redact it and `x-api-key` (no redaction list exists today).
- **Limits.** A parent session can hold at most 10 active CLI sessions. Expired device
  authorizations and expired or consumed sessions are deleted at start, the way login
  attempts are, and by a bounded periodic sweep.

### Binding to the person and their grants

Admission gains `method: "cli_session"`, with the same `(betterAuthIssuer, userId)` external
identity that a browser session yields. The IAM Driver resolves the same Principal and
checks current grants on every request. No grant is copied into the credential, so a
removed binding takes effect on the next request. A Namespace pin sets
`admittedScope.namespaceId` the way a Namespace service key does, so Installation-level
and other-Namespace routes are refused. In the guarded profile, verification loads the CLI
session with its parent and the account in one query. It admits only when the parent
exists and is unexpired, the account is enabled, `version` and `method_version` match, and
the provider instance is still configured. These are the browser session's own checks.

A copied token must not extend its own reach or lifetime, so these routes stay
browser-only and return `403` for `cli_session`:

- account reads and mutations, recovery and account creation;
- service-key issuance and revocation, so a token cannot mint a 365-day key;
- CLI-login approval;
- native admin UI;
- `GET /api/auth/session`.

The gates are not uniform, and delivery must handle each one on purpose, with tests:

| Gate                          | Location                              | What delivery must do                                                                                     |
| ----------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Global method allowlist       | `index.ts:1566`                       | admit `cli_session`; an unknown method answers `503` today                                                |
| Account actor                 | `humanAccountActor` (`index.ts:2780`) | keep it `session`-only                                                                                    |
| Native admin                  | `native-admin.ts:211`, `:734`         | keep it `session`-only                                                                                    |
| Service-key create and revoke | `index.ts:2471`                       | add a new deny; today the route checks only `requireInstallationAdmin` and coverage, with no method check |
| Workspace-file CSRF           | `index.ts:1179`                       | treat `cli_session` like `api_key`; otherwise every CLI request is refused for its missing `Origin`       |

### Revocation

| Event                                                        | Effect on CLI sessions            | Mechanism                                                                                  |
| ------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `occ logout`                                                 | that session ends                 | `DELETE /api/auth/cli-sessions/current`; local copy removed                                |
| Sign-out of the approving browser session                    | its CLI sessions end              | parent row deleted, cascade                                                                |
| Approving session expires                                    | already expired                   | `expires_at` ≤ parent's                                                                    |
| Account disable or revoke                                    | all of the account's sessions end | version bump; State already deletes the account's `occ.session` rows, so the cascade fires |
| Method detach, provider removed, client ID or issuer changed | sessions of that method end       | method checks; `authentication.session.end`                                                |
| Grant or binding removed                                     | next request `403`                | current IAM policy                                                                         |
| Person revokes in the console                                | that session ends                 | `GET`/`DELETE /api/auth/cli-sessions[/:id]`, own sessions only                             |
| IdP-side disable                                             | continues until expiry (≤ 8 h)    | documented, as for browser sessions                                                        |

Binding and revocation checks read State on each request, so they hold across controller
instances. The start and wrong-code limits are per controller, like the existing sign-in
limits; the guarded profile runs one controller.

### Client storage

`occ` gains `login`, `logout` and `auth status` (account, expiry, pin, active credential
source). Storage is per OCC origin:

- **OS keychain by default** (macOS, Windows, Linux Secret Service), token only. The probe
  has a timeout, because a Secret Service prompt over SSH can block.
- **File fallback:** used when no keychain answers, or when `--credential-store=file` is
  given: `$XDG_CONFIG_HOME/occ/sessions/<origin-digest>.json`, `0600` in a `0700`
  directory; group- or world-readable files and symlinks are refused.
- **Non-secret profile:** the origin, CA bundle path, session ID, expiry and email.
- **Origin pinning:** the token goes only to its issuing origin; `occ` never follows
  redirects.

`--service-key-file` / `OCC_SERVICE_KEY_FILE`, when set, still wins, so existing scripts
are unchanged.

### Audit

Events carry non-secret IDs, never a token, device code or user code. An approval or
exchange whose audit cannot be written returns `503` and issues nothing.

- `openclaw.auth.cli-sessions.approve` and `.deny`: the person's Principal, the
  authorization ID, the requesting address, the client label and the Namespace pin.
- `openclaw.auth.cli-sessions.issue`: the CLI session ID, the parent session key and the
  expiry.
- `openclaw.auth.cli-sessions.revoke` for logout and console revoke;
  `authentication.session.end` for cascades.
- Resource events done through a CLI session record method `cli_session` and the session
  ID, so audit separates a person's console actions from their CLI actions.

### Automation, CI and Namespace keys

CI and unattended automation keep
[service API keys](../../docs/reference/authentication/service-api-keys.md). With #1600 an
administrator can also give a member a Namespace ServicePrincipal key
(`occ service-key create`). That key is an automation identity that lasts days and survives
the issuer's sign-out; a CLI session is the person and ends with their browser session. An
explicit key still wins in `occ`. A CLI session never issues keys (browser-only, above).

### Relation to RFC #924 (token service)

RFC #924 leases _outbound_ upstream credentials, such as GitHub tokens, to Agents through
Agent-scoped bearers. This RFC issues _inbound_ OCC admission evidence to people. The two are
compatible and deliberately separate:

- The controller verifies CLI sessions next to browser sessions and keys, never through
  the Token Service, which would otherwise sit on every API request.
- Both use the same rules: opaque bearer, hash-only persistence, no plaintext recovery,
  durable revocation, secret-free audit.
- The credentials are disjoint: the Agent bearer travels in `Authorization`, which the
  controller rejects, and the Token Service gateway must reject `occcli_` tokens. Tests
  cover both.

## Delivery and verification

1. **Controller.** Migration for `cli_device_authorizations` and `cli_sessions`, including
   grants to the application role as in `0037`. The routes, the admission variant, the
   gate changes above, audit, and settings (`auth.cliSessions.enabled`,
   `maxLifetimeSeconds`). Header redaction, OpenAPI, and the reference docs, including
   replacing "bearer credentials are unsupported".
2. **Console.** The `/console/cli-login` approval page, and the person's own sessions with
   revoke.
3. **`occ`.** `login`, `logout` and `auth status`, keychain and file storage, and
   precedence.

The change is additive. An `occ` that reaches an older controller gets `404` and explains
that `occ login` is not supported there. An older controller ignores `x-occ-cli-session`,
falls through to the cookie path and answers `401`, so a rollback fails closed.

Required evidence:

- **Unit:**
  - the device state machine;
  - user-code normalization and the shared lookup/decide budget;
  - header precedence;
  - every gate in the table above;
  - password-only verification;
  - `occ` file mode, symlink refusal, origin pinning and the keychain timeout fallback.
- **PostgreSQL:**
  - parent-delete cascade;
  - disable, revoke and detach;
  - `expires_at` never later than the parent's;
  - two concurrent pollers produce exactly one consumption;
  - an audit failure at exchange leaves the authorization approved;
  - sweep;
  - the per-parent cap.
- **Browser:**
  - approve, deny, wrong code and expired code;
  - signing in from the approval page returns to it;
  - a code in the URL is ignored;
  - the address-mismatch warning.
- **Live** (the round-15 Keycloak matrix, through `occ`):
  - each person sees exactly their console results;
  - the other team's resources return `403`;
  - browser sign-out, disable, revoke, detach and `occ logout` each give `401`;
  - a Keycloak-side disable lasts until expiry;
  - a CLI session cannot issue a key or read accounts;
  - a Namespace-pinned session cannot reach Installation routes.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

- **Loopback redirect with PKCE (RFC 8252)** is smoother on a desktop but fails over SSH,
  in containers and behind port-forwards, and needs a new redirect flow. It can be added
  later over the same console approval.
- **The IdP's device flow or token exchange** differs per provider; GitHub's would hand OCE
  a token with repository authority. Rejected.
- **Pasting the browser cookie into `occ`:** no separate revocation or audit. Rejected.
- **Per-person service keys** (#1600) are an automation identity, not the person, and
  outlive the session.
- **Doing nothing** (option c) leaves scoped people with no CLI.

## Unresolved questions

1. **Lifetime model** (owner). The proposal makes a CLI session a child of the approving
   browser session, so it ends at that session's sign-out. The alternative is an
   independent sibling of at most 8 hours that survives browser sign-out but not account
   controls.
2. **Header** (auth reviewers). The proposal uses `x-occ-cli-session`, which keeps
   `Authorization` free for workload admission. `Authorization: Bearer` is more often
   redacted by third-party proxies.
3. **Step-up** (owner). Should approval require a recent sign-in, for example within
   15 minutes, to resist device-code phishing? The proposal says no, relying on the typed
   code, the requesting address and the warnings.
4. **Default** (owner). Should `auth.cliSessions.enabled` default to on, as proposed since
   it grants nothing beyond the browser session, or be opt-in?
5. **Administrator view** (owner). Should Installation administrators list and revoke
   other people's CLI sessions individually? Today account revoke ends all of them.
6. **Namespace pin** (maintainers). Ship it in the first delivery, as proposed?
7. **Linux storage** (CLI maintainers). Keychain with a file fallback (proposed), or the
   file by default? Either way, a keychain library adds a new Go dependency.

## References

- Dogfood round 15 findings D386 and D39, summarized under Motivation.
- [Service-key issuance](../../docs/reference/authentication/service-api-keys.md#issuance);
  [session and recovery controls](../../docs/reference/authentication/external-sign-in.md#session-and-recovery-controls).
- [Admission verifier](../../apps/controller/src/admission/admission-verifier.ts);
  [controller auth](../../apps/controller/src/auth/index.ts);
  [session binding schema](../../migrations/0037_human_authentication.sql).
- [`occ` client](../../internal/occclient/client.go); [`occ` commands](../../internal/occcli/cli.go).
- RFC 8628 (device authorization grant); RFC 8252 (native apps); RFC #924.
