# Release configuration

## Overview

Configure access once before you publish images, a Helm chart, or the OCC CLI.
Protect `main`, require `CI Required` for merge, and review workflow changes.
**Release OCE** requires the dispatcher's approval through
[`integration-main-approval`](../testing/ci/configuration.md#environments). A full release
requires Full Integration; [image-only publication](README.md#publish-images-only) skips
that suite and requires native image checks.
Keep provider credentials in the integration environments. The standalone image
and CLI workflows instead require a successful entire `main` push CI conclusion
and successful `CI Required` job for the exact source. First Agent Smoke must
succeed when selected.

Create a separate `container-publish` environment with no required reviewers or
wait timer, administrator bypass disabled, and exactly one deployment rule:
branch `main`. The validator checks the name, bypass, and branch policy.
Do not reuse integration environments.

Set repository variables under **Settings → Secrets and variables → Actions**.
Set publication environment variables and secrets under
**Settings → Environments → container-publish**.

## Build settings

| Repository variable         | Requirement                                                                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTAINER_NODE_BASE_IMAGE` | Required for Enterprise Containers preparation/publication and CI native checks. Full Node 24 `image@sha256:...` matching the packaging manifest and runtime Dockerfile; no approved default. Repository or organization scope is required because preparation has no environment. |
| `CONTAINER_AMD64_RUNNER`    | Optional; defaults to `blacksmith-16vcpu-ubuntu-2404`.                                                                                                                                                                                                                             |
| `CONTAINER_ARM64_RUNNER`    | Optional; defaults to `blacksmith-8vcpu-ubuntu-2404-arm`.                                                                                                                                                                                                                          |

Runner overrides must select native Linux runners of the correct architecture
with at least four CPUs, 12 GiB RAM, and sufficient disk. Runtime smoke uses a
fresh native runner with the same override. A standalone native check uses the
selected source's checked-in CI base. The [CI Image Cache workflow](../../.github/workflows/ci-image-cache.yml)
does not publish images.

## Publication configuration

| Setting                                                 | Scope and use                                                                                                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GHCR_CONTROLLER_IMAGE`, `GHCR_RUNTIME_IMAGE`           | Environment variables; distinct full `ghcr.io/openclaw/...` image names without tags or digests. Required for bootstrap, publication, recovery, and chart publication. |
| `DOCKERHUB_CONTROLLER_IMAGE`, `DOCKERHUB_RUNTIME_IMAGE` | Environment variables; distinct, pre-existing private `docker.io/<namespace>/<repository>` destinations. Repository creation needs separate authorization.             |
| `DOCKERHUB_USERNAME`                                    | Environment secret; account identifier, or organization name for an organization access token.                                                                         |
| `DOCKERHUB_TOKEN`                                       | Environment secret; scoped PAT or organization access token with read/write access only to authorized destinations.                                                    |

GHCR publication uses the short-lived workflow token with `packages: write`;
no personal access token is needed. Promotion uses `packages: read` and exposes
Docker Hub credentials only to transfer. No-push preparation has no environment
or registry credentials, but its uploaded images are available to repository
readers.

Real publication and recovery require the public Enterprise repository and
public GHCR image packages. Chart publication also requires public
`ghcr.io/openclaw/charts/openclaw-enterprise`. Before changing visibility,
inventory retained versions and grants: making a package public exposes every
retained version and cannot be reversed. Use separate destinations if needed.
Do not grant this public repository Actions access to private packages containing
material that must remain private.

## Confirm package linkage

For each destination, open **Package settings**. Confirm that the connected
repository is `openclaw/openclaw-enterprise`, visibility is **Public**, and
**Manage Actions access** grants that repository the required access. Source
labels alone do not prove linkage.

GitHub can omit the package's repository metadata. The publisher checks identity
and public visibility and rejects explicit conflicting linkage. If metadata is
omitted, the operator's package-setting check remains necessary.

## Bootstrap GHCR packages

Confirm that the organization permits package creation under the configured
names. After the reviewed [bootstrap workflow](../../.github/workflows/container-bootstrap.yml)
is on `main` and its exact push CI succeeds, dispatch **Bootstrap Enterprise
Container Packages** on `main` with `ci_run_id`.

The workflow creates private scratch image markers and a nondeployable chart
marker. It leaves matching existing packages unchanged and rejects conflicting
metadata. Its summary records the package coordinates and verified marker digests.
The unique `bootstrap-<run-id>-<attempt>` tags and chart marker are not
deployable. An authenticated metadata 404 permits only the harmless marker push;
it does not prove the package is absent. Other metadata errors stop bootstrap.
Bootstrap does not make packages public or grant access. Inspect any partial
result, correct the cause, then dispatch again; valid packages remain unchanged.
Finish the linkage and visibility checks before publication. See the
[bootstrap flow](../flows/container-package-bootstrap.md) for validation details.

Public GHCR pulls need no workstation login. Private marker packages and private
mirrors require separate pull credentials.
