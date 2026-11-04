---
kind: reference/ci
tags: [human_verified]
---

# Qualify a published release for staging

## Overview

Check published controller and runtime images with trusted startup tests before
considering a staging installation. This workflow qualifies container startup on
amd64; it does not install or promote a release.

<a id="when-it-runs"></a>

## Trigger

Manual dispatch from protected `main` in `openclaw/openclaw-enterprise`. Runs for
the same configured installation share a concurrency group. The workflow is not
a PR merge gate.

## Scenarios

The runner checks the published controller and runtime images using the
`images-packaging` and `images-runtime-startup` files. It also validates the
publication evidence and image identity before executing those startup checks.

### Source and credential constraints

The [workflow command](../../../scripts/ci/staging-qualification.ts) checks the
trusted checkout against the workflow SHA, protected same-repository `main`,
local workflow ancestry in `main`, and release ancestry in the workflow commit.
It requires the exact successful Enterprise Containers run and attempt, a
successful image publication job for that source, and one unexpired publication
artifact. Dispatch IDs must be positive safe decimal integers. Source IDs must
be full lowercase Git SHAs.

The named artifact download retains an archive. Before reading it, the command
repeats producer checks and compares its size and SHA-256 with GitHub metadata.
The archive directory must contain exactly one regular file, at most 1 MiB.
The command passes the verified archive bytes to Python 3's standard ZIP decoder
on the runner. It reads only `publication.json`, at most 64 KiB, without
extracting files or passing a GitHub token. The receipt must match a successful
same-repository `main` push returned by the CI workflow's source-SHA query.
Only service-derived run IDs and attempts select the exact CI run and job checks.
The script does not write Actions outputs.

Only the workflow commit is checked out. Setup, dependencies, preparation,
tests, manifests, and cleanup come from that checkout. Historical Git objects
supply only the ordinary `deploy/runtime/Dockerfile` blob, at most 64 KiB, as
inert data. The current 0.164.0 profile requires the current recipe. The reviewed
0.163.0-alpha.2 profile requires source
`54bfa7fc1b99e362450beb5f9211e164991fa7b4` and its pinned recipe hash.
Other recipes, including the October 9 0.160.0 profile, fail before pulls.
The receipt, recipe, and trusted packaging manifest must agree on the Node base.

After checking GitHub metadata, the command removes GitHub tokens before image
operations. Git and ZIP decoder subprocesses never receive those tokens. A private
Docker config supplies GHCR authentication only for the two digest pulls on the
runner's local Docker socket. The command removes that config before inspection
or startup. A failed pull reports the reference and access guidance without
printing subprocess output.

The command verifies each pulled digest, Linux amd64 platform, and source label,
then passes the exact local image IDs to trusted tests. It rechecks source labels
before smoke preparation. The selected profile's Codex version controls the real
seccomp probe and explicit runtime-suite expectations; normal CI retains 0.164.0
assertions. The runner records the workflow SHA as its test source, while the
pull receipt records the historical image source separately. No historical host
code is built or executed. Historical images receive only the existing isolated
fixture mounts, not the runner workspace, Docker socket, or Actions credentials.

<a id="run-it"></a>

## Execution

Run [Staging Release Qualification](../../../.github/workflows/staging-qualification.yml)
with the trusted `main` workflow. Supply `installation`, the full `source_sha`,
`publication_run_id`, and its exact `publication_attempt`. The publication must be
a successful manual Enterprise Containers run for that source on `main`.
The [Enterprise Containers publisher](../../release/containers.md#source-visibility)
issues receipts only for public GitHub Container Registry (GHCR) packages.
Private and internal packages are ineligible even if the package names match or
the qualification token has read access.
Active qualification runs are not cancelled by a later dispatch.

Configure the `staging-qualification` environment with `STAGING_INSTALLATION`,
`GHCR_CONTROLLER_IMAGE`, and `GHCR_RUNTIME_IMAGE`.
The installation input must equal the configured ID. Use an ID of 1–63 lowercase
letters, digits, or hyphens, starting with a letter. GHCR values are explicit
`ghcr.io/openclaw/` repositories without tags or digests. Restrict this environment
to `main`. The qualification job authenticates the two image pulls with its
workflow token, which has `packages: read`. The job uses a disposable runner-local
k3d fixture and needs no staging cluster configuration or provider credentials.

For local command coverage, run:

```sh
node --test tests/integration/staging-qualification.test.ts
node scripts/ci/run-tests.mjs audit
```

The command test uses local Git history and independent GitHub and Docker
transport fixtures. It checks digest handoff, credential isolation, hostile
Actions output paths, archive tampering, rejection before pulls, and a real
preparer failure before any suite. Hosted token permissions, registry pulls,
container startup, and live installations need separate proof.

## Results and limits

The runner selects the controller and runtime startup files from
`images-packaging` and `images-runtime-startup`. Missing, failed, or skipped cases
fail the lane. Preparation, tests, and cleanup must succeed before the command
writes `staging-qualification.json`. The always-run upload explicitly retains
`staging-pulled-images.json`, `staging-images-packaging.json`,
`staging-images-runtime-startup.json`, and `staging-qualification.json` when
produced. An early preparation failure retains the pull receipt without a
success receipt or invented suite results.

This is **container startup qualification on amd64**, not an installation or
rollout. The installed private Git test lane builds a separate repository-service
image and a runtime with a test CA through
[first-agent-smoke](../../../scripts/ci/first-agent-smoke.mjs); the two-image
publication receipt cannot supply that installation unchanged. Full Integration
and QA Advisory retain their existing installation and provider requirements.
This workflow does not promote to production or prove staging readiness,
installed Agent workflows, or arm64 behavior.

## Files

- [Workflow](../../../.github/workflows/staging-qualification.yml): trusted source, inputs, and artifact retention.
- [Qualification command](../../../scripts/ci/staging-qualification.ts): publication validation, image selection, and startup checks.
- [Command tests](../../../tests/integration/staging-qualification.test.ts): local Git and transport fixtures.
- [Packaging manifest](../../../scripts/ci/test-suites/images-packaging.json) and [startup manifest](../../../scripts/ci/test-suites/images-runtime-startup.json): runtime test inventories.
