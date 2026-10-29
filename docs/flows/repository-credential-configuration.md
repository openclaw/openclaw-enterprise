---
created: 2026-09-18
updated: "2026-10-22"
last_updated_session: "authoring-run/1a8f6b59-50b6-4282-a383-5f45e22aa461"
---

# Repository credential configuration flow

## Overview

The repository credential composition loader validates operator-selected
configuration, prepared registry policy, and TLS files before returning a frozen
configuration owner. In Kubernetes projection mode, the sidecar derives the
broker origin from its trusted deployment argument before protected loading. The
standalone `--check-config` entry point still requires an explicit origin,
reports a nonsecret summary, and closes that owner. This flow stops before
provider requests or listener startup.

## Entry Points

- Trigger: `node scripts/render-repository-credentials-origin.mjs --release NAME --namespace NAME --values FILE`
  before issuing the Kubernetes broker certificate.
- Trigger: `pnpm credentials:check-config /absolute/path/service.json`.
- Source: `scripts/render-repository-credentials-origin.mjs`,
  `apps/controller/src/composition/repository-credentials/projected-inputs.ts:prepareProjectedInputs`,
  `apps/controller/src/composition/repository-credentials/check-config.ts:checkConfiguration`,
  and `apps/controller/src/composition/repository-credentials/config.ts:loadConfiguration`.
- Assumptions: Node 24, prepared build output, operator-selected absolute paths,
  and the ownership and permission policy in the [reference](../reference/repository-credentials.md#configuration).

## Flow

```mermaid
graph TD
  Input["<b>Operator configuration</b><br/>Absolute protected path"] --> Ancestors["<b>Validate ancestors</b><br/>Root to immediate parent"]
  Projection["<b>Kubernetes inputs</b><br/>Selected generations"] --> Snapshot["<b>Check and copy inputs</b><br/>Private regular files"]
  Expected["<b>Deployment origin</b><br/>Trusted sidecar argument"] --> Snapshot
  Snapshot -->|invalid projection or identity| Reject
  Snapshot -->|protected snapshot| Ancestors
  Ancestors -->|unsafe owner, mode or symlink| Reject["<b>Reject configuration</b><br/>No provider call"]
  Ancestors -->|trusted path| File["<b>Open protected file</b><br/>Bound size and identity"]
  File -->|changed or invalid| Reject
  File -->|valid JSON| Backend["<b>Validate backend and registry</b><br/>Require compatible policy"]
  Backend -->|incompatible policy| Reject
  Backend -->|compatible| Material["<b>Load selected authority and TLS</b><br/>Repeat protected reads"]
  Material -->|invalid material| Reject
  Material -->|validated| Owner["<b>Construct selected owner</b><br/>Freeze configuration"]
  Owner -->|configuration check| Summary["<b>Return safe summary</b><br/>Close owned material"]
  Owner -->|service startup| Service["<b>Service composition</b><br/>Own material lifetime"]
  classDef input fill:#F1EEF5,stroke:#A091AD,color:#3A3243,stroke-width:1px
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  classDef blocked fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  class Input,Projection,Expected input
  class Snapshot,Ancestors,File,Backend,Material,Owner,Summary,Service operation
  class Reject blocked
```

## Execution Trace

### 1. Render the Kubernetes broker origin before preparing TLS

`scripts/render-repository-credentials-origin.mjs:renderedBroker`

The operator renders the Helm chart after selecting `repositoryCredentials`
values and before issuing the broker certificate. The helper reads the rendered
worker sidecar's `--public-origin` argument and returns that origin, hostname,
Service name, release, namespace, and Backend ID. Certificate issuance uses that
hostname as its DNS SAN, so the chart-rendered origin remains the input for TLS
material, startup, and later Agent session material. The helper does not derive
a second hostname policy; Helm validation owns the supported Service settings.

Helm always renders an explicit worker Deployment strategy. Disabled installs use
the Kubernetes default RollingUpdate values, `maxSurge: "25%"` and
`maxUnavailable: "25%"`. Broker-enabled installs render `strategy.type:
Recreate` and omit `rollingUpdate`, allowing server-side apply to remove the
previous RollingUpdate fields before Kubernetes validates the Recreate strategy.
Older disabled releases that did not explicitly own the RollingUpdate fields
must first refresh with the current disabled chart and no active Agent sessions,
then opt in to repository credentials. Existing broker-enabled installs already
use Recreate.

### 2. Snapshot Kubernetes inputs when selected

`apps/controller/src/composition/repository-credentials/projected-inputs.ts:prepareProjectedInputs`
and `apps/controller/src/composition/repository-credentials/protected-file.ts:readProtectedFile`

Kubernetes startup reads `config.json`, TLS files and registry from the
currently selected projected-volume generation. The projection layer fills an
absent `gateway.publicOrigin` from the trusted `--public-origin` deployment
argument. If operators provide `gateway.publicOrigin`, it must match that
argument exactly. The same projection check verifies that the serving certificate
covers the derived full Service FQDN before copying any projected input into the
private runtime directory.

The protected loader requires a normalized absolute path and validates its directory
ancestors in root-to-leaf order. Each accepted prefix therefore protects the
next path component against replacement by another local user. Ancestors must
be directories owned by root or the service user. Group/other writes fail except
for a root-owned sticky ancestor above the immediate parent. The immediate
parent remains unwritable by those users.

The loader opens the final basename without following symlinks. It checks the
file owner, mode, link count, type, and size. It reads at most one byte beyond
the checked file size. It then compares the open file with the named inode and
its original metadata. Invalid or replaced
files fail before their contents become configuration. The reader retains ownership
of its candidate buffer until descriptor closure and transfer succeed. It clears
scratch bytes and any candidate that cannot be transferred, including on a close
failure. Success transfers an independent buffer to its caller; failure returns
no filesystem details. Configuration maps
that failure to `invalid-configuration` and clears successfully returned bytes.

### 3. Validate configuration and construct material owners

`apps/controller/src/composition/repository-credentials/config.ts:loadConfiguration`

Composition rejects `github-app` and `github-app-registry` before opening any
App key. The fixed error tells operators to stop admissions and drain accepted
work on its original owner before switching. The replacement process cannot
continue an old owner's uncertain issuance or replay its PR creation.

Production native startup requires `github-prepared-git-registry`. Pure registry
validation checks the Backend identity; the prepared factory requires one exact
ref and an approved transport. Installation-wide access requires the protected
Credential Proxy and fails native startup. Composition validates the private
worker socket path and trusted upstream origins, then loads TLS. It constructs
`warm-registry-factory.ts:createPreparedGitHubRegistryFactory`, which consumes
READY material and has no App key or issuer capability. The worker Token Service
retains issuance and cleanup ownership.

`github-token` is the explicit development alternative. It requires
`--development-authority`, an eight-hour session cap, and the configured push
input bound. The same protected reader loads its token; composition removes one
trailing newline and constructs `GitHubStaticTokenOwner`. Failure clears owned
buffers. The returned configuration owns its TLS and selected factory.

### 4. Close validation material or hand it to service startup

`apps/controller/src/composition/repository-credentials/check-config.ts:checkConfiguration`

The check returns the gateway origin, configured profiles, maximum session
duration, authority and, for the token kind, its token class. Its `finally` block closes the material owner, and the CLI prints only
the safe summary. It creates no session, listener, or provider request.
The Kubernetes check similarly closes the loaded owner before reporting success;
it also rejects a shutdown grace beyond the Pod's allowed service cleanup window.
Normal startup instead passes the owner to
`apps/controller/src/composition/repository-credentials/service.ts:runService`,
which retains it until startup failure or process shutdown. The
[service flow](repository-credentials.md) owns that lifetime.

## Debugging and Verification

Follow the build and configuration commands in the
[operator guide](../guides/repository-credentials.md). Success prints JSON with
`valid: true`; failure prints `invalid-configuration`. Inspect every ancestor
when safe-looking files still fail validation. A shared writable deployment
directory can permit substitution of an otherwise private configuration tree.

Run the configuration and emitted-package cases in the [testing guide](../testing/repository-credentials.md).
They exercise generated TLS files and the actual loader. They establish
startup validation, not live GitHub behavior or platform integration.

## Related docs

- [Repository credential reference](../reference/repository-credentials.md)
- [Repository credential operator guide](../guides/repository-credentials.md)
- [Repository credential tests](../testing/repository-credentials.md)
- [Credential service startup and shutdown](repository-credentials.md)
- [Platform architecture](../design.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-16 19:18: Record prepared-only registry rejection on the request-time App backend. (authoring-run/1a8f6b59-50b6-4282-a383-5f45e22aa461 - 6c8adb9779d6819a4d4794c8754d7b6017aba89a)

- 2026-10-04 08:00: Add the development-only GitHub token authority branch, its process flag, and the authority summary. (gh-token-impl - github-token-authority)

- 2026-09-27 12:14: Record the server-side apply strategy ownership path for broker-enabled worker Recreate upgrades. (cody/01a0e42f-3192-76d1-89b6-4bec0cb00e64 - 181b0472f9a5)

- 2026-09-27 11:53: Document the Helm-rendered broker origin helper before Kubernetes projection snapshotting. (cody/01a0e42f-3192-76d1-89b6-4bec0cb00e64 - 181b0472f9a5a9d422035edf5121d3a15c200cb5)

- 2026-09-25 23:47: Derive the Kubernetes broker origin from the sidecar deployment argument and validate the projected TLS host. (public authoring-run/656293f4-5523-4894-8d65-6c69b3bc5dee - 7e310b74)

- 2026-09-19 23:54: Reconcile RepoDriver ownership, private status projection, and separate emitted service/client paths. (public authoring-run/73c80a5e-4d0c-4e72-b989-0cf9963c6593 - e5b5a5489f078d08272523476bdbcd0b9162c946)

- 2026-09-19 21:29: Move configuration ownership to composition and document return-buffer ownership through descriptor close. Verify composed source. (public authoring-run/a55f804b-53b3-40df-a5d5-b6a2f425544b - 5d8329753f4e17402f619d392acc8fc3d112f620)

- 2026-09-18 18:51: Separate protected-file reading from configuration assembly while preserving validation and disposal. (source `d29fac7d363eb1cfb3dab6306a81cc3b8daf395d`)

- 2026-09-18 03:32: Document protected ancestor validation and configuration ownership with the accompanying security correction (source `2d4877aaf438c919a2240109cb2e7067e4d75b4d`)
