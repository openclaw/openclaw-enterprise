# GitHub Actions cheat sheet

## Overview

Find each workflow's purpose, trigger, and failure consequences. Workflow links
open the source; manual means GitHub Actions **Run workflow**. Set up variables,
secrets, environments, and runner overrides in [CI configuration](../../testing/ci.md#ci-configuration).

<a id="workflows"></a>

## Test actions

| Workflow or job                                                                 | What it does                                                                | When it runs                                                                                                        | What failure blocks                                                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [CI](../../../.github/workflows/ci.yml)                                         | [Required checks](../../testing/ci.md#tests-in-each-workflow)               | PRs, pushes to `main`, merge groups, manual.                                                                        | `CI Required` blocks merge. Failed main-push CI blocks container and CLI publication.            |
| [First Agent Smoke (job within CI)](../../../.github/workflows/ci.yml)          | [Basic Agent lifecycle](../../testing/ci.md#tests-in-each-workflow)         | Code/configuration PRs, pushes to `main`, merge groups, manual.                                                     | Outside `CI Required`; failure blocks container and CLI publication through failed main-push CI. |
| [QA Matrix Advisory](../../../.github/workflows/qa-advisory.yml)                | [Advisory Agent journeys](../../testing/ci.md#tests-in-each-workflow)       | Every 6 h on `main`; `main` push if enabled; trusted PR with `full-qa` or `qa-openshell-compose`; manual on `main`. | No merge or publication gate.                                                                    |
| [Full Integration](../../../.github/workflows/full-integration.yml)             | [Selected real-service suites](../../testing/ci.md#tests-in-each-workflow)  | Manual; lane-specific branch and credential requirements apply.                                                     | No merge or publication gate.                                                                    |
| [Check Native Container Images](../../../.github/workflows/container-check.yml) | [Native image qualification](../../testing/ci.md#tests-in-each-workflow)    | Manual, manual CI, or container publication preparation.                                                            | Container publication when used by its preparation step. No merge gate.                          |
| [Observability Demo](../../../.github/workflows/observability-demo.yml)         | [Monitoring demo qualification](../../testing/ci.md#tests-in-each-workflow) | Relevant PRs and `main` pushes; merge groups; manual.                                                               | Demo verification and dashboard artifacts only.                                                  |

## Other actions

| Workflow                                                                             | What it does                                                                                  | When it runs                                                                                                                            | What failure blocks                                                                                       |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Enterprise Containers](../../../.github/workflows/container-publish.yml)            | Validates exact-source CI, prepares images, and optionally publishes images and a Helm chart. | Manual on `main`; publication must be selected.                                                                                         | Requested image/chart publication. Requires successful main-push CI and native image checks.              |
| [Resume Container Publication](../../../.github/workflows/container-resume.yml)      | Publishes previously prepared image digests without rebuilding.                               | Manual on `main`.                                                                                                                       | Recovery publication; requires original preparation evidence and successful CI for the recovery workflow. |
| [Promote Containers to Docker Hub](../../../.github/workflows/container-promote.yml) | Copies verified published GHCR digests to Docker Hub without rebuilding.                      | Manual on `main`.                                                                                                                       | Docker Hub promotion; requires successful GHCR publication evidence.                                      |
| [Bootstrap Container Packages](../../../.github/workflows/container-bootstrap.yml)   | Creates GHCR packages with harmless markers for initial access setup.                         | Manual on `main`.                                                                                                                       | Initial package setup; no merge gate.                                                                     |
| [Release OCC CLI](../../../.github/workflows/cli-release.yml)                        | Builds macOS/Linux AMD64/ARM64 binaries and publishes a GitHub Release.                       | Manual on `main`.                                                                                                                       | CLI publication; requires exact-source successful main-push CI.                                           |
| [CI Image Cache](../../../.github/workflows/ci-image-cache.yml)                      | Warms the controller/runtime build cache.                                                     | Relevant `main` pushes; hourly at minutes 07, 27, 47 UTC; manual on `main`.                                                             | Cache refresh only.                                                                                       |
| [Console Storybook](../../../.github/workflows/console-storybook.yml)                | Builds and uploads static Console fixture previews.                                           | Relevant PRs and `main` pushes; manual.                                                                                                 | Preview artifact only.                                                                                    |
| [Publish private documentation](../../../.github/workflows/docs-pages.yml)           | Builds documentation/search and deploys GitHub Pages.                                         | Every `main` push; manual on `main`.                                                                                                    | That documentation deployment.                                                                            |
| [CodeQL](../../../.github/workflows/codeql.yml)                                      | Scans JavaScript/TypeScript and Actions for security findings.                                | PRs, `main` pushes, repository publication, Mondays 03:43 UTC, manual. See [eligibility settings](../../testing/ci.md#shared-settings). | Scan results only; no merge or publication gate.                                                          |
| [ClawSweeper Dispatch](../../../.github/workflows/clawsweeper-dispatch.yml)          | Forwards eligible issue/PR events and command comments to ClawSweeper.                        | Issue/PR updates and new or edited issue/PR comments.                                                                                   | Event forwarding only.                                                                                    |

## Merge, publication, and deployment

See [CI checks and gates](../../testing/ci.md#checks-and-gates) for the distinction
between required checks and advisory jobs. [Publication configuration](../../release/configuration.md#publication-configuration)
explains release prerequisites; these workflows do not gate every Agent/platform deployment.

## Details

- [CI selection, integration lanes, and results](../../testing/ci.md)
- [QA matrix scenarios and credentials](../../testing/ci.md#qa-matrix)
- [Container publication and recovery](../../release/containers.md), [chart publication](../../release/chart-publication.md), and [Docker Hub promotion](../../release/container-promotion.md)
- [CLI publication](../../release/cli-publication.md)
- [Storybook previews](../../contributing/console-storybook.md), [documentation hosting](../../contributing/documentation-hosting.md), and [ClawSweeper dispatch](../../flows/clawsweeper-dispatch.md)
