# Repository credential tests

Run these tests from the repository root with Node.js 24, Git, OpenSSL, Docker,
and the prepared workspace dependencies. The fixtures generate fresh RSA and
TLS material, start bounded local upstreams, and remove their temporary files,
listeners and containers when the tests finish. They do not load ambient
GitHub credentials.

## Reuse fixtures by ownership

Fixtures under `tests/fixtures/repository-credentials/` separate data builders,
cleanup, service assembly and controlled provider behavior. Keep fault ordering,
expected values and observable assertions explicit in each scenario. Share setup
by its production owner; fixtures do not establish production authority.

The [fixture ownership checks](../../tests/conformance/repository-credentials-fixture-ownership.test.mjs)
run in `test:conformance` and the CI `checks-baseline` lane. Run them directly
with Node.js 24; they need no Docker daemon or provider credentials:

```sh
node --test tests/conformance/repository-credentials-fixture-ownership.test.mjs
```

They exercise actual subprocess cancellation and the isolation fixture's network
cleanup against controlled command responses. These checks qualify the fixture's
ownership rules; service, container isolation and live-provider proof remain in
their separate suites.

## Check source authority boundaries

Run `node scripts/verify-repository-credentials-boundary.mjs` after changing the
service. The same check runs through `pnpm check:workspace` in baseline CI. It
parses `composition/repository-credentials/`, `drivers/repo/credentials/`,
`drivers/repo/github/` and `providers/repository-credentials/` beneath
`apps/controller/src/`, plus
`repository-credentials.ts` and `repository-credentials.mjs`, using the workspace's
pinned Prettier TypeScript parser. Runtime imports and re-exports must stay within the
scanned source or use reviewed external modules and named members. Erased
`import type` and `export type` declarations remain available; inline type
specifiers can preserve a runtime module load. The two raw HTTPS sender helpers have explicit
consumer lists; the listener, private-file, signing, and client-command owners
have separate I/O allowances. New network packages, raw global network or loader
access, and new process-output owners fail the check.

Maintainers own the [source guard](../../scripts/verify-repository-credentials-boundary.mjs)
allowlists. New privileged members, owners, sender consumers or dependencies
require explicit security review: identify the authority, caller, scope and
protecting negative test. Never substitute wildcard allowances. The [guard regression test](../../tests/conformance/repository-credentials-source-boundary.test.mjs)
adds forbidden capabilities to a disposable copy of the real source tree.

The native hook dispatcher can inspect Git configuration and executable hooks,
read Git's hook input and delegate ordinary hooks. It has no direct credential-file
reader or network sender. The detached client includes the pure private
client-contract validator; negative checks protect these specific I/O boundaries.

This is an accidental-regression guard for reviewed source. It does not perform
whole-program dataflow analysis, prove that allowed owners handle secrets
correctly, or sandbox malicious code. It does not replace capability design,
runtime isolation, or the controlled and live tests below.

## Run controlled tests

```sh
node --test tests/conformance/repository-credentials-backend-conformance.test.mjs
node --test tests/integration/repository-credentials-git.test.mjs
node --test tests/integration/repository-credentials-gh.test.mjs
node --test tests/integration/repository-credentials-long-session.test.mjs
```

The client integration files create a disposable `node:24-bookworm` fixture container,
mount the source read-only and mount `/usr/bin/gh` read-only after checking its
version is exactly **2.100.0**. Override the prepared binary with
`REPOSITORY_CREDENTIALS_GH_BINARY` and the prepared Node image with
`REPOSITORY_CREDENTIALS_NODE_IMAGE`. These tests require the prerequisites and
fail if they are unavailable. They never install dependencies.

The container resolves `credentials.example.test` to its own loopback address.
Its network is disabled; every controlled service shares that loopback namespace.
The generated certificate includes that DNS SAN; clients verify it using the
generated public CA. The gateway listens on HTTPS port 443 and `gh` retains
`GH_HOST=github.com`. The generated production client configuration and launcher
own authentication, clean environment setup and the Git helper. No insecure
TLS switch or localhost `GH_HOST` substitute is used.

## Characterize service loss

```sh
node --test tests/integration/repository-credentials-service-loss.test.mjs
```

These baseline cases run the production service, GitHub factory, custody and
transports in a child process. A controlled provider survives its termination.
They prove stale-bearer denial after actual `SIGKILL` and show that lost issuance
responses remain charged while the service survives, without automatic remint.
After process replacement, the provider can still hold an unexpired token while
the service has lost its session and reservation. That observation documents the
current limit; it does not establish durable cleanup or accounting.

The fixture joins each child death and removes only its verified stale socket
before replacement. This setup does not prove automatic stale-socket recovery.
These cases use synthetic keys and controlled time, with no live GitHub, database,
Kubernetes or model execution. Safety failures and cleanup failures fail normally.

## Verify Agent admission and durable ownership

See [platform qualification](repository-credentials-platform.md#verify-agent-admission-and-durable-ownership)
for prerequisites, commands and proof limits.

## Exercise the controlled platform path

See [platform qualification](repository-credentials-platform.md#exercise-the-controlled-platform-path)
for prerequisites, commands and proof limits.

## What the controlled service tests prove

The Git upstream runs the actual `git-http-backend` against a disposable bare
repository. Contributor (`git-write`) coverage exercises clone, fetch, branch
checkout, push and PR work. Reader (`git-read`) coverage admits reads, rejects
push and REST writes before token acquisition or upstream access, and checks
that a denied push leaves remote refs unchanged. Collaborator (`git-full`)
adds ordinary issue management.
A fault case drops the response after receive-pack finishes and checks that the
service sends the push once while the remote ref records the accepted commit.

The API upstream verifies RSA signatures, App identity, current JWT time,
repository selection and complete permission maps. It maintains independent
PR, issue and comment state. The pinned CLI runs REST creation/read/update,
paginated comments and issues using native repository-ID links and opaque issue
cursors, individual comment operations and native GraphQL PR
creation. It checks bodyless deletion and unchanged human text. Unknown routes
and lost mutation responses exercise denial and no-replay behavior.

The access-level cases send requests through the real TLS listener, acquisition
and forwarding path. They cover exact permission maps, rejection of an older
grant through the private control API, bounded README/diff replies and
possible-write/no-replay accounting for Reader GraphQL. The controlled upstream
models GitHub responses; it does not establish live GitHub authorization or
installed-Agent qualification.

The alternate adapter uses a nonnumeric repository ID, nested repository path,
different native authentication and permissions, short access expiry, and a
separately bounded private renewal secret. The production service supplies
custody, original attempts, leases, settlement, expiry and finalization.
The HTTP case uses the same production listener and sender as GitHub.
Passing this test does not claim support for another production provider.

The long-session test clones once, advances trusted wall and monotonic clocks
past hour thirteen, then pushes and performs the API workflows through the same
running service and unchanged client files. The upstream checks that expired
token A receives no later authentication attempts, including rejected attempts
at the Git and API boundaries, and token B has a fresh JWT with the same
repository and profile. It then checks local closure and provider retirement
separately. There is no long sleep and no Agent-facing clock control.

The control integration suite loses an admission response through an actual Unix
socket relay, then reconciles public status with the original admission ID.
It also destroys the listener socket during construction to distinguish known
nondelivery from ambiguous response loss. Owner regressions cover delayed
settlement, frozen or adjusted wall clocks, short configured safety margins,
and cleanup retaining credential material after authentication becomes ineligible.

## Check native Git selection

The client configuration and router cases use stock Git with generated native
configuration. They cover endpoint case and optional `.git` spelling, exact
host/port/username, staged preparation, private files and CA agreement. Duplicate
bindings require explicit valid pins; stale pins, expired selections and
generation replacement release no bearer. Local hooks, aliases, moves, removals
and worktrees remain native Git behavior. Run both files directly:

```sh
node --test tests/integration/repository-credentials-client-config.test.mjs \
  tests/integration/repository-credentials-router.test.mjs
```

The real Git journey verifies committed moves/removals and upstream refs. The gh
case records native child Git through private HOME configuration. The installed
image's system include, multi-repository registry and Compute publication require
separate platform qualification; helper selection alone does not prove them.

Run the gateway normalization cases with the same prepared image and pinned gh:

```sh
node --test tests/integration/repository-credentials-native-paths.test.mjs
```

Five container cases exercise stock Git through canonical GitHub URLs with mixed
owner/repository case, with and without `.git`. They verify fetched objects,
accepted refs/content and canonical upstream paths through the real classifier,
HTTPS sender and `git-http-backend`. Cold discovery challenges issue no token;
read-only receive-pack and raw-path/API denials contact no upstream. These cases
do not establish literal-`.git` repository or multi-repository registry runtime
support. Count the child cases separately from the host wrapper.

The `repository-credentials-container` CI lane selects this file through the
[suite map](../../scripts/ci/test-suites.json), alongside the other controlled
client tests. Selected prerequisites, failures, skips and cleanup outcomes remain
part of [CI result accounting](ci.md).

## Qualify emitted artifacts

Build the final artifacts and run the detached package check first:

```sh
pnpm credentials:build
node --test tests/integration/repository-credentials-package.test.mjs
```

The builder starts from the controller's emitted code and writes separate
`.build/repository-credentials/service` and `.build/repository-credentials/client`
closures. The service includes `repository-credentials.js` and
`composition/repository-credentials/check-config.js`; the client includes
`drivers/repo/github/credentials/client/{launch,operator,git-helper,native-git,router}.js` and their
runtime dependencies. Detached loading must work without workspace source or
runtime `node_modules`.
The detached check starts the emitted service, admits and closes a session over
its Unix socket, and invokes the emitted launcher and Git helper. It also prepares
native Git configuration from staged session material, moves it to its final
path, and checks the manifest helper and router error boundary after deleting the
build workspace. This proves detached loading; installed system configuration and
ordinary-Agent routing require the platform checks. The context case rebuilds
both Docker inputs and rejects source files, compiler artifacts and linked inputs.

Build the service and client images using the
[operator guide](../guides/repository-credentials.md#container-images). Then
combine those artifacts in an owned test-only image. Use the same local Docker
builder for all three builds so it resolves the delivered input images:

```sh
docker build --builder default --load --pull=false \
  --build-arg SERVICE_IMAGE=repository-credentials:local \
  --build-arg CLIENT_IMAGE=repository-credentials-client:local \
  -f tests/fixtures/repository-credentials/Dockerfile.qualification \
  -t repository-credentials-qualification:test .
REPOSITORY_CREDENTIALS_TEST_IMAGE=repository-credentials-qualification:test \
  node --test tests/integration/repository-credentials-container.test.mjs
```

Record the source commit/tree, working-tree changes, both input image IDs and the
qualification image ID with results:

```sh
docker image inspect --format '{{.Id}} {{json .Config.Entrypoint}}' \
  repository-credentials:local repository-credentials-client:local \
  repository-credentials-qualification:test
```

The first case imports `/app/dist`, exercises the emitted production service and
client entrypoints, and uses the same long-session acceptance sequence. The
second runs alternate-backend conformance through those emitted common owners,
including renewal, private authentication, and streamed callback drainage. The
qualification image is a test driver; it is not a separate supported deployment.
Without an explicit image selector, these cases report a skip. Source test
success alone does not establish this artifact result.

The service, upstream fixtures and clients run together inside that test driver.
Passing it proves emitted-artifact composition and forwarding. The Compose case
renders `deploy/examples/repository-credentials/compose.yaml` and checks declared
mount separation; it does not start those services.

## Verify separate running containers

Select both delivered images to run the distinct isolation case:

```sh
REPOSITORY_CREDENTIALS_SERVICE_IMAGE=repository-credentials:local \
REPOSITORY_CREDENTIALS_CLIENT_IMAGE=repository-credentials-client:local \
  node --test tests/integration/repository-credentials-isolation.test.mjs
```

The harness resolves the selectors to different immutable image IDs, starts
separate service and client containers, and inspects running mounts, processes,
client files and sanitized outputs. The client receives the selected session,
public trust and workspace; service inputs, the private control socket and
sibling sessions remain outside its mounts. Actual Git and pinned `gh` use the
service against a controlled provider. This proves the tested ordinary-container
custody boundary, without a network-confinement or live-GitHub claim.

Omitting both selectors skips this case; selecting only one fails. Selected
images, Docker and other required prerequisites must be available. Record the
exact images, case results and cleanup outcome separately from the combined
qualification image and rendered Compose check.

## Record each evidence boundary

| Check                         | Evidence it can establish                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Source tests and source guard | Behavior of real owners against named protocol fixtures; reviewed import/I/O boundaries.                      |
| Detached package check        | Emitted entrypoints and runtime dependency closure without source fallback.                                   |
| Combined qualification image  | Emitted service/client composition, controlled hour-13 push/API operations and alternate-backend conformance. |
| Rendered Compose              | Declared paths and mount separation.                                                                          |
| Separate running containers   | Delivered image identity and observed client/service custody for the exercised commands.                      |
| Authorized live smoke         | Real provider behavior and cleanup for the selected repository, grant and client version.                     |

Retain selectors, versions, source/artifact/image identities, pass/fail/skip counts
and cleanup results. Missing selectors leave evidence unavailable; they do not
qualify the corresponding boundary. Historical installed or live results stay
bound to their original artifacts. After changes, record justified equivalence
for each affected assertion or rerun its owning check. These packaging checks do
not establish OCC/worker/Compute integration, an installed ordinary-Agent model
contribution, a real-time thirteen-hour soak or release readiness.

## Run an authorized live smoke

Prepare a running gateway on valid DNS/TLS port 443, its private operator socket,
and a disposable repository explicitly authorized for temporary branch, PR,
issue and comment writes. Use the exact pinned client. Select only this file:

```sh
REPOSITORY_CREDENTIALS_LIVE=1 \
REPOSITORY_CREDENTIALS_LIVE_AUTHORIZED=1 \
REPOSITORY_CREDENTIALS_LIVE_CONTROL_SOCKET=/run/credential-service/control.sock \
REPOSITORY_CREDENTIALS_LIVE_CA=/run/credential-service/public-ca.pem \
  node --test tests/integration/repository-credentials-live.test.mjs
```

The smoke admits a five-minute `git-full` session through the real control API.
It clones and pushes unique temporary branches, exercises REST and native PR
creation plus issue/comments. Before each create, it registers reconciliation
using a unique run marker and, for PRs, the unique head branch. Cleanup inspects
at most five pages of 100 resources through existing routes in the admitted
repository; it closes or deletes only a single matching owned resource. A lost
creation response never causes creation to be replayed. Missing, ambiguous or
truncated identity inspection fails cleanup and reports the run marker for
operator reconciliation.

Work commands have a 90-second overall budget and terminate their owned process
groups on timeout, output overflow or cancellation. Resource cleanup has a
separate 60-second budget. Session cleanup always runs afterward, validates the
close acknowledgement, and polls status for disposal under a 10-second polling
budget; each control request also has its production five-second deadline.
Local `CLOSED` status is distinct from `DISPOSED`: active uses, pending or
uncertain credentials, and auxiliary obligations must all resolve. Cleanup
failures fail the test and require operator review of the disposable repository. Keep provider keys and installation tokens on the
service side; the test client receives only the gateway bearer.

Without the live selector the case explicitly reports unavailable live-provider
evidence. If selected, missing authorization, socket, CA, routing or credentials
fails. Controlled upstream success proves service behavior against those
protocol fixtures; it does not establish live GitHub compatibility or a real
thirteen-hour provider soak.

## Qualify an installed Agent against GitHub

See [platform qualification](repository-credentials-platform.md#qualify-an-installed-agent-against-github)
for prerequisites, commands and proof limits.
