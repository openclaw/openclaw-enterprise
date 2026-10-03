# Repository credentials

Repository bindings grant bounded Git HTTPS and GitHub API access. OCC freezes
grants into a revision; the worker prepares material. The credential service
retains App keys, JWTs and installation tokens. Agents receive gateway bearers,
client configuration and CA trust. Start with the
[operator guide](../guides/repository-credentials.md).

Kubernetes supports embedded OpenClaw (`api_key`) or dedicated Codex (API key or
ChatGPT service account), without a Sandbox Driver; other combinations reject
repository-bearing revisions. Helm's `Recreate` strategy prevents overlapping
worker/credential-service owners.

Only the consumer receives repository and model credentials; dedicated Slack
tokens stay in the gateway. Repository profiles and model authentication are
independent. The [networking contract](drivers/kubernetes-compute/networking-and-isolation.md#networking)
owns consumer access to the credential sidecar and the repository-bound Codex
proxy policy, which allows the exact broker hostname with `allow_local_binding = true`
and `mode = "full"`, disabling Codex's private-address guard and permitting every
HTTP method at otherwise allowed destinations. Explicit denies, NetworkPolicy,
TLS and broker authorization still apply. Unbound Agents keep their policy.

The separate service owns protected configuration, private sender callbacks and
the `open`, `status`, `close` and `shutdown` controls; separate Git/gh artifacts
exclude signing and service modules.

## Repo Driver contract

The optional `repo` capability uses `RepoDriver extends Driver`, with the bundled
`GitHubRepoDriver`. Trusted Installation `drivers.repo` and GitHub Backend
`drivers.repo` select the same configured Driver ID. The
[shared contract](../../packages/contracts/src/repo.ts) exposes:

- `listOptions` returns Namespace-approved opaque references, names, profiles
  and optional descriptions.
- `resolve` checks Namespace policy and returns admitted bindings and duration.
- `checkAdmissionReady` (optional) verifies fresh admissions can be
  attempted; unavailable dependencies block new attempts and worker readiness.
- `open` returns `created` with private runtime files, `recovered` with status
  only, or `missing`. `recoverOnly` cannot create authority.
- `status` returns the current observation or authoritative absence.
- `close` stops local authority and reports closure or absence, without
  promising remote revocation or runtime termination.

Public status contains only `sessionId`, `state`, `deadlineWallMs` and `binding`
(`providerInstanceId`, `repositoryId`, `grantId`). Each response is an immutable
snapshot after complete private validation. Cleanup counters and configuration
decoding remain private. Status cannot regenerate the closed-schema Git/gh files.

`maintenanceIntervalMs` schedules worker reconciliation and retries of incomplete
repository cleanup; it is not a measured withdrawal bound. Configured IDs, `AgentRevision.repositoryCredentials` and
persisted `admitted_spec.repository_credentials` retain their meaning.

State derives immutable Driver, Backend, profile and grant context from the
admitted revision. After Agent deletion it retains the original Namespace, Agent,
revision, admission and session identities and deadlines, without bearers or tokens.

Agent deletion retires Compute without waiting for repository-session cleanup:
pending, missing, unknown and `invalidated` sessions block neither deletion
admission nor completion. Retained attempts and cleanup Work survive and
continue independently; new requests share Work by revision and purpose.
Deletion, invalidation and elapsed deadlines do not prove disposal or provider
revocation. Evidence pruning and durable token recovery are unimplemented.

Worker restart can retain surviving sessions and Compute material. A broker can
recover the original broker's committed `DISPOSED` observation; active or uncertain
sessions without one remain unknown. Missing exposed sessions fail the revision
and retain cleanup; closing sessions block replacement until disposal. A new
authorized revision neither settles old cleanup nor replays Git/API mutations.

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
`descriptionRefs` accepts up to 20 unique, comma-separated refs;
`meta.descriptionsPending` signals background work, and missing descriptions never
block selection. Authorized discovery failure yields
`503 REPOSITORY_OPTIONS_UNAVAILABLE`; no approvals yields `[]`; a closed Namespace
yields 409. Only success or that outage permits a fresh ordinary draft; editing
requires success. Writes reauthorize and resolve.

The service rechecks approved refs and fetches metadata with a private,
repository-scoped Metadata-read token, validating GitHub's numeric repository ID;
the Driver checks provider, App, installation and repository IDs. Lookups share
provider capacity and token cleanup with sessions and are cached for five minutes.
Descriptions never grant access.

### Profiles

The Console offers **Read-only** (`git-read`) and **Contributor** (`git-full`);
**Customize access** can disable issue management (`git-write`). Push and PR
access stay bundled; all profiles include GitHub API access. Direct bindings
default to `git-write`. Every session selects one repository. Missing App
permissions fail without widening the grant.

The [access-level reference](repository-credentials/access-levels.md) owns exact
permissions, `repositoryAccess` inheritance, supported commands, the GraphQL
boundary and [merge risk](repository-credentials/access-levels.md#api-and-branch-boundaries):
writable levels can merge subject to GitHub rules.

### Standalone service inputs

A protected JSON file supplies `gateway`, `sessionPolicy`, `backend` and optional
positive safe-integer `limits`, validated before listening. Configuration and
private keys must be private regular files owned by root or the service user.
Every ancestor directory must have one of those owners and reject group/other
writes; only a root-owned sticky ancestor such as `/tmp` above the immediate
parent is exempt. Symlinks and file replacement during loading are rejected. The
[configuration flow](../flows/repository-credential-configuration.md) owns
validation and key ownership. Standalone single-repository example:

```json
{
  "gateway": {
    "publicOrigin": "https://credentials.example.internal",
    "listen": "0.0.0.0:8443",
    "tlsCertFile": "/run/repository-credentials/tls.crt",
    "tlsKeyFile": "/run/repository-credentials/tls.key",
    "controlSocket": "/run/repository-control/control.sock"
  },
  "sessionPolicy": {
    "maximumDurationSeconds": 172800,
    "defaultProfile": "git-write",
    "allowedProfiles": ["git-read", "git-write", "git-full"]
  },
  "backend": {
    "kind": "github-app",
    "providerInstanceId": "github-production",
    "configVersion": "1",
    "appId": "123456",
    "installationId": "789012",
    "repositoryId": "345678",
    "repository": "example/project",
    "privateKeyFile": "/run/repository-credentials/app.pem"
  }
}
```

Identifiers are examples; production upstream origins are fixed to
`github.com` and `api.github.com`. Registry mode instead uses backend fields
`kind: "github-app-registry"`, `backendId`, `registryFile` and `privateKeyFile`;
all repository policy comes from that registry, and unbound admission is refused.

Kubernetes copies selected projection generations into service-owned
private files before protected-path validation. API and worker receive
registry/public CA inputs; only the service receives App and TLS private keys.

The privileged GitHub transport captures installation, repository and permission
profile at construction. Its operations issue scoped tokens and revoke owned
tokens; callers cannot supply HTTP requests. Extending them changes a credential
boundary and requires security review.

The service image must trust GitHub's HTTPS certificate chain. For a private CA,
supply a readable bundle and `NODE_EXTRA_CA_CERTS`; keep certificate and hostname
verification enabled.

Git discovery, upload-pack and receive-pack accept case differences in the
admitted owner/repository and an optional `.git` suffix. The backend constructs
a canonical upstream path; a literal `.git` repository name remains part of the
admitted identity. Endpoint, method, media-type, service-query and profile
restrictions still apply; API paths and repository authority are unchanged.

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
`expectedBinding` and `deadlineWallMs` to the persisted attempt. The worker's
private receipt socket commits a reservation before the broker releases a bearer.
A recovery-only lookup can durably fence a missing admission; a reservation or
active session without a confirmed terminal receipt remains unknown. Only the
original broker can record its exact `DISPOSED` result. Receipts contain no
credentials and remain with attempt history. Journal failure prevents new bound
admission and cannot establish absence or disposal.

Unseen IDs must be under 60 seconds old and never future-dated. Process-local
correlations are bounded to twice the session limit and can return `overloaded`;
unresolved cleanup survives that window. Standalone correlations do not survive
restart. No correlation recovers a bearer.

Session duration is independent of token lifetime. Replacement uses the original
grant and must cover the remaining exchange budget plus safety margin. Idle
sessions need no periodic mint. The bearer works while its session process and
upstream authorization survive.

Authentication eligibility and terminal cleanup expiry are separate deadlines,
both in elapsed monotonic time from the original capture; delayed acquisition
settlement cannot extend either. The GitHub adapter allows 60 seconds of provider
clock skew and conservatively stops authentication before the reported expiry.
Cleanup retains the one-hour bound from local receipt. A forward wall-clock
change can deny authentication but cannot establish remote expiration.

Closing or expiring a session prevents new use immediately and cancels owned
exchanges. `CLOSED` does not imply confirmed revocation. Private control status
distinguishes pending, revoked, expired and uncertain credentials, plus auxiliary cleanup.
`DISPOSED` requires settled actions, resolved access-token obligations and
completed auxiliary finalization; historical revoked/expired counters may remain
nonzero. An uncertain issuance blocks automatic minting; uncertain pushes or API
mutations are never automatically replayed.

If session construction fails, renewal access closes immediately, but retained
cleanup material counts against session capacity and shutdown's
`pendingAuxiliary` until admitted callbacks finish and it is disposed.

## GitHub response data

Bounded REST JSON responses omit `temp_clone_token` from the repository object,
its `parent` and `source` relationships, and pull-request `head.repo` and
`base.repo`. GraphQL selecting `tempCloneToken` gets 400.

Gateway rewriting covers only validated pagination links and explicitly followed
resource fields that pass origin, repository, route and profile checks. Native
`/repositories/<id>` URLs must match the configured repository ID and become its
admitted `/repos/OWNER/REPO` route. Issue collection pagination accepts bounded
`after` and `before` cursors; direct requests to repository-ID routes remain
unsupported. Other links, human text and unrelated metadata remain unchanged.

## Client routing and limits

Ordinary Git uses `/usr/bin/git`, which owns commands, identity, hooks, aliases,
remotes, push URLs, worktrees and native user settings. The client neither parses
Git arguments nor creates a temporary HOME.

For each generation, native preparation validates public manifest/session metadata,
identities, paths and file custody, then writes private aggregate `gitconfig`
without reading bearers or admitting sessions. Kubernetes runs it through the
private subPath after material copying; both init steps gate startup. Each
canonical HTTPS host maps to one gateway origin; conflicting origins fail
preparation. Pins cannot change an already-chosen connection origin. Same-origin
public CA inputs must agree.

A host-prefix rewrite preserves owner/repository casing and an optional terminal
`.git`. It also routes unadmitted repositories on that host to the gateway, where
the helper releases no bearer. Separately authenticated same-host use needs an
explicit native configuration override. SSH and additional-repository submodule
workflows are unsupported.

The generated defaults scope helper reset, `credential.useHttpPath=true`, verified
TLS, optional CA trust and disabled redirects to the exact gateway HTTPS origin.
The helper checks effective protocol, host/port, username and repository path;
escaped paths, dot segments, extra components and unmatched names receive no
bearer. A literal name ending in `.git` can overlap another admitted identity;
the helper compares both spellings and refuses ambiguity or alternate grants.

Duplicate repository bindings remain valid. Select one with `OCE_REPOSITORY_REF`;
gh also propagates `OCE_REPOSITORY_SELECTION` containing generation, repository
reference and session ID. Conflicting or stale pins fail remote authentication.
The helper command embeds the prepared generation and refuses newer-generation
material. It validates the selected original deadline before reading its
bearer; gateway closure can deny use earlier. Local commands skip the helper,
so they continue after expiry or with stale pins. Generation
pinning does not promise a command-wide snapshot across arbitrary subprocesses.

Native configuration can override these defaults, and additional helpers or
stores can retain credentials. The installed helper's `store` and `erase` are
inert. There is no whole-command preflight, and the client never retries an
uncertain mutation to obtain success.

The API launcher requires GitHub CLI **2.100.0**, `GH_HOST=github.com`, a gateway
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
wire and decoded limits. Exchanges have a five-minute total bound and 60-second
credential margin. The
[dispatch flow](../flows/repository-credentials.md#4-reserve-acquire-and-dispatch)
owns upstream-origin capture, adapter-header reconstruction and per-phase
client-header, response-header, connection, input and stall deadlines.
Provider actions have at most 30 seconds. On `SIGTERM` or `SIGINT`, shutdown
allows 60 seconds for cleanup before reporting unresolved obligations and terminating.
Unsettled actions retain capacity until exit; grace expiry does not establish
`DISPOSED` or confirmed revocation. Restart cannot recover the lost provider
cleanup inventory. Overrides remain positive and finite.

The [testing guide](../testing/repository-credentials.md) separates source,
artifact, container and live-provider proof; local fixtures establish neither
live GitHub compatibility nor release readiness. The
[service flow](../flows/repository-credentials.md) and
[Agent flow](../flows/agent-repository-credentials.md) own implementation.
