# GitHub Actions cheat sheet

## Overview

Find each workflow's purpose, trigger, and failure consequences. Workflow links
open the source; manual means GitHub Actions **Run workflow**.

## Workflows

| Workflow                                                                             | What it does                                                                                                   | When it runs                                                                                                            | What failure blocks                                                                                              |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [CI](../../../.github/workflows/ci.yml)                                              | Static checks, selected test suites, and First Agent Smoke; manual runs also check native images.              | PRs, pushes to `main`, merge groups, manual.                                                                            | `CI Required` blocks merge. Failed main-push CI blocks container and CLI publication. See the distinction below. |
| [QA Matrix Advisory](../../../.github/workflows/qa-advisory.yml)                     | Codex model/UI and Calendar scenarios in both installation modes, plus OpenShell and local installation tests. | Trusted same-repository PRs and manual dispatch; Dependabot excluded.                                                   | No merge or publication gate.                                                                                    |
| [Full Integration](../../../.github/workflows/full-integration.yml)                  | Selected real-service lanes; `all` includes every selectable lane and ordinary CI suites.                      | Manual; lane-specific branch and credential requirements apply.                                                         | No merge or publication gate.                                                                                    |
| [Check Native Container Images](../../../.github/workflows/container-check.yml)      | Builds and smoke-tests controller/runtime images on native AMD64 and ARM64.                                    | Manual, manual CI, or container publication preparation.                                                                | Container publication when used by its preparation step. No merge gate.                                          |
| [Enterprise Containers](../../../.github/workflows/container-publish.yml)            | Validates exact-source CI, prepares images, and optionally publishes images and a Helm chart.                  | Manual on `main`; publication must be selected.                                                                         | Requested image/chart publication. Requires successful main-push CI and native image checks.                     |
| [Resume Container Publication](../../../.github/workflows/container-resume.yml)      | Publishes previously prepared image digests without rebuilding.                                                | Manual on `main`.                                                                                                       | Recovery publication; requires original preparation evidence and successful CI for the recovery workflow.        |
| [Promote Containers to Docker Hub](../../../.github/workflows/container-promote.yml) | Copies verified published GHCR digests to Docker Hub without rebuilding.                                       | Manual on `main`.                                                                                                       | Docker Hub promotion; requires successful GHCR publication evidence.                                             |
| [Bootstrap Container Packages](../../../.github/workflows/container-bootstrap.yml)   | Creates GHCR packages with harmless markers for initial access setup.                                          | Manual on `main`.                                                                                                       | Initial package setup; no merge gate.                                                                            |
| [Release OCC CLI](../../../.github/workflows/cli-release.yml)                        | Builds macOS/Linux AMD64/ARM64 binaries and publishes a GitHub Release.                                        | Manual on `main`.                                                                                                       | CLI publication; requires exact-source successful main-push CI.                                                  |
| [CI Image Cache](../../../.github/workflows/ci-image-cache.yml)                      | Warms the controller/runtime build cache.                                                                      | Relevant `main` pushes; hourly at minutes 07, 27, 47 UTC; manual on `main`.                                             | Cache refresh only.                                                                                              |
| [Console Storybook](../../../.github/workflows/console-storybook.yml)                | Builds and uploads static Console fixture previews.                                                            | Relevant PRs and `main` pushes; manual.                                                                                 | Preview artifact only.                                                                                           |
| [Publish private documentation](../../../.github/workflows/docs-pages.yml)           | Builds documentation/search and deploys GitHub Pages.                                                          | Every `main` push; manual on `main`.                                                                                    | That documentation deployment.                                                                                   |
| [Observability Demo](../../../.github/workflows/observability-demo.yml)              | Checks the demo Helm chart and metrics/logging stack; captures dashboards.                                     | Relevant PRs and `main` pushes; merge groups; manual.                                                                   | Demo verification and dashboard artifacts only.                                                                  |
| [CodeQL](../../../.github/workflows/codeql.yml)                                      | Scans JavaScript/TypeScript and Actions for security findings.                                                 | PRs, `main` pushes, repository publication, Mondays 03:43 UTC, manual. Private repositories need `CODEQL_ENABLED=true`. | Scan results only; no merge or publication gate.                                                                 |
| [ClawSweeper Dispatch](../../../.github/workflows/clawsweeper-dispatch.yml)          | Forwards eligible issue/PR events and command comments to ClawSweeper.                                         | Issue/PR updates and new or edited issue/PR comments.                                                                   | Event forwarding only.                                                                                           |

## Merge, publication, and deployment

`CI Required` is the required status check on `main`. First Agent Smoke is outside
that aggregate: it can fail without failing the merge gate. Container and CLI
publication require the **entire** exact-source main-push CI run to succeed, so a
First Agent Smoke failure blocks publication. QA advisory and Full Integration
are separate workflows and are not publication prerequisites.

These workflows do not automatically run integration tests for each Agent or
platform deployment. GitHub branch rules can change which checks block merge;
workflow dependencies define the publication gates above.

## Details

- [CI selection, integration lanes, and results](../../testing/ci.md)
- [QA matrix scenarios and credentials](../../testing/qa-matrix.md)
- [Container publication and recovery](../../../.github/containers.md), [chart publication](../../../.github/chart-publication.md), and [Docker Hub promotion](../../../.github/container-promotion.md)
- [CLI publication](../../../.github/cli-publication.md)
- [Storybook previews](../../contributing/console-storybook.md), [documentation hosting](../../contributing/documentation-hosting.md), and [ClawSweeper dispatch](../../flows/clawsweeper-dispatch.md)
