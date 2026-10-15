# Qualify repository credential artifacts

These checks extend the [repository credential tests](repository-credentials.md) to emitted packages, delivered images and running containers. Use the same prerequisites and record results with that page's [evidence boundaries](repository-credentials.md#record-each-evidence-boundary).

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
[operator guide](../guides/repository-credentials/standalone-service.md#container-images). Then
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

## Check the runtime image's private material volume

Run the separate [runtime volume test](images.md#repository-runtime-volume-test-environment)
against an image built from the candidate source:

```sh
OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime:test \
  node --test tests/integration/repository-runtime-volume.test.mjs
```

The required `images-packaging` lane runs this case with the image-installed
client and no detached bundle overlay. It checks both initializers, a root-owned
fsGroup-style tmpfs parent, private subPath mounts, ownership rejection, retry
and read-only delivery. An unset selector skips standalone execution; the CI
lane rejects skips. See the linked image guide for Docker prerequisites and
proof limits.

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

A second case runs the same sequence against the
[development token authority](../reference/repository-credentials/development-token.md):
the trusted provider container writes a random static token to the service's
input mount, and the service starts with `--development-authority`. The host
compares the probe snapshot, Git configuration (with and without the session
launcher), client and service logs and full `docker inspect` output against the
token and patterns derived from it (its random body, its base64 form and the
encoded Git credential). Nothing derived from the token is passed into the client
container. Positive controls show that the probe sees the selected session's bearer
and that the compared patterns include the token the service read. The case also
checks that nothing was issued and that closing the session never revokes the
owner's token.

Omitting both selectors skips this case; selecting only one fails. Selected
images, Docker and other required prerequisites must be available. Record the
exact images, case results and cleanup outcome separately from the combined
qualification image and rendered Compose check.
