# Implementation plan: install with precreated administrator credentials

- **ID:** TASK-0053
- **Delivery status:** In progress
- **Owner:** Authentication and installation packaging maintainers
- **Authority:** [Platform architecture](../../docs/design.md),
  [authentication](../../docs/reference/authentication.md), and
  [installation procedures](../../docs/guides/deploy.md).
- **Source baseline:** `71d6c90bba4bed1ccf03cdb8d426df0a228bc7e8`.

## Outcome and scope

Operators supply the initial human administrator password and service administrator
API key before initialization. Kubernetes installations use an existing Secret;
Compose and direct initialization use protected files. Fresh installation requires
no bootstrap PersistentVolumeClaim (PVC), permission-preparation Pod, reader Pod,
or credential extraction from a completed container.

Keep the shared initializer, separate migrator and application database roles,
Better Auth authentication, native IAM identities and bindings, initial `default`
Namespace, queued reconciliation, and bootstrap audit. The initializer still runs
before the API and worker.

This standalone task replaces the credential delivery approach recorded in
[the bootstrap service-administrator plan](16-bootstrap-admin-service-account/index.md).
Preserve that historical record. Coordinate overlapping installation tooling with
[TASK-0050](0050-production-deployment-tooling.md), without changing its recovery
receipts or taking over other authors' work.

Do not add a new platform primitive, Driver contract, public key-import endpoint,
secret-manager client, production deployment profile, database schema, or automatic
credential rotation. Ordinary service-key issuance continues to generate keys.
Planning does not authorize implementation or live deployment.

## Selected contract

### Inputs and credential ownership

Add two initializer-only settings, required for fresh development and production
initialization:

| Setting | Producer and consumer |
| --- | --- |
| `OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE` | Installer supplies the human password file; bootstrap passes its contents to account creation. |
| `OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE` | Installer supplies the API-key file; bootstrap registers its hash against the new service Principal. |

These initializer-only inputs replace, rather than reinterpret, the former
`OCC_BOOTSTRAP_PASSWORD_FILE` or `OCC_BOOTSTRAP_SERVICE_KEY_FILE`, which designate
outputs. Remove those output settings and reject their use with a clear,
non-secret diagnostic. Do not retain an output mode or silently generate missing
credentials inside bootstrap.

Inputs are absolute paths to UTF-8 text files. Accept no terminator or one final
LF or CRLF; remove only that terminator, not password spaces. Reject embedded line
breaks, NUL, invalid UTF-8, and empty values. Read at most 4 KiB per file and reject
larger inputs. Apply the existing account password limits. Generate bootstrap API
keys as `occ_` followed by the unpadded base64url encoding of 32 cryptographically
random bytes; validate that format when importing. Format validation cannot prove
entropy: installers must use a cryptographic generator. Never use the password as
the API key.

Read and validate both inputs before creating an account or key. Support read-only
Kubernetes projected Secret files, including their normal symlink layout. Check
that the opened target is a regular readable file; do not copy the existing
output writer's no-symlink or parent-ownership requirements onto Secret inputs.
Host installers must restrict source-file access to the identities that need it.
Bootstrap must not print contents or include them in errors, logs, audit, or output.

### Authentication and lifecycle

Create the service Principal UUID and administrator Role binding through the
existing native IAM seed. Register the supplied key against that identity through
the authentication owner, preserving Better Auth's hash format, key verification,
Installation metadata, revocation, and 30-day expiration from registration time.
Store no plaintext key in the database. Keep the current independent human and
service identities and their separate bindings to the shared administrator Role.

An existing Installation uses the existing administrator-verification path without
reading credential files, resetting passwords, importing another key, extending
expiry, restoring grants, or requiring retained bootstrap input storage. Editing
a source Secret or file is not rotation. Normal account and service-key operations
remain the recovery and rotation owners.

Keep one-attempt initialization and explicit failure. Better Auth persistence and
Installation/IAM commit remain separate; precreated credentials do not make them
atomic. Preserve safe attempt identifiers on failure and require reconciliation
before retry after partial or uncertain effects. Do not add automatic cleanup,
retry, account reuse, or key reassignment. Concurrent attempts must not overwrite
another attempt's account, key ownership, or committed Installation.

### Kubernetes and non-Kubernetes delivery

Replace the chart's password-PVC settings with `bootstrap.credentials.secretName`,
`passwordKey` (default `admin-password`), and `serviceKeyKey` (default
`admin-service-key`). Project those two keys read-only at a fixed bootstrap-only
mount. Put only paths and Secret references in Helm values, not plaintext.

The Secret must exist in the release namespace before the pre-install hook runs.
Do not generate credentials with Helm template randomness or create an ordinary
chart Secret that would arrive after the hook. Document cryptographic generation
into private local files followed by Secret creation with `--from-file`; an
external secret manager can supply the same Secret. Keep initializer Kubernetes
token automount disabled and add no Secret API permissions.

Project credentials only on fresh chart installation, not on upgrade. Upgrades
must work without the Secret. Neither the migration container nor API/worker
containers receive the bootstrap credentials. Retention belongs to the operator;
bootstrap does not delete the source Secret or files.

Compose mounts the same inputs as secrets into its bootstrap service only. Direct
runs use protected paths; systemd or other secret managers can materialize those
files. These are initialization mechanisms, not new production support claims.
Existing development setup tools generate and retain credentials outside the
checkout before invoking Compose or Helm, so default setup gains no manual
extraction step. They can translate the configured development password into a
file without passing plaintext to the initializer's environment.

Keep `OCC_SERVICE_KEY_FILE` and `--key-output` usable. The Go client currently reads
`data.key` without requiring issued-key metadata. Setup tooling can create that
JSON locally from its precreated key, then validate it with `occ installation get`.
Update instructions that demand a complete issuance response for this bootstrap
case. Do not fabricate key IDs, expiry, or Installation IDs. Where tooling needs
metadata, obtain it from confirmed non-secret initialization results or authenticated
API responses. A locally prepared file is not proof of successful installation.

## Implementation

### 1. Support supplied credentials through authentication and bootstrap

- Inspect the pinned `@better-auth/api-key` implementation and establish its
  supported supplied-key or generation-extension mechanism. Confirm hashing,
  uniqueness, metadata, and expiration with the real PostgreSQL adapter. This
  planning checkout had no installed dependency graph. Implementation verified
  the current lockfile's 1.7.18 `customKeyGenerator` extension. Do not implement a guessed plugin option or hand-write its SQL.
- Add a server-only supplied-key registration path in
  [the auth owner](../../apps/controller/src/auth/index.ts). Keep supplied material
  out of public service-key request schemas and routine issuance. Prefer the
  smallest supported plugin extension; if none exists, record the dependency
  change needed before completing this step.
- Replace generation and output in
  [bootstrap](../../scripts/bootstrap-installation.mjs) and its
  [configuration loader](../../scripts/lib/bootstrap-configuration.ts) with the
  selected input contract. Preserve existing Installation verification, IAM seed,
  transactional Namespace creation, audit, and commit-uncertainty handling.
- Remove bootstrap-only output code from
  [bootstrap-output.ts at the source baseline](https://github.com/openclaw/openclaw-enterprise/blob/81ab0a9fbe38cd2eea88f599a5e0ac9aad9c4f92/apps/controller/src/composition/bootstrap-output.ts)
  once its callers are removed. Do not remove protected writers used by normal
  CLI issuance or other features. Keep public package exports curated.

### 2. Remove storage and extraction from supported installation callers

- Update [Helm values](../../deploy/helm/openclaw-enterprise/values.yaml),
  [Job templates](../../deploy/helm/openclaw-enterprise/templates/jobs.yaml), chart
  helpers and configuration validation. Remove bootstrap PVC requirements and
  mount-path assumptions while retaining database and workload storage.
- Update [profile rendering](../../scripts/render-installation-profile.ts) and
  [production examples](../../deploy/examples/production/) to reference the input
  Secret. Remove `bootstrap-pvc.yaml` and
  [prepare-bootstrap-volume at the source baseline](https://github.com/openclaw/openclaw-enterprise/blob/81ab0a9fbe38cd2eea88f599a5e0ac9aad9c4f92/scripts/prepare-bootstrap-volume), their
  dedicated reader/preparation manifests, and active callers. Preserve unrelated
  NetworkPolicies, PostgreSQL PVCs, and Agent storage.
- Update [Compose](../../compose.yaml), active overlays, and
  [scripts/dev-up](../../scripts/dev-up). Remove `occ_bootstrap_data`, container
  copying, and output-volume permission setup. Prepare private credential inputs
  before startup and keep them stable during the installation attempt.
- Update [Go development setup](../../internal/occdev/up.go) and
  [Kubernetes development setup](../../internal/occdev/openshell_k3d.go): generate
  inputs before startup; create the Secret before Helm; remove bootstrap storage,
  preparation and reader Pods; retain the local CLI key file. Update state,
  cancellation, and cleanup handling only for resources these tools own.
- Update installation diagnostics, first-Agent/operator-session helpers, CI setup,
  and [real Helm test installation](../../tests/helpers/production-helm-real.ts).
  Keep receipt identity and failed-attempt evidence intact. Search active source
  and documentation for old output paths and extraction instructions. Historical
  specs and archived records remain unchanged.

### 3. Update current documentation with implementation

[Authentication](../../docs/reference/authentication.md) owns the new behavior;
[service API keys](../../docs/reference/authentication/service-api-keys.md) owns
key use and recovery. Update development/production settings, CLI bootstrap-file
instructions, installation profiles, production preparation, quickstarts, and
operator-session snippets. Replace extraction with source-Secret access or the
operator's retained files. Keep password and key handling beside installation.
Explain that a key expires after registration and is not renewed by upgrades.

Update the existing
[bootstrap flow](../../docs/flows/local-password-authentication.md),
[service-key flow](../../docs/flows/service-api-keys.md), and affected startup/setup
flows with real source pointers. Amend the architecture's statement that the
initializer mounts credential *output*: that interaction becomes credential
*input*, which a reference-only update would leave inaccurate. Keep this edit
concise. Update environment-variable cheat sheets and affected navigation/layout
entries when removing helpers and examples. Do not add database migration or
PVC-deletion procedures. Do not delete an operator's retained PVC automatically.

## Verification

Implementation requires integration proof, not new tests for this plan. Extend
existing suites before adding files; use `*.test.ts` and register any new file
with its owning CI lane. Apply the test-audit skill during test work.

| Required outcome | Current evidence | Remaining proof |
| --- | --- | --- |
| Both supplied credentials authenticate; hashes, identity and expiry persist across auth instances | PostgreSQL bootstrap, human-authentication and service-key suites; OpenShift human and key Installation reads passed | None for this boundary |
| Invalid inputs create no auth or Installation state | Real PostgreSQL initializer: 20 input-validation subtests passed; OpenShift projected Secret inputs worked | Independent permission-denied file case |
| Reruns, concurrency and uncertain commits preserve state | PostgreSQL bootstrap-failure suites passed; absent inputs do not rotate credentials; losing attempts preserve ownership; unknown COMMIT is reconciled | None for this boundary |
| Revocation and current IAM govern imported keys | Real PostgreSQL/API revocation, removed grants, unknown keys, rotation and rerun checks passed | None for this boundary |
| Helm needs no bootstrap storage or extraction | OpenShift initializer and API/worker ran without bootstrap PVC or preparation/reader Pods; both identities authenticated; upgrade without the Secret preserved key identity/expiry; release/log scans found no credential values | Automated retained-Job and k3d proof remain unrun |
| Regular Agent workflows retain genuine model turns, cutover and authorization | Existing production TUI and Compose setup callers updated | Genuine runtime proof needs authorized model credentials and selected images. Current Docker Compose deployment is deliberately refused; do not invent a supported model-turn path |
| Local setup retains private files, `--key-output`, cancellation and owned cleanup without leaking or mounting credentials into API/worker | Real `scripts/dev-up` Compose startup, human sign-in and CLI Installation read passed; inputs and CLI key were `0600`, bootstrap mounts read-only, API/worker/migration had no inputs; Go cancellation/cleanup suites passed | Full Kubernetes development setup remains unrun |

Follow [PostgreSQL](../../docs/testing/postgresql.md),
[Docker](../../docs/testing/docker.md), and
[Kubernetes testing](../../docs/testing/kubernetes.md) prerequisites. Real-runtime
proof needs approved images, authorized model credentials, and disposable scoped
resources; missing infrastructure is a verification gap, not permission to use a
fake. Extend the owning CI lane definitions and run the CI selection audit.

Before implementation handoff, run applicable typecheck, lint, formatting,
workspace, Go, documentation, and spec checks. Record tested commits, commands,
passes, skips, and proof limits here. No product tests run for plan-only authoring.

## Delivery record

Implementation uses Better Auth API Key 1.7.18's supported `customKeyGenerator`
in an initializer-only auth instance. The plugin owns hashing and insertion;
the existing unique constraint protects ownership. Ordinary issuance is unchanged.
Bootstrap, Compose, Helm, development tools, current documentation and verification
callers now use precreated inputs. [Authentication](../../docs/reference/authentication.md#installation-and-account-ownership)
owns the current contract. No Driver contract or schema changed.

Verification used the uncommitted worktree based on
`81ab0a9fbe38cd2eea88f599a5e0ac9aad9c4f92`, Node 24.22.1 and pnpm 11.15.1:

- `node scripts/ci/prepare.mjs --lane postgres-platform` and `--lane postgres-auth`
  prepared isolated lanes, then their `--file` selections. Suites ran with
  `node --env-file=<private prepared environment> --test <selected suite>`;
  `node scripts/ci/cleanup.ts --state <owned state>` completed each cleanup.
  Per-file application roles, separate migrators and recorded-state cleanup: 147 tests passed across bootstrap failures,
  production startup, readiness, service-account compensation, accounts, human
  authentication, service keys and password profiles. The additional service-key
  dependency suite passed separately, including supplied-password sign-in,
  persisted hashing/30-day expiry and rerun without inputs.
- Development/profile suites: 233 passed, one unselected 300-second timeout case.
  Packaging: 97 passed, one production-image worker-probe skip in a clean
  temporary source snapshot (`9804d07755dfea49495c70cd374c88d313864789`).
  The working-copy run's source-identity check correctly refused its dirty chart;
  snapshot dependencies were installed separately to preserve module identity.
  `go test ./...`, `pnpm cli:check`, typecheck and lint passed. Real `scripts/dev-up` Compose startup, human sign-in,
  CLI access, credential isolation/private-file checks and owned `occ dev down
  --volumes` cleanup passed; a separate real Compose cleanup test passed.
  These are not model-turn evidence.
- OpenShift: built and pushed a unique controller tag (private registry omitted),
  digest `sha256:41b645c1477e7c79f22e21960aea25676515993ec043d976800fd4c316370301`.
  `helm install --wait` completed initialization and reached API/worker readiness;
  `helm upgrade --wait --set bootstrap.credentials.secretName=` exercised reuse. Human sign-in and both Installation reads returned 200; an unknown
  key returned 401. Upgrade without the bootstrap Secret succeeded, retained key
  identity/expiry, and projected no credential volume or input environment.
  Source Secret values were absent from collected logs and rendered release
  resources. Both identities also authenticated after upgrade using the operator's
  retained inputs. An earlier image run found test DNS-selector and gateway-Secret-key
  mistakes; the final image installed without those setup failures. Only owned resources were removed, including
  the chart-retained installation-secret Namespace; kubeconfig/context were unchanged.

`pnpm format:check`, `pnpm check:workspace`, `pnpm docs:check`, documentation
length and flow checks, and `node scripts/ci/run-tests.ts audit` passed.
The plan exceeds 1,500 words because its contract, caller changes and proof form
one workflow; it remains below the hard limit.

Delivery remains **In progress** until the remaining proof above is complete.
The cluster proof used an existing UID-1000 SCC through run-scoped bindings; it
is not a new OpenShift deployment profile. No genuine Agent/model-turn or
multi-architecture image evidence is claimed. Keep this plan together because
its input contract, caller changes and proof describe one installation change.

## Manual Notes

## Changelog

- 2026-11-16 10:20 -06:00: Implemented precreated inputs and recorded PostgreSQL,
  setup and OpenShift proof with remaining runtime limits. Source:
  `81ab0a9fbe38cd2eea88f599a5e0ac9aad9c4f92` plus accompanying changes; session:
  `01a1e4f4-3138-71b5-b224-7ecf7ed57406`.

- 2026-11-13 16:43 -06:00: Created the plan for precreated credential inputs and
  removal of bootstrap storage and extraction. Source: `71d6c90bba4bed1ccf03cdb8d426df0a228bc7e8`;
  session: `01a1d6a3-9398-720a-b96d-7fb8bd5a551e`.
