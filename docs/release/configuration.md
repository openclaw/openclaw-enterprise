# Release configuration

## Overview

Set up GitHub Actions, registry destinations, and native builders before
publishing containers, Helm charts, or OCC CLI binaries.

Set repository variables under **Settings → Secrets and variables → Actions**.
Set environment variables and secrets under **Settings → Environments → container-publish**.

## Build settings

| Repository variable         | Required/default                                                                | Purpose                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTAINER_NODE_BASE_IMAGE` | Required for publication and native checks invoked by `CI`; no approved default | Full Node 24 `image@sha256:...` matching `scripts/ci/test-suites/images-packaging.json` and `deploy/runtime/Dockerfile`. Use repository or organization scope: preparation has no environment. |
| `CONTAINER_AMD64_RUNNER`    | Optional; `blacksmith-16vcpu-ubuntu-2404`                                       | Native AMD64 image checks.                                                                                                                                                                     |
| `CONTAINER_ARM64_RUNNER`    | Optional; `blacksmith-8vcpu-ubuntu-2404-arm`                                    | Native ARM64 image checks.                                                                                                                                                                     |

A standalone native image check uses the selected source's checked-in CI base.

Runner overrides must select provisioned Linux runners with the matching
architecture, at least four CPUs, 12 GiB RAM, and enough disk for the build.

## Publication configuration

Protect `main`, require `CI Required`, and review workflow changes. Publication
requires the entire exact-source main-push CI run to succeed, including First Agent Smoke. Repository writers can dispatch;
there is no second-person approval or approval-comment requirement.

Create a separate `container-publish` environment: no required reviewers or wait
timer, administrator bypass disabled, and exactly one deployment rule, branch
`main`. The validator enforces the name, bypass, and branch policy, not reviewer
or timer settings. Do not reuse integration environments.

| Environment setting                                               | Required for                                             | Value                                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Variables `GHCR_CONTROLLER_IMAGE`, `GHCR_RUNTIME_IMAGE`           | Bootstrap, image publication/recovery, chart publication | Distinct full `ghcr.io/openclaw/...` names without tags or digests.                                                                               |
| Variables `DOCKERHUB_CONTROLLER_IMAGE`, `DOCKERHUB_RUNTIME_IMAGE` | Docker Hub promotion                                     | Distinct pre-existing private `docker.io/<namespace>/<repository>` names without tags or digests. Creation needs separate operator authorization. |
| Secret `DOCKERHUB_USERNAME`                                       | Promotion                                                | Account identifier; organization name for an organization access token.                                                                           |
| Secret `DOCKERHUB_TOKEN`                                          | Promotion                                                | Scoped PAT or organization access token with read/write access only to authorized destinations.                                                   |

GHCR uses the workflow's short-lived token with `packages: write`; no PAT is
required. Promotion uses `packages: read` and exposes Docker Hub credentials
only to transfer. Preparation has no environment or registry credentials.

Publication/recovery require the public Enterprise repository and pre-existing
public image packages; chart publication also needs public
`ghcr.io/openclaw/charts/openclaw-enterprise`. Confirm repository linkage and
**Manage Actions access** using the [package checks](containers.md#confirm-package-linkage).
Before making packages public, inventory retained versions and grants: every
layer/chart must be intended for public release. Visibility exposes all retained
versions and cannot revert to private; use separate destinations if needed.
[Marker bootstrap](containers.md#bootstrap-ghcr-packages) creates
private placeholders, not visibility changes or grants. Missing configuration,
conflicting identity, inaccessible metadata, or incorrect visibility stops publication.
