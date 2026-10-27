---
doc-schema-version: 1
---

# Repository credential tests

## Overview

Use these checks to verify repository credential changes at the source, package,
container, platform, or live-provider boundary. Run commands from the repository
root with Node.js 24, Git, OpenSSL, Docker, and installed workspace dependencies.
The controlled tests use disposable fixtures and do not use ambient GitHub credentials.

## Run controlled tests

```sh
node scripts/verify-repository-credentials-boundary.mjs
node --test tests/conformance/repository-credentials-fixture-ownership.test.mjs \
  tests/conformance/repository-credentials-backend-conformance.test.mjs
node --test tests/integration/repository-credentials-git.test.mjs \
  tests/integration/repository-credentials-native-paths.test.mjs \
  tests/integration/repository-credentials-service-loss.test.mjs
```

The source Git tests require a `node:24-bookworm` image and `gh` **2.103.2**
at `/usr/bin/gh`. Override these with `REPOSITORY_CREDENTIALS_NODE_IMAGE` and
`REPOSITORY_CREDENTIALS_GH_BINARY`. Missing prerequisites fail the tests. The
fixtures use a controlled provider and verified TLS; they do not prove live GitHub
access. The `gh` workflow requires the [combined qualification image](#qualify-emitted-artifacts)
because push-policy sessions require installed client hooks. Prepared token renewal
is exercised by the worker Token Service suites.

The source boundary check also runs in `pnpm check:workspace`. Changes to its
privileged allowlists require security review of the authority, caller, scope,
and negative coverage. It is a regression guard, not a sandbox or a dataflow proof.

The separate [public GitHub reader](../reference/public-github-reads.md) owns an
HTTP listener and permits anonymous HTTPS GET requests to a fixed origin. The source guard forbids imports
between the reader and credential owners; its boundary test uses a local TLS
provider. PR CI's Image Runtime Startup lane checks that stock Codex reads the
projected skill through its limited native proxy, with local binding disabled,
and returns a random title available only at the TLS provider. This needs no
model or repository credentials.

Full Integration's Gateway Routing journey checks the dedicated Agent, managed
skill, and native network path with a substituted external provider. The Agent
must return a pull request title absent from its prompt. Record a pass with no
skips on the reviewed source. The hosted lane accepts only approved main
versions; verify the full conversation and cluster policy there or in an
authorized equivalent environment.

For native selection and routing, run:

```sh
node --test tests/integration/repository-credentials-client-config.test.mjs \
  tests/integration/repository-credentials-router.test.mjs
```

### Protected repository metadata reads

`checks-baseline-2` runs the [metadata response test](../../tests/integration/protected-repository-metadata-read.test.mjs)
with the real route policy, upstream sender, and a loopback TLS origin. An independent
socket observer captures the decrypted request and the origin response through EOF.
Two client processes read through FIN and receive only the configured repository identity.

The test refuses changed routes and GET bodies before they reach the origin.
On a successful read it strips synthetic credentials reflected in headers and body.
A forbidden final trailer yields the exact `exchange-uncertain` response, while
ordinary reads still accept benign trailers. The dispatch gate is a fixture.
For authenticated sibling execution, joined authorization, and the response OpenShell
actually delivers, use the [installed custody qualification](protected-repository-custody.md).

## Verify Agent admission and durable ownership

Build before running the source and materialization checks:

```sh
pnpm build
node --test tests/integration/repository-credentials-admission.test.mjs \
  tests/integration/repository-credentials-driver.test.mjs \
  tests/integration/repository-runtime-materialization.test.mjs \
  tests/integration/repository-credentials-router.test.mjs
```

For durable session and recovery checks, prepare a migrated disposable database
with an application role as described in [PostgreSQL testing](postgresql.md).
Run `postgres-repository-sessions.test.mjs`,
`postgres-repository-broker-receipts.test.mjs`, and the relevant restart and
worker version tests with `OCC_TEST_DATABASE_URL` set. These checks do not prove
a running Kubernetes Pod or model turn.

## Qualify emitted artifacts

```sh
pnpm credentials:build
node --test tests/integration/repository-credentials-package.test.ts
```

This verifies the emitted service and client without workspace source or runtime
`node_modules`. To test those artifacts together, build both images as described in
the [operator guide](../guides/repository-credentials/standalone-service.md#container-images),
then run:

```sh
docker build --builder default --load --pull=false \
  --build-arg SERVICE_IMAGE=repository-credentials:local \
  --build-arg CLIENT_IMAGE=repository-credentials-client:local \
  -f tests/fixtures/repository-credentials/Dockerfile.qualification \
  -t repository-credentials-qualification:test .
REPOSITORY_CREDENTIALS_TEST_IMAGE=repository-credentials-qualification:test \
  node --test tests/integration/repository-credentials-container.test.mjs
```

The combined suite runs the emitted service/client cases, native Git paths, pinned
`gh` REST actions (including pull requests), and common-backend conformance against
controlled peers. It mounts only tests from the workspace and uses controlled
credentials. The client uses its installed hooks. No GitHub credentials are required.
The Compose check only renders the configuration; it does not start the services.
An unset image selector skips the container cases.

## Check the runtime image's private material volume

Build the runtime image from the candidate source and follow the
[runtime volume test prerequisites](docker.md#repository-runtime-volume-test-environment):

```sh
OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime:test \
  node --test tests/integration/repository-runtime-volume.test.mjs
```

This tests the image-installed client and Docker mounts. An unset selector skips
the test; the `images-packaging` CI lane requires it to run.

## Verify separate running containers

With both delivered images built, run:

```sh
REPOSITORY_CREDENTIALS_SERVICE_IMAGE=repository-credentials:local \
REPOSITORY_CREDENTIALS_CLIENT_IMAGE=repository-credentials-client:local \
  node --test tests/integration/repository-credentials-isolation.test.mjs
```

The test checks credential custody and Git/`gh` access through separate running
containers against a controlled provider. It does not prove network confinement
or live GitHub access. Supplying neither selector skips the test; supplying only
one fails it. Record both image IDs and the cleanup result.

## Verify prepared native Git

Run `node --test tests/integration/repository-native-cutover.test.ts` for controller
selection, real Unix control requests, prepared receipt binding, development-token
rejection and v1 recovery. This uses the in-memory State adapter and no provider.
PostgreSQL custody, old signing receiver rejection, stock images, native Git and
protected runtime behavior require separate integration evidence.

The [installed prepared Git lane](../../scripts/ci/test-suites/skipper-prepared-git-installed.json)
uses a dedicated Codex Agent in a fresh installation with controlled private Git and model peers.
Its authorized run proves the packaged sender in a real cluster; it is separate from ordinary CI.
The PostgreSQL tests cover receipt recovery and no-replay behavior, while the runtime image tests
cover stock Codex and generated client material. These checks do not replace the installed lane.

## Controller and broker image compatibility probe

Run the `image-pair-qualification` lane using the
[image-pair procedure](docker.md#repository-image-pair-qualification). It stages
current and incompatible older controller and broker images against disposable
fixtures, checks the admission protocol, and rejects incompatible pairs. It does
not prove credential disposal or a live Agent workflow. See the
[qualification test](../../tests/integration/production-image-real-qualification.test.mjs)
for fixture setup and expected probe exchanges.

## Run an authorized live smoke

Use an explicitly selected [development-token sender](../reference/repository-credentials/development-token.md)
with valid DNS and TLS on port 443, its private control socket and public CA, pinned clients,
and a disposable repository authorized for temporary branch, pull request, issue and comment
writes. Configure exactly `pushRefAllowlist: ["refs/heads/credential-smoke/*"]`:

```sh
REPOSITORY_CREDENTIALS_LIVE=1 \
REPOSITORY_CREDENTIALS_LIVE_AUTHORIZED=1 \
REPOSITORY_CREDENTIALS_LIVE_CONTROL_SOCKET=/run/credential-service/control.sock \
REPOSITORY_CREDENTIALS_LIVE_CA=/run/credential-service/public-ca.pem \
  node --test tests/integration/repository-credentials-live.test.mjs
```

This exercises a real provider through the development-token sender, not OCC Agent
admission or a model. The static token stays in the sender. The test
creates unique resources and attempts cleanup with a timeout. Ambiguous or incomplete
cleanup fails the test: reconcile the reported run marker and repository manually.
A closed session is not disposed until its active and pending credential
obligations are resolved. An unset selector skips the test; selecting it without
required authorization or inputs fails.

## Qualify an installed Agent against GitHub

The dedicated installed qualification is **disabled**. Its old automatic cleanup
could race with changes to a branch or pull request. Preparation and selected
tests fail before creating resources. Do not use that lane for qualification.

Use the [QA matrix](ci.md#qa-matrix) for an installed Agent's real Git journey. It
requires an authorized disposable repository and independent provider readback;
check the commit, the refused push outside the granted branch, credential disposal,
and cleanup results. Its `git-only` grant opens no pull request. A direct
container command or ready Pod does not prove an Agent model turn.

## Record each evidence boundary

Record the source commit, selected test and pass/fail/skip counts, artifact and
image IDs where applicable, and cleanup results. A skip is not a pass. Source,
packaged artifacts, controlled provider, separate containers, installed Agent,
and live provider results establish different things; do not substitute one for
another. Historical results apply to the artifacts that produced them.

The native package excludes App signing and token issuance. Its detached package
checks cover prepared configuration and explicit development-token clients.
The prepared native workflow is verified in
`tests/integration/postgres-prepared-repository-git-broker.test.mjs`, including
exact-ref enforcement, draft creation, response loss and no replay. That suite
requires real PostgreSQL; package checks and simulated providers do not replace it.
