# Repository credentials

Repository bindings give an Agent bounded Git HTTPS and selected GitHub API
access. OCC freezes authorized grants into its revision; the worker prepares
runtime material. The separate credential service retains App signing keys,
JWTs and installation tokens. The Agent receives gateway bearers, client
configuration and public CA trust. Start with the
[operator guide](../guides/repository-credentials.md).

The bundled platform path supports Kubernetes Compute-owned embedded OpenClaw
with `api_key` Harness authentication and no Sandbox Driver. It requires one
worker/credential-service owner; Helm uses `Recreate` to avoid overlapping
owners. Dedicated Harnesses and other Compute topologies reject repository-bearing
revisions. Agents without bindings retain their existing lifecycle.

Trusted startup loads protected configuration into the separate service process;
backend construction and sender callbacks remain private. Session controls are
`open`, `status`, `close`, and `shutdown`. Separate service and Git/gh artifacts
keep signing and service modules out of the client. `SIGTERM` or `SIGINT` starts
bounded cleanup and disposal.

## Repo Driver contract

The optional `repo` capability uses `RepoDriver extends Driver`, with the bundled
`GitHubRepoDriver`. Trusted Installation `drivers.repo` and GitHub Provider
`drivers.repo` select the same configured Driver ID. The
[shared contract](../../packages/contracts/src/repo.ts) exposes four operations:

- `resolve` checks Namespace policy and returns admitted bindings and duration.
- `open` returns `created` with private runtime files, `recovered` with status
  only, or `missing`. `recoverOnly` cannot create authority.
- `status` returns the current observation or authoritative absence.
- `close` stops local authority and reports closure or absence; it does not
  promise remote revocation or runtime termination.

Public status contains only `sessionId`, `state`, `deadlineWallMs` and `binding`
(`providerInstanceId`, `repositoryId`, `grantId`). Each response is an immutable
snapshot after complete private validation. Cleanup counters and configuration
decoding remain private. Status cannot regenerate the closed-schema Git/gh files.

`maintenanceIntervalMs` schedules worker reconciliation; it is not a measured
withdrawal bound. Configured IDs, `AgentRevision.repositoryCredentials` and
persisted `admitted_spec.repository_credentials` retain their meaning.

State derives immutable Driver, Provider, profile and grant context from the
admitted revision. It retains original Namespace, Agent, revision, admission and
session identities and deadlines after Agent deletion, without bearers or tokens.

Agent deletion closes sessions and retires Compute. Physical deletion and live
revision detachment require every attempt to be `disposed`. `CLOSED`, missing
inventory and `invalidated` attempts retain cleanup Work and the deleting Agent.
Deadlines do not settle provider cleanup. Evidence pruning and durable token
recovery are unimplemented.

Worker restart can retain surviving service sessions and Compute material.
Known closing sessions block same-revision replacement, including Compute repair,
with retryable `REPOSITORY_CLEANUP_PENDING` until confirmed `DISPOSED`. Existing
Work bounds and the original revision deadline still apply. Missing exposed
sessions remain irrecoverable: `REPOSITORY_SESSION_RECOVERY_UNSAFE` fails the
revision and queues runtime retirement while retaining cleanup. Never-delivered openings
without a recorded session ID remain recoverable; known sessions require disposal
before replacement. Users may explicitly deploy a new authorized revision. This
neither settles old cleanup nor replays Git/API mutations; credential disposal
does not establish their outcomes.

## Configuration

### Canonical platform registry

The GitHub Provider selects one registry through `configuration.registryPath`;
its `drivers.repo` names the selected Driver. API, worker and
service load the same immutable, versioned ConfigMap. The registry contains
nonsecret identity and Namespace policy for one App installation and multiple
repositories:

```json
{
  "version": 1,
  "providerId": "repository-provider",
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

Use actual platform Namespace IDs. App, installation and repository IDs are
positive decimal safe integers represented as strings. Repository names are
canonicalized to lowercase. The registry admits at most 128 repositories, 128
Namespace policies per repository and 4,096 policies overall. References, numeric
repository IDs and canonical names must be unique.

The resolved grant fingerprint covers provider/App/installation identity,
repository identity, maximum duration, Namespace, its complete allowed-profile
set, optional push-ref policy, selected profile and exact permission contract.
The service independently resolves and compares
that fingerprint before admission. A changed policy cannot preserve an older
grant merely by keeping the same reference.

Each Namespace policy may set an optional
[`pushRefAllowlist`](repository-credentials/push-ref-guardrail.md) to prevent
accidental native Git pushes outside selected branches. This is not server-side
branch authorization.

The selected Driver configuration supplies `controlSocket`,
`sessionDurationSeconds` and `publicCaPath`; it contains no App key. See
[Provider configuration](providers.md) and the
[installation procedure](../guides/deploy/production-installation.md) for wiring.

### Profiles

Choose **Reader** (`git-read`) for code and issue/PR reads, **Contributor**
(`git-write`, the API default) for pushes and PR work, or **Collaborator**
(`git-full`) for issue management too. The configuration values remain unchanged;
Reader and Contributor now include API access, not just Git.

The [access-level reference](repository-credentials/access-levels.md) defines the
exact permissions, supported commands and GraphQL boundary. Every session selects
one repository. Writable levels are not a promise that an Agent cannot merge:
GitHub rules still govern protected branches. Administration, workflow editing,
Actions control and secrets permissions are not requested. Missing App permissions
fail without widening the grant.

### Standalone service inputs

A protected JSON file supplies `gateway`, `sessionPolicy`, `backend` and optional
positive safe-integer `limits`. The service validates configuration before
listening. Configuration and private keys must be regular files owned by root or
the service user, with private permissions. Every directory ancestor must have
one of those owners and reject group/other writes. A root-owned sticky ancestor
such as `/tmp` is allowed above the immediate parent; the immediate parent must
always reject group/other writes. Symlinks and file replacement during loading
are rejected. See the [configuration flow](../flows/repository-credential-configuration.md)
for validation and key ownership. For standalone single-repository operation:

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

The identifiers are examples. Production upstream origins are fixed to
`github.com` and `api.github.com`. Registry mode instead uses backend fields
`kind: "github-app-registry"`, `providerId`, `registryFile` and `privateKeyFile`;
all repository policy comes from that registry, and unbound admission is refused.

Kubernetes composition copies selected projection generations into service-owned
private files before protected-path validation. API and worker receive
registry/public CA inputs; only the service receives App and TLS private keys.

The privileged GitHub transport captures the installation, repository and exact
permission profile when the backend is constructed. Its only operations are
issuance for that captured scope and revocation of an owned token; callers cannot
supply an HTTP URL, method, path, request body or extra headers. Extending those
operations changes a credential boundary and requires security review.

The service image must trust GitHub's HTTPS certificate chain. For an approved
private CA, supply an image with a readable CA bundle and `NODE_EXTRA_CA_CERTS`;
keep certificate and hostname verification enabled.

Git discovery, upload-pack and receive-pack accept case differences in the
admitted owner/repository and an optional `.git` suffix. The backend constructs
a canonical upstream path; a literal `.git` repository name remains part of the
admitted identity. Endpoint names, methods, media types, service queries and
profile restrictions still apply. API request paths and repository authority
remain unchanged.

## Sessions and closure

The trusted worker or local operator uses HTTP over a private mode-0600 Unix socket:

| Request                                                           | Response                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `POST /v1/sessions` with `durationSeconds` and optional `profile` | Private status, client configuration and bearer once        |
| `GET /v1/sessions/{id}`                                           | Private session and cleanup status                          |
| `POST /v1/sessions/{id}/close`                                    | Immediate local closure status; cleanup reported separately |

The socket's parent is private to the service/operator. It is never mounted into
the client. Control bodies are limited to 16 KiB. The HTTPS client listener has
no admission or close endpoint.

`X-Admission-Id` combines a 13-digit Unix-millisecond timestamp, hyphen and
lowercase UUIDv4. The CLI prints this nonsecret ID before dispatch. HTTP 201
returns the bearer once; matching ID/duration/profile returns HTTP 200 with
status only. Conflicts fail. Follow
[lost-response recovery](../guides/repository-credentials.md#recover-an-admission)
before explicitly requesting replacement material.

Platform admission additionally requires `namespaceId`, `repositoryRef`,
normalized `profile`, `expectedBinding` and `deadlineWallMs`. Replays must match
all original fields. `recoverOnly: true` may return status or
`admission-missing`, never create a session. A missing lookup fences a delayed
first-open using that still-fresh ID. Capacity or transport failure remains an
error, not evidence of absence.

Unseen IDs must be less than 60 seconds old, never future-dated. Process-local
correlations, including tombstones, are bounded to twice the session limit;
churn can return `overloaded`. Existing correlations retain status beyond that
window and session deadline while cleanup is unresolved. Disposal or authoritative
absence permits reclamation. Unknown stale IDs cannot create sessions:
lookup returns `admission-missing`; absent-session status returns `not-found`.
Correlations retain no recoverable bearer and do not survive restart.

Session duration is independent of token lifetime. On-demand replacement uses
the original grant and requires validity through the remaining exchange budget
plus safety margin. Idle sessions need no periodic mint. The original bearer
works throughout the session while its process and upstream authorization survive.

Authentication eligibility and terminal cleanup expiry are separate deadlines.
Both use elapsed monotonic time from the original capture; delayed acquisition
settlement cannot extend either. The GitHub adapter allows 60 seconds of provider
clock skew and conservatively stops authentication before the reported expiry.
Cleanup retains the one-hour bound from local receipt. A forward wall-clock
change can deny authentication but cannot establish remote expiration.

Closing or expiring a session prevents new use immediately and cancels owned
exchanges. `CLOSED` does not imply confirmed revocation. Private control status
distinguishes pending, revoked, expired and uncertain credentials, plus auxiliary cleanup.
`DISPOSED` requires settled actions, resolved access-token obligations and
completed auxiliary finalization; historical revoked/expired counters may remain
nonzero. An uncertain issuance blocks automatic minting.
An uncertain push or API mutation is never automatically replayed.

Failed admission can also retain cleanup work. If session construction fails,
renewal access closes immediately; retained material remains counted against
session capacity and shutdown's `pendingAuxiliary` until admitted callbacks
finish and their material is disposed.

## GitHub response data

Bounded REST JSON responses omit the provider's `temp_clone_token` from the
repository object, its `parent` and `source` repository relationships, and
pull-request `head.repo` and `base.repo` objects. Human text and unrelated
metadata remain unchanged. Qualified machine links still pass through the
existing origin, repository, route, and profile checks before gateway rewriting;
other informational links remain data.

## Client routing and limits

Ordinary Git uses `/usr/bin/git` and native configuration. Git owns commands,
identity, hooks, aliases, remotes, push URLs, worktrees, and user settings.
The client does not parse Git arguments or create a temporary HOME. The operator's
single-session launcher remains available and adds the same scoped defaults to
stock Git.

For a delivered generation, the native preparer reads the staged public manifest
and session metadata, validates identities, final paths and private file metadata,
and writes a private aggregate `gitconfig`. It does not read bearer contents or
admit sessions. The supported automatic routing profile maps each canonical
HTTPS host to one gateway origin. Distinct origins for one canonical host fail
preparation; an environment pin cannot change the connection origin after Git
has chosen it. Same-origin public CA inputs must agree.

A host-prefix rewrite preserves owner/repository casing and an optional terminal
`.git`. It also routes unadmitted repositories on that host to the gateway, where
the helper releases no bearer. Separately authenticated same-host use needs an
explicit native configuration override. SSH and additional-repository submodule
workflows are outside supported acceptance.

The generated defaults scope helper reset, `credential.useHttpPath=true`, verified
TLS, optional CA trust and disabled redirects to the exact gateway HTTPS origin.
The helper checks the effective protocol, host/port, username and repository path;
escaped paths, dot segments, extra components and unmatched names receive no
bearer. A literal repository name ending in `.git` can overlap another admitted
identity, so the helper compares both spellings and refuses ambiguous selection.
It never chooses a first, stronger or unexpired alternate grant.

Duplicate repository bindings remain valid. Select one with `OCE_REPOSITORY_REF`;
gh also propagates `OCE_REPOSITORY_SELECTION` containing generation, repository
reference and session ID. Conflicting or stale pins fail remote authentication.
The helper command embeds the prepared generation and refuses material from a
new generation. It validates the selected original deadline before reading its
bearer; gateway closure can deny use earlier. Local commands continue after
expiry or with stale pins because they do not consult the helper. Generation
pinning does not promise a command-wide snapshot across arbitrary subprocesses.

Native user configuration can override these defaults, and caller-added helpers
or credential stores can retain credentials. The feature installs no cache/store
helper; its `store` and `erase` operations are inert. There is no whole-command
preflight or guarantee that every request in a multi-request command fails before
any allowed request executes. An uncertain mutation is never retried by the
client to obtain a successful result.

The API launcher requires GitHub CLI **2.100.0**, `GH_HOST=github.com`, a gateway
hostname with verified TLS, and HTTPS port 443. Its private `hosts.yml` uses the
experimental `api_host` routing option and stores only the gateway bearer in
`oauth_token`. Supported API calls use relative endpoint paths. The launcher
admits the selected [read and contribution commands](repository-credentials/access-levels.md#supported-commands);
browser flows, extensions, absolute API destinations and arbitrary command
compatibility are excluded.
Response rewriting is limited to validated pagination links and explicitly
followed resource fields. Native `/repositories/<id>` response URLs must match
the configured repository ID and are rewritten to its admitted `/repos/OWNER/REPO`
route. Issue collection pagination accepts bounded `after` and `before` cursors;
direct requests to repository-ID routes remain unsupported.
Informational labels, milestones, nested repository
metadata and human-authored content remain unchanged. Each listener and sender
captures its permitted upstream origins at construction. The sender rejects
ambiguous or malformed adapter headers before dispatch, then supplies canonical
authority, framing and connection headers within the configured header bounds.
Routing configuration is not network egress confinement.

Default service bounds are 16 sessions including pending cleanup, two credential
slots per session, one provider action and 64 queued actions, 64 sockets per
listener, and 32 exchanges total and four per session. Headers are limited to 32 KiB/64 pairs;
request targets to 8 KiB. Git fetch input is 1 MiB; push input and Git output are
256 MiB. API input is 1 MiB and response data 8 MiB. Git gzip input has independent
wire and decoded limits. Exchanges have a five-minute total bound and 60-second
credential margin. HTTPS client header timing begins on the TLS socket after
the handshake and ends when an authenticated request reserves exchange capacity;
the exchange deadline bounds acquisition and forwarding. The upstream
response-header deadline starts after upload finishes, unless the response
headers already arrived. Connection, input and stall deadlines remain independent.
Provider actions have at most 30 seconds. Shutdown allows
60 seconds for cleanup before reporting unresolved obligations and terminating.
Unsettled actions retain capacity until exit; grace expiry does not establish
`DISPOSED` or confirmed revocation. Restart cannot recover the lost provider
cleanup inventory. Overrides remain positive and finite.

The [testing guide](../testing/repository-credentials.md) separates source,
artifact, container and live-provider proof. Local fixtures establish neither
live GitHub compatibility nor release readiness. See the
[service flow](../flows/repository-credentials.md) and
[Agent flow](../flows/agent-repository-credentials.md) for implementation ownership.
