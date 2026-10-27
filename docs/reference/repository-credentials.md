# Repository credentials

Repository bindings select the Git HTTPS and GitHub API operations an Agent may use.
OCC saves grants. The [Token Service](#token-service-lifecycle) prepares credentials.
See the [operator guide](../guides/repository-credentials.md) and
[native prepared Git](repository-credentials/prepared-native-git.md).

Prepared native Git requires dedicated Codex (API key or ChatGPT service account)
without a Sandbox Driver. Unsupported Sandbox
combinations reject repository-bearing versions. Helm's `Recreate` strategy prevents overlapping
worker/credential-service owners.

In a native session, the consumer receives a gateway bearer for repository access.
Only the consumer receives model credentials. Dedicated Slack tokens stay in
the gateway. Repository profiles and model authentication are independent. The [networking contract](drivers/kubernetes-compute/networking-and-isolation.md#networking)
owns consumer access to the credential sidecar and the repository-bound Codex
proxy policy, which allows the exact broker hostname with `allow_local_binding = true`
and `mode = "full"`, disabling Codex's private-address guard and permitting every
HTTP method at otherwise allowed destinations. Explicit denies, NetworkPolicy,
TLS and broker authorization still apply. Operators can enable [anonymous public reads](public-github-reads.md).

The service owns protected configuration, sender callbacks and session controls.
Git/gh artifacts exclude signing and service modules.

## Repo Driver contract

The `repo` capability uses `RepositoryPolicyDriver` and `GitHubRepositoryPolicy`.
The GitHub Backend's `drivers.repo` member pins its ID. Protected composition selects
`repository` and the installed Sandbox/Credential Proxy Driver.
`repository.nativeSender` selects native sessions with prepared custody, without
protected fallback. Controller startup rejects the legacy Installation `drivers.repo`
selection in every mode. Stop new admissions and drain accepted work on its original owner before cutover;
then select `repository.nativeSender` with `repository.preparedGitHub`.
The [shared policy contract](../../packages/contracts/src/repo.ts) exposes:

- `listOptions` returns Namespace-approved opaque references, names, profiles
  and optional descriptions.
- `resolve` checks Namespace policy and returns admitted bindings and duration.

The separate native sender owns:

- `checkAdmissionReady` (optional) verifies fresh admissions can be
  attempted; unavailable dependencies block new attempts and worker readiness.
- `open` returns `created` with private runtime files, `recovered` with status
  only, or `missing`. `recoverOnly` cannot create authority.
- `status` returns the current observation or authoritative absence.
- `close` stops local authority and reports closure or absence, without
  promising remote revocation or runtime termination.

Public status contains only `sessionId`, `state`, `deadlineWallMs` and `binding`
(`providerInstanceId`, `repositoryId`, `grantId`). Responses are immutable
snapshots after private validation. Cleanup counters and configuration
decoding stay private. Status cannot regenerate the closed-schema Git/gh files.

`maintenanceIntervalMs` schedules worker reconciliation and retries of incomplete
repository cleanup; it is not a measured withdrawal bound. Configured IDs,
`AgentRevision.repositoryCredentials` and persisted
`admitted_spec.repository_credentials` retain their meaning.

State derives immutable Driver, Backend, profile and grant context from the
saved version. After Agent deletion it retains Namespace, Agent,
Agent revision, admission and session identities and deadlines, without bearers or tokens.

Agent deletion retires Compute without waiting for repository-session cleanup:
pending, missing, unknown and `invalidated` sessions block neither deletion
admission nor completion. Retained attempts and cleanup Work
continue independently; new requests share Work by version and purpose.
Deletion, invalidation and elapsed deadlines do not prove disposal or provider
revocation. Evidence pruning and durable token recovery are unimplemented.

Worker restart can retain surviving sessions and Compute material. A broker can
recover the original broker's committed `DISPOSED` observation; active or uncertain
sessions without one remain unknown. Missing exposed sessions fail the version
and retain cleanup; closing sessions block replacement until disposal. A new
authorized version neither settles old cleanup nor replays Git/API mutations.

## Configuration

### Canonical platform registry

The GitHub Backend selects `configuration.registryPath`. API, worker and service
load the same immutable, versioned ConfigMap containing nonsecret identity and
Namespace policy for one App installation and multiple repositories:

```json
{
  "version": 1,
  "backendId": "repository-backend",
  "providerInstanceId": "github-production",
  "appId": "123456",
  "githubInstallationId": "789012",
  "maximumDurationSeconds": 86400,
  "repositories": [
    {
      "repositoryRef": "application",
      "repositoryId": "345678",
      "repository": "example/project",
      "namespaces": [{ "namespaceId": "team", "profiles": ["git-read", "git-write", "git-full"] }]
    }
  ]
}
```

Use platform Namespace IDs. App, installation and repository IDs are positive
decimal safe integers as strings. Repository names are canonicalized to lowercase.
The registry admits at most 1,000 repositories, 128 Namespace policies per
repository and 4,096 overall. References, numeric IDs and canonical names must be
unique.

The grant fingerprint covers provider, App, installation, repository, maximum
duration, Namespace, allowed profiles, optional push-ref policy, selected profile
and permission contract. The service compares it independently before admission,
so a retained reference cannot preserve a grant after policy changes.

Each Namespace policy may set a
[`pushRefAllowlist`](repository-credentials/push-ref-guardrail.md) to prevent
accidental native Git pushes outside selected branches; it is not server-side
branch authorization.

Driver configuration supplies `controlSocket`, `sessionDurationSeconds` and
`publicCaPath`, never the App key. See [Backend configuration](backends.md) and
the [installation procedure](../guides/deploy/production-installation.md).

### Repository options

`GET /namespaces/:namespaceId/agents/repository-options` requires Agent `create`;
the exact-Agent editing route requires `update`. Both return approved
`repositoryRef`, `displayName`, `allowedProfiles` and optional `description`.
GitHub choices come from the approved registry without provider descriptions or
background metadata requests. Authorized discovery failure yields
`503 REPOSITORY_OPTIONS_UNAVAILABLE`, no approvals `[]`, no `repository` settings `[]`
with `meta.notConfigured`, and a closed Namespace 409. Only success or that outage permits a fresh ordinary draft; editing
requires success. Writes reauthorize and resolve.

### Profiles

The prepared native sender accepts `git-write` with one exact ref. The registry
selects Git-only access or Git plus draft creation on an approved base. It does
not expose general REST, GraphQL, issue management, or arbitrary PR operations.
See [prepared native Git](repository-credentials/prepared-native-git.md).

### Standalone service inputs

A protected JSON file supplies `gateway`, `sessionPolicy`, `backend` and optional
positive safe-integer `limits`, validated before listening. Configuration and
private keys must be private regular files owned by root or the service user.
Every ancestor directory must have one of those owners and reject group/other
writes; only a root-owned sticky ancestor such as `/tmp` above the immediate
parent is exempt. Symlinks and file replacement during loading are rejected. The
[configuration flow](../flows/repository-credential-configuration.md) owns
validation and TLS ownership.

Production native delivery selects `backend.kind: "github-prepared-git-registry"`
with `backendId` and `registryFile`. The registry must authorize `git-write`, one
exact branch ref, and `git-only` or `git-and-draft-pr` transport. The latter also
requires an approved PR base. The sender consumes READY material through the
worker's private socket; it cannot read an App key, sign a JWT, or issue a token.
The worker Token Service owns issuance and token cleanup.

`github-app` and `github-app-registry` fail startup with transition guidance.
Do not move an App key into a replacement sender, widen an approval, or replay an
uncertain issuance or PR creation. Unresolved work stays with its original owner;
a new installation or revision does not settle it.

Kubernetes projects only configuration, registry and TLS into the native sender.
The worker alone mounts the App key and custody key. See [sender selection](drivers/selection.md#select-a-protected-sender).

The explicit development-only `github-token` profile remains available with both
its configuration opt-in and `--development-authority`. See
[development token authority](repository-credentials/development-token.md).

The service image must trust GitHub's HTTPS certificate chain. For a private CA,
supply a readable bundle and `NODE_EXTRA_CA_CERTS`; keep certificate and hostname
verification enabled.

Git discovery, upload-pack and receive-pack accept case differences in the
admitted owner/repository and an optional `.git` suffix. The backend constructs
a canonical upstream path; a literal `.git` repository name remains part of the
admitted identity. Endpoint, method, media-type, service-query and profile
restrictions still apply; API paths and repository authority are unchanged.

## Token Service lifecycle

The worker signs a short-lived JSON Web Token (JWT) with the GitHub App private
key. GitHub exchanges the JWT for an installation token. The trusted sender uses
it for repository operations. Both the signing key and token stay outside the Agent.

For a repository grant the worker requests one repository ID and the approved
permissions. The opt-in [installation profile](repository-credentials/protected-openshell-git.md#grant-access-to-a-github-app-installation)
inherits all repositories and permissions available to the App installation. OCE adds
no repository or ref restriction to that profile.

Renewal preserves scope and session deadlines. A cold request cannot mint a token.
See the [preparation and retirement timeline](../flows/credential-source-refresh.md#6-oce-prepared-github-core).
`PREPARED_GITHUB_RECOVERY_REQUIRED` (`quarantined` or `blocked`) requires
[recovery by the issuing owner](../guides/repository-credentials/team-runbook.md#replace-a-rejected-app-key).

## Sessions and closure

The trusted worker or local operator uses HTTP over a private mode-0600 Unix socket:

| Request                                                           | Response                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /v1/capabilities`                                            | Durable admission version for the registry-backed service   |
| `POST /v1/sessions` with `durationSeconds` and optional `profile` | Private status, client configuration and bearer once        |
| `GET /v1/sessions/{id}`                                           | Private session and cleanup status                          |
| `POST /v1/sessions/{id}/close`                                    | Immediate local closure status; cleanup reported separately |

The socket's parent is private to the service/operator and never mounted into
the client. Control bodies are limited to 16 KiB. The HTTPS client listener has
no admission or close endpoint.

`X-Admission-Id` combines a 13-digit Unix-millisecond timestamp, hyphen and
lowercase UUIDv4; the CLI prints this nonsecret ID before dispatch. HTTP 201
returns the bearer once; a matching ID/duration/profile returns HTTP 200 with
status only; conflicts fail. Follow
[lost-response recovery](../guides/repository-credentials/standalone-service.md#recover-an-admission)
before explicitly requesting replacement material.

Registry-backed brokers privately advertise `durableAdmissionVersion: 1`, which
the worker checks before new attempts and readiness; an unavailable or older
broker blocks both. The check proves neither journal availability, absence nor
disposal; recovery, closure and runtime retirement do not depend on it.

Platform admission binds `namespaceId`, `repositoryRef`, normalized `profile`,
`expectedBinding` and `deadlineWallMs` to the persisted attempt. The worker's private
receipt socket reserves before the broker constructs the selected route or releases a
bearer. Recovery can durably fence a missing admission; unconfirmed reservations,
active sessions and disposals remain unknown. Only the original broker records its
exact `DISPOSED` result. Credential-free receipts remain with attempt history.
Journal failure prevents new bound admission and proves neither absence nor disposal.

Unseen IDs must be under 60 seconds old and never future-dated. Process-local
correlations stop at twice the session limit and can return `overloaded`;
unresolved cleanup survives that window. Restart loses standalone correlations.
No correlation recovers a bearer.

A bearer needs a live process and upstream authorization. Replacement tokens must cover
the remaining exchange budget and safety margin. An owned exchange keeps its credential
through replacement and runs any configured standing callback after verified TLS, before
first write. Prepared Git checks its original [one-use permit](repository-credentials/prepared-native-git.md#what-a-request-authorizes), cancellation and send deadline.

Authentication and cleanup expire separately in elapsed monotonic time from capture;
delayed acquisition settlement extends neither. The GitHub adapter allows 60 seconds
of provider clock skew and stops authentication before reported expiry. Cleanup retains
its one-hour bound from local receipt. A forward wall-clock change can deny authentication
but cannot prove remote expiration.

Closing or expiring a session prevents use and cancels owned exchanges. Status observes
expiry without cancellation or cleanup; clock rollback cannot restore use, including
reserved exchanges. `CLOSED` does not prove revocation. Private control status distinguishes pending, revoked,
expired and uncertain credentials and auxiliary cleanup.
`DISPOSED` requires settled actions, resolved access-token obligations and
completed auxiliary finalization; historical revoked/expired counters may remain
nonzero. Uncertain issuance blocks automatic minting; uncertain pushes or API
mutations are never replayed automatically.

If session construction fails, renewal access closes immediately; retained
cleanup material counts against session capacity and shutdown's
`pendingAuxiliary` until admitted callbacks finish and disposal completes.

## GitHub response data

[Protected metadata](../flows/repository-credentials.md#5-deliver-an-outcome-and-release-ownership)
requires verified identity and no actual trailers before releasing `{ id, full_name }`.
Joined OpenShell enforcement still needs proof.

REST JSON responses below the size limit omit `temp_clone_token` from the repository object,
its `parent` and `source` relationships, and pull-request `head.repo` and
`base.repo`. GraphQL selecting `tempCloneToken` gets 400.

Rewrite only validated pagination and followed links passing origin, repository,
route and profile checks. Translate `/repositories/<id>` only for the configured
ID, to its admitted `/repos/OWNER/REPO` route. Pagination checks `after`
and `before` cursor format and length; direct ID-route requests remain unsupported. Preserve other links,
human text and unrelated metadata.

## Client routing and limits

`/usr/bin/git` owns commands, identity, hooks, aliases, remotes and worktrees.
OCE neither parses its arguments nor replaces HOME. Git and gh preserve exit
codes; a signal returns `128 + signal number`.

Preparation validates generation, manifest, session metadata, paths and file custody,
then writes private `gitconfig` without reading bearers or admitting sessions.
Kubernetes gates startup on copying material and preparing its private subPath.
Each HTTPS host maps to one gateway origin, with consistent CA trust;
a pin cannot change an origin already selected.

A host-prefix rewrite preserves owner/repository casing and an optional terminal
`.git`. It also routes unadmitted repositories on that host to the gateway, where
the helper releases no bearer. Separately authenticated same-host use needs an
explicit native configuration override. SSH and additional-repository submodule
workflows are unsupported.

The generated defaults scope helper reset, `credential.useHttpPath=true`, verified
TLS, optional CA trust and disabled redirects to the exact gateway HTTPS origin.
The helper checks effective protocol, host/port, username and repository path.
Git decodes percent-escapes in the host, username and path first, so an escaped
spelling of an admitted gateway host and repository receives a bearer; it can
reach no other host, and the gateway refuses any `%` in a request path. Dot
segments, extra components and unmatched names receive no bearer. A literal
name ending in `.git` can overlap another admitted identity; the helper compares
both spellings and refuses ambiguity or alternate grants.

Duplicate repository bindings remain valid. Select one with `OCE_REPOSITORY_REF`;
gh also propagates `OCE_REPOSITORY_SELECTION` containing generation, repository
reference and session ID. Conflicting or stale pins fail remote authentication.
The helper command embeds the prepared generation and refuses newer-generation
material. It validates the selected original deadline before reading its
bearer; gateway closure can deny use earlier. Local commands skip the helper,
so they continue after expiry or with stale pins. Generation
pinning does not promise a command-wide snapshot across arbitrary subprocesses.

Native settings override these defaults; other helpers can retain credentials.
Our helper ignores `store` and `erase`. There is no command-wide preflight.

The API launcher requires GitHub CLI **2.103.2**, `GH_HOST=github.com`, a gateway
hostname with verified TLS, and HTTPS port 443. Its private `hosts.yml` uses the
experimental `api_host` routing option and stores only the gateway bearer in
`oauth_token`. The launcher admits the
[supported commands](repository-credentials/access-levels.md#supported-commands)
and relative API endpoint paths, never absolute API destinations. Routing configuration is not network egress confinement.

Default service bounds are 16 sessions including pending cleanup, two credential
slots per session, one provider action and 64 queued actions, 64 sockets per
listener, and 32 exchanges total and four per session. Headers are limited to 32 KiB/64 pairs;
request targets to 8 KiB. Git fetch input is 1 MiB; push input and Git output are
256 MiB. API input is 1 MiB and response data 8 MiB. Git gzip input has independent
wire and decoded limits. Exchanges have a five-minute total bound, a 30-second
response-header wait, a five-second progress timeout and a 60-second credential margin.

For larger upload-pack responses, operators can configure `gitFetchResponseBytes`,
`gitFetchFirstHeaderMs`, `gitFetchStallMs`, `gitFetchExchangeMs` and `maxExchangeMs`
in the protected service configuration. For example, set these to 17179869184
(16 GiB), 60000, 60000, 1800000 and 1800000 respectively. Existing explicit
`gitResponseBytes`, `firstHeaderMs`, `stallMs` and `exchangeMs` overrides also apply
to upload-pack unless the corresponding upload-pack limit is set. `maxExchangeMs`
caps every exchange; an `exchangeMs` override sets this ceiling unless configured
separately. Session expiry can end requests sooner. Credential validity must cover
the deadline plus the credential margin; development static-token upload-pack is
capped at the lease less two margins. Each stream consumes a socket and exchange slot.
The
[dispatch flow](../flows/repository-credentials.md#4-reserve-acquire-and-dispatch)
owns upstream-origin capture, adapter-header reconstruction and per-phase
client-header, response-header, connection, input and stall deadlines.
Provider actions have at most 30 seconds. On `SIGTERM` or `SIGINT`, shutdown
allows 60 seconds for cleanup before reporting unresolved obligations and terminating.
Unsettled actions retain capacity until exit; grace expiry does not establish
`DISPOSED` or confirmed revocation. Restart cannot recover the lost provider
cleanup inventory. Overrides remain positive and finite.

The [testing guide](../testing/repository-credentials.md) separates fixture
from live-provider proof; local fixtures establish neither live GitHub
compatibility nor release readiness. The
[service flow](../flows/repository-credentials.md) and
[Agent flow](../flows/agent-repository-credentials.md) own implementation.
