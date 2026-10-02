# Feature Spec: First Enterprise container release

**Date:** 2026-09-21
**Status:** Implementing
**Owner:** Enterprise release maintainers

## Problem and Decision

Publish the first controller and combined gateway/Agent runtime images through
the existing protected GitHub Actions release workflow. Add a separate, manually
approved workflow that bootstraps GHCR packages with harmless marker images;
keep Enterprise source publication restricted to verified private packages.
The current [publisher](../../scripts/ci/container-release.mjs) requires packages
to exist before transferring source-bearing images, so it cannot initialize them.

The initial release uses immutable `sha-<full-source-sha>` tags and digest
references. Package and chart version `0.1.0` do not establish an approved
SemVer release. Git tags, GitHub releases, `latest`, additional platforms, public
distribution, Docker Hub promotion, and cluster deployment are outside this change.
Before a production release, resolve the SecOps-only ownership prerequisite in
[CODEOWNERS](../../.github/CODEOWNERS); this first image proof is not a stable-production claim.

## Scope

- Add a protected Actions bootstrap path using the job's short-lived package
  credential; no workstation package token is required.
- Complete the existing environment, package-linkage, destination, and exact-CI
  prerequisites, then run and verify the first private publication.
- Update the [operator procedure](../../.github/containers.md) and document the
  bootstrap flow. Preserve both Dockerfiles, release gates, and chart defaults.
- Replace each retried CI lane's earlier result artifact so exact-source CI
  aggregates the successful retry instead of stale failure evidence.

## Contract

The repository remains private. An operator owns the dedicated `container-publish`
environment and its selected reviewers: self-approval and administrator bypass
are disabled, and the sole deployment policy permits branch `main`. Configuration
and dispatch do not substitute for the independent review required by that environment.

Two distinct environment variables select packages in the `openclaw` organization:
`GHCR_CONTROLLER_IMAGE` and `GHCR_RUNTIME_IMAGE`. The configured coordinates are
`ghcr.io/openclaw/openclaw-enterprise-controller` and
`ghcr.io/openclaw/openclaw-enterprise-runtime`. A metadata 404 with an unscoped personal
credential does not prove a package is absent.

Bootstrap runs only from trusted `main`, after exact-source successful main-push
CI and environment approval. It builds a scratch image from a temporary directory
containing only a fixed non-sensitive marker and repository labels. It never
copies the checkout into an image. Existing destinations must already be private;
explicit repository metadata must match this private repository. Valid existing packages are left unchanged.
An authenticated 404 permits a marker push only, followed by required private
visibility and digest verification. Post-push metadata 404s receive five bounded
retries; other API failures stop the run. GHCR can omit repository metadata, so
marker bootstrap does not establish linkage. Before real-image publication or
promotion, missing linkage metadata requires the independent environment
reviewer's recorded confirmation of live package settings, bound to the package,
repository, source, current run and attempt. The [operator procedure](../../.github/containers.md#confirm-package-linkage)
defines the evidence; explicit conflicting metadata always fails. Bootstrap
never changes visibility, grants, or Enterprise source tags. Its unique
`bootstrap-<run-id>-<attempt>` tag is not a deployable release.

The regular publisher retains the [existing contract](../../.github/containers.md):
source equals the selected trusted workflow revision; the real CI workflow's
main-push run and `CI Required` aggregate succeed for that source; the approved
Node digest matches CI and the runtime recipe. Both `linux/amd64` OCI archives
pass startup smoke before their bytes, source, run, CI attempt, and base image
are sealed. After approval, publication rechecks these facts and private package
metadata, copies exact digests, and rejects conflicting source tags.

The controller image serves OCC; the runtime image packages OpenClaw `2026.9.1`,
its Codex and Slack plugins `2026.9.1`, and Codex `0.152.1` as currently declared
in the [runtime recipe](../../deploy/runtime/Dockerfile). Deployment consumers use
the publication receipt's digest references, not the bootstrap tag or chart version.

## Implementation

1. Add a separate bootstrap workflow and helper under `.github/workflows/` and
   `scripts/ci/`. Reuse the publisher's repository, CI, environment, destination,
   and package validators. Keep package writes behind environment approval and
   share the existing publication concurrency lock. Add focused failure checks
   to the existing release-gate test ownership; update the runbook and flow.
2. An operator configures the protected environment and approved coordinates,
   verifies private package-creation policy, and dispatches bootstrap after the
   reviewed workflow merges and its exact main CI succeeds. An independent
   reviewer approves. Verify both package identities and Actions access.
3. Select current `main` and its successful exact-source CI. Dispatch Enterprise
   Containers with `publish=true`; independently approve the prepared bytes.
   Record workflow URL, source SHA, both tags/digests, platform, and receipt.
4. Pull the published digests where authorized access exists and verify the
   existing startup checks against those images. Store evidence durably before
   Actions expires its seven-day archives and 30-day publication receipts.

Two-image publication is not atomic. On partial failure, inspect both destinations
before retrying. Preserve already-published source tags; a fresh build may resolve
different runtime dependencies and must fail on a digest conflict. Use the protected [recovery workflow](../../.github/containers.md#recover-a-partial-publication)
to resume from the original retained archives after fixing the cause. Recovery
separately verifies current workflow CI and original image CI, preserves the
producer seals, and requires a fresh independent approval. Expired archives
cannot be rebuilt under an existing source tag with different bytes. Never relax privacy or approval
checks to complete a release.

## Verification

| Required outcome                     | Proof                                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Correct source and approval          | Exact main CI URL and SHA; live environment metadata; independent approval record.                                                             |
| Harmless bootstrap                   | Review temporary build context; hosted marker-only push; private package metadata and remote marker digests for both destinations.             |
| Fail-closed bootstrap                | Gate tests reject public/wrong repositories, invalid packages, unsafe contexts, and API failures.                                              |
| Prepared image identity              | Hosted startup smoke and sealed OCI/config digests from the same publication run.                                                              |
| Successful first publication         | Publish job succeeds; receipt names both remote digest references and `linux/amd64`; authenticated digest inspection and pull where available. |
| Documentation and workflow integrity | CI ownership audit, workflow lint, workspace check, formatting, documentation build/link checks, and independent review.                       |

Initial evidence: [PR #36](https://github.com/openclaw/openclaw-enterprise/pull/36)
introduced the intentionally separate bootstrap prerequisite.
[Run 34286111928](https://github.com/openclaw/openclaw-enterprise/actions/runs/34286111928)
prepared images but skipped publication. On 2026-09-21 the required publication
environment was initially absent. It is now configured with `openclaw/maintainer`
reviewers, self-review and administrator bypass disabled, only branch `main`, and
the two destination variables above. Bootstrap run `35647474652` succeeded. Publication run `35648198492`, attempt 1,
prepared and smoked both images from `4ec004dbefd25070ff1bdeb89cfb16d245296ac9`;
controller transfer and remote digest verification completed before a metadata
transport failure. Runtime remains unpublished and no final receipt exists.
Retained artifacts `10661476204` and `10660634184` are the recovery inputs.
The first complete publication remains unverified.
Repository administration alone proves neither package access nor independent approval.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-21 01:50: Include CI retry artifact replacement after a successful fixture retry was masked by its stale failed result. (01a0c179-19f7-7111-8bb4-fc7680da5545 - e836c3f9ec002d91d6f26c6ca49a08345a8c9f4f)

- 2026-09-21 01:00: Specify protected marker bootstrap and first private SHA-image publication from current source. (01a0c179-19f7-7111-8bb4-fc7680da5545 - 4e056c57390397b89642783fea5f1d19834b0325)
