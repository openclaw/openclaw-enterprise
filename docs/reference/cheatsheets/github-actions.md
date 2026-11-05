# GitHub Actions cheat sheet

## Overview

Find each workflow's purpose, trigger, and failure consequences. Workflow links
open the source; manual means GitHub Actions **Run workflow**. Use [CI configuration](../../testing/ci/configuration.md) for test environments
and runner overrides. Publication and preview settings belong to their linked guides.

<a id="workflows"></a>

## Test actions

| Workflow or job                                                                 | What it does                                                              | When it runs                                                                                                        | What failure blocks                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [CI](../../../.github/workflows/ci.yml)                                         | [Required checks](../../testing/ci/required-checks.md)                    | PRs, pushes to `main`, merge groups, manual.                                                                        | `CI Required` blocks merge. Failed main-push CI blocks container and CLI publication.            |
| [First Agent Smoke (job within CI)](../../../.github/workflows/ci.yml)          | [Basic Agent lifecycle](../../testing/ci/first-agent-smoke.md)            | Code/configuration PRs, pushes to `main`, merge groups, manual.                                                     | Outside `CI Required`; failure blocks container and CLI publication through failed main-push CI. |
| [QA Matrix Advisory](../../../.github/workflows/qa-advisory.yml)                | [Advisory Agent workflows](../../testing/ci/qa-advisory.md)               | Every 6 h on `main`; `main` push if enabled; trusted PR with `full-qa` or `qa-openshell-compose`; manual on `main`. | No merge or publication gate.                                                                    |
| [Full Integration](../../../.github/workflows/full-integration.yml)             | [Selected real-service suites](../../testing/ci/full-integration.md)      | Manual; lane-specific branch and credential requirements apply.                                                     | No merge or publication gate.                                                                    |
| [Check Native Container Images](../../../.github/workflows/container-check.yml) | [Native image checks](../../testing/ci/required-checks.md#scenarios)      | Manual, manual CI, or container publication preparation.                                                            | Container publication when used by its preparation step. No merge gate.                          |
| [Observability Demo](../../../.github/workflows/observability-demo.yml)         | [Monitoring demo tests](../../testing/ci/observability-demo.md)           | Relevant PRs and `main` pushes; merge groups; manual.                                                               | Demo verification and dashboard artifacts only.                                                  |
| [Local k3d Quickstart](../../../.github/workflows/k3d-quickstart-e2e.yml)       | [Browser onboarding, Linear, and Git](../../testing/ci/k3d-quickstart.md) | Manual on protected `main`; approved development-branch push matching the reviewed commit.                          | Quickstart result only; no merge gate.                                                           |

## Other actions

| Workflow                                                                              | What it does                                                                                                                      | When it runs                                                                                                            | What failure blocks                                                                                       |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Staging Release Qualification](../../../.github/workflows/staging-qualification.yml) | [Published-image startup checks](../../testing/ci/staging-qualification.md)                                                       | Manual on protected `main`.                                                                                             | Qualification result only; no merge gate.                                                                 |
| [Enterprise Containers](../../../.github/workflows/container-publish.yml)             | Validates exact-source CI, prepares images, and optionally publishes images and a Helm chart.                                     | Manual on `main`; publication must be selected.                                                                         | Requested image/chart publication. Requires successful main-push CI and native image checks.              |
| [Resume Container Publication](../../../.github/workflows/container-resume.yml)       | Publishes previously prepared image digests without rebuilding.                                                                   | Manual on `main`.                                                                                                       | Recovery publication; requires original preparation evidence and successful CI for the recovery workflow. |
| [Promote Containers to Docker Hub](../../../.github/workflows/container-promote.yml)  | Copies verified published GHCR digests to Docker Hub without rebuilding.                                                          | Manual on `main`.                                                                                                       | Docker Hub promotion; requires successful GHCR publication evidence.                                      |
| [Bootstrap Container Packages](../../../.github/workflows/container-bootstrap.yml)    | Creates GHCR packages with harmless markers for initial access setup.                                                             | Manual on `main`.                                                                                                       | Initial package setup; no merge gate.                                                                     |
| [Release OCC CLI](../../../.github/workflows/cli-release.yml)                         | Builds macOS/Linux AMD64/ARM64 binaries and publishes a GitHub Release.                                                           | Manual on `main`.                                                                                                       | CLI publication; requires exact-source successful main-push CI.                                           |
| [CI Image Cache](../../../.github/workflows/ci-image-cache.yml)                       | Warms the controller/runtime build cache.                                                                                         | Relevant `main` pushes; hourly at minutes 07, 27, 47 UTC; manual on `main`.                                             | Cache refresh only.                                                                                       |
| [Console Storybook](../../../.github/workflows/console-storybook.yml)                 | Builds and uploads static Console fixture previews.                                                                               | Relevant PRs and `main` pushes; manual.                                                                                 | Preview artifact only.                                                                                    |
| [Publish private documentation](../../../.github/workflows/docs-pages.yml)            | [Builds documentation/search and deploys GitHub Pages](../../contributing/documentation-hosting.md#deploy-private-documentation). | Every `main` push; manual on `main`.                                                                                    | That documentation deployment.                                                                            |
| [CodeQL](../../../.github/workflows/codeql.yml)                                       | Scans JavaScript/TypeScript and Actions for security findings.                                                                    | PRs, `main` pushes, repository publication, Mondays 03:43 UTC, manual. See [eligibility settings](#codeql-eligibility). | Scan results only; no merge or publication gate.                                                          |
| [ClawSweeper Dispatch](../../../.github/workflows/clawsweeper-dispatch.yml)           | Forwards eligible issue/PR events and command comments to ClawSweeper.                                                            | Issue/PR updates and new or edited issue/PR comments.                                                                   | Event forwarding only.                                                                                    |

### CodeQL eligibility

Public repositories need no `CODEQL_ENABLED` setting. For private repositories,
set that Actions repository variable to `true` only after approved, licensed
Code Security advanced setup.

## Merge, publication, and deployment

See [CI checks and gates](../../testing/ci.md#checks-and-gates) for the distinction
between required checks and advisory jobs. [Publication configuration](../../release/configuration.md#publication-configuration)
explains release prerequisites; these workflows do not gate every Agent/platform deployment.

## Details

- [CI selection, integration lanes, and results](../../testing/ci.md)
- [QA matrix scenarios and credentials](../../testing/ci/qa-advisory.md)
- [Container publication and recovery](../../release/containers.md), [chart publication](../../release/chart-publication.md), and [Docker Hub promotion](../../release/container-promotion.md)
- [CLI publication](../../release/cli-publication.md)
- [Storybook previews](../../contributing/console-storybook.md), [documentation hosting](../../contributing/documentation-hosting.md), and [ClawSweeper dispatch](../../flows/clawsweeper-dispatch.md)
