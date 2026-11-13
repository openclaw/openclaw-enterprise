---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Qualify a published release for staging

## Overview

Check published controller and runtime images with trusted startup tests before
considering a staging installation. The default mode checks container startup on
amd64. An optional mode stages a controller pair for a sign-in rehearsal.
Set `rehearse_signin` explicitly to install a prepared pair on a fresh, disposable runner. No mode promotes a release. See the [release guides](README.md)
for publication and recovery procedures.

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

The [workflow command](../../scripts/ci/staging-qualification.ts) checks the
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

Only the workflow commit is checked out. In the default startup job, setup, dependencies, preparation,
tests, manifests, and cleanup come from that checkout. Historical Git objects
supply only the ordinary `deploy/runtime/Dockerfile` blob, at most 64 KiB, as
inert data. The current 0.164.0 profile requires the current recipe. The reviewed
0.163.0-alpha.2 profile requires source
`54bfa7fc1b99e362450beb5f9211e164991fa7b4` and its pinned recipe hash.
Other recipes, including the October 9 0.160.0 profile, fail before pulls.
The receipt, recipe, and trusted packaging manifest must agree on the Node base.

After checking GitHub metadata, the command removes GitHub tokens before image
operations. Git and ZIP decoder subprocesses never receive those tokens. A private
Docker config supplies GHCR authentication only for digest pulls on the
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

Run [Staging Release Qualification](../../.github/workflows/staging-qualification.yml)
with the trusted `main` workflow. Supply `installation`, the full `source_sha`,
`publication_run_id`, and its exact `publication_attempt`. The publication must be
a successful manual Enterprise Containers run for that source on `main`.
The [Enterprise Containers publisher](containers.md#source-visibility)
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

## Prepare a controller pair

Supply all three optional inputs: `previous_source_sha`,
`previous_publication_run_id`, and `previous_publication_attempt`. The existing
source and publication inputs identify the candidate. A partial previous tuple
fails validation. With all three omitted and `rehearse_signin` off, the original startup job runs.

The pair job validates two ordered main publications and their underlying CI
runs and verifies each downloaded receipt before using its registry references.
It pulls only three Linux/amd64 images: the two controllers and the **previous
runtime**, which remains fixed. Each selected image needs a publication seal
with its platform manifest and config digests. An older seal without these
fields can still be used for the original single-release check. A source tag,
a local image, or a preparation-only artifact cannot substitute for a
publication receipt.

Using the local Docker image store, the job checks the root, platform manifest,
config, and revision in the exported config against the publication. It rejects
a store without platform descriptors. The existing staging environment and
read-only package permissions apply. No model or cluster credentials are needed.

After preparation succeeds, the job uploads `staging-pair-images.json` and
`staging-signin-plan.json`. These files remain available if a later installed
rehearsal fails. The plan binds the observed images to the intended
sign-in test: the source inputs must match a reviewed controller reader profile
and both releases must share its migration tree. The current profile is the v3
reader and catalog at `7e1ac6d88e3893c3d4e6444fb3b9b9776519a3fb`.
Both releases must match its production-input projection. A change to those
inputs requires a new review of the reader behavior and test expectations.
This admits only releases with that exact projection, not every v3 controller.
The publisher takes its source from the then-current `main` workflow commit.
Publish two distinct, ordered main revisions with the same intended production-input
projection, each using its own successful exact-source CI. Then review the immutable
pair and bind the matching profile before installed qualification. The profile update
may land after both publications; it creates no images or publication receipts.
A controller change between publications requires a newly reviewed compatible pair.

A later qualification workflow can use published ancestors even if its own controller
inputs have changed. For the current Codex 0.164.0 profile, its runtime Dockerfile must
still match the published recipe byte for byte, and its CI Node base pin must match
that recipe. Its chart and test harness must also remain compatible with the pair.

These artifacts establish **input preparation only**. Preparing a pair does not start
the controllers, exercise a callback or rollback, measure availability, or
write the single-release startup qualification receipt. Publish and retain the
preparatory release before merging a protocol activation when both generations
must be tested: a later dispatch of Enterprise Containers cannot select an
unpublished historical main revision. For a rehearsal publication, set
`publish: true` and choose a dedicated `image_tag` unless you intend to update
`latest` for both images. Run pair preparation while both publication receipts
are available; the publisher retains them for 30 days.

## Rehearse installed sign-in

With both publication tuples supplied, select `rehearse_signin` to run the installed
case after preparation on the same Linux/amd64 runner. Leaving it off keeps the
preparation-only path. The job creates one k3d server with its own database and
synthetic HTTPS identity provider. The cluster is separate from the configured
staging installation; no application, model or operator-cluster credentials are needed.

Both controllers and the unchanged runtime must be reachable by their verified
public digest from the node. The job also checks the exact PostgreSQL and Node
support images. It builds the fixture CLI and selects the chart from the trusted
workflow checkout. The two image generations share a populated database and
one issuer across replacements.

For two compatible v3 releases, the case checks forward and return replacement
with live, one-use collection and replay refusal. The job refuses unreviewed
production inputs, a different migration catalog, and inconclusive expiry windows.
Every receipt must be observed with positive remaining lifetime at issuance;
an already-expired control cannot establish a later expiry rejection.
Historical v2-to-v3 qualification remains unavailable: the old reader references
are incompatible with the current runtime profile. This v3-to-v3 rehearsal does
not establish that historical transition.

Only a passing selected case, complete transition evidence, a normally exited
runner with no surviving descendants, and confirmed cluster cleanup produce
`staging-signin-qualification.json`. Missing or ambiguous ownership evidence
blocks automatic cleanup. No raw identity-provider material, cluster config,
or session data is uploaded. This verifies sequential controller replacement;
it does not measure normal-ingress availability or qualify overlapping writers.

## Results and limits

The single-release job selects the controller and runtime startup files from
`images-packaging` and `images-runtime-startup`. Missing, failed, or skipped cases
fail the lane. Preparation, tests, and cleanup must succeed before the command
writes `staging-qualification.json`. The always-run upload explicitly retains
`staging-pulled-images.json`, `staging-images-packaging.json`,
`staging-images-runtime-startup.json`, and `staging-qualification.json` when
produced. An early preparation failure retains the pull receipt without a
success receipt or invented suite results.

The single-release job provides **container startup qualification on amd64**,
not an installation or rollout. The installed private Git test lane builds a
separate repository-service image and a runtime with a test CA through
[first-agent-smoke](../../scripts/ci/first-agent-smoke.mjs); the two-image
publication receipt cannot supply that installation unchanged. Full Integration
and QA Advisory retain their existing installation and provider requirements.

For an installed sign-in rehearsal, use `staging-signin-qualification.json` as
the success receipt. The pair inputs alone do not establish an installed result.

This workflow does not promote to production or prove staging readiness,
installed Agent workflows, or arm64 behavior.

## Files

- [Workflow](../../.github/workflows/staging-qualification.yml): trusted source, inputs, and artifact retention.
- [Qualification command](../../scripts/ci/staging-qualification.ts): publication validation, image selection, and startup checks.
- [Command tests](../../tests/integration/staging-qualification.test.ts): local Git and transport fixtures.
- [Packaging manifest](../../scripts/ci/test-suites/images-packaging.json) and [startup manifest](../../scripts/ci/test-suites/images-runtime-startup.json): runtime test inventories.
