---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

<a id="qualify-a-published-release-for-staging"></a>

# Check published images before an upgrade

## Overview

This workflow accepts only standalone **Enterprise Containers** publications,
not **Release OCE** runs. Full Release OCE runs perform Full Integration and
native image checks before publication. Image-only runs skip Full Integration
and cannot use this workflow.

Use **Staging Release Qualification** after publishing standalone images and before you
attempt an upgrade. CI checks the source commit. This manual workflow pulls the
published image digests and checks those bytes. It can also rehearse a controller
upgrade and return while checking human sign-in.

The workflow runs on a disposable GitHub runner. It does **not** deploy to your
staging installation. Choose the check that answers your question:

| Your question                                                                  | Select            | What a pass means                                                               |
| ------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------- |
| Do the published controller and runtime images start?                          | Startup (default) | Both images pass the Linux amd64 startup checks.                                |
| Can these two controller releases be used for a sign-in rehearsal?             | Controller pair   | The images and reviewed compatibility plan are ready. No controller is started. |
| Does sign-in work when I upgrade and return between these controller releases? | Sign-in rehearsal | The installed case passes on a disposable k3d cluster.                          |

A pass is evidence for that check. It is not approval to deploy and does not
prove that your staging or production installation will work.

<a id="when-it-runs"></a>
<a id="trigger"></a>
<a id="run-it"></a>

## Execution

1. Use a successful **Enterprise Containers** publication from `main`. Record
   its full lowercase `source_sha`, `publication_run_id`, and exact
   `publication_attempt`. The public GHCR images and the publication receipt
   must still be available; receipts expire after 30 days.
2. Configure the main-only `staging-qualification` environment with
   `STAGING_INSTALLATION`, `GHCR_CONTROLLER_IMAGE`, and `GHCR_RUNTIME_IMAGE`.
   The Installation ID is 1–63 lowercase letters, digits, or hyphens, starting
   with a letter. Image names are full `ghcr.io/openclaw/...` repositories
   without tags or digests.
3. Dispatch [Staging Release Qualification](../../.github/workflows/staging-qualification.yml)
   on `main` with `installation` equal to the configured ID and the three
   publication inputs. Leave the optional inputs empty for startup. Runs with
   the same Installation ID execute one at a time.
4. Check the selected job and its result file. If the job fails, inspect its
   retained results and correct the cause before another dispatch.

<a id="scenarios"></a>

## Startup

The default job pulls the published controller and runtime by digest, verifies
their source and platform, and runs the trusted packaging and startup checks.
Require `staging-qualification.json`. A failed or skipped case, failed
preparation, or failed cleanup prevents that success file.

<a id="source-and-credential-constraints"></a>

The workflow accepts only supported runtime recipes and verified publication
receipts with successful source CI. It uses read-only package access. It needs
no credentials for your cluster, applications, or model providers. See the
[qualification command](../../scripts/ci/staging-qualification.ts) for the exact
source, receipt, and recipe checks.

## Prepare a controller pair

Add `previous_source_sha`, `previous_publication_run_id`, and
`previous_publication_attempt` for the earlier release. Supply all three.
Before pulling images, the workflow checks two distinct, ordered publications
against a reviewed controller build-input profile and migration tree. Changes
outside those inputs are allowed. If the comparison fails, review the changes
and test expectations before approving a matching profile. The workflow keeps
the previous runtime fixed.

Require `staging-pair-images.json` and `staging-signin-plan.json`. These files
prepare the next check; they do not prove sign-in works. Publish the earlier
release before activating a protocol change, while it is still the selected
`main` commit. Use a dedicated image alias unless updating `latest` is intended.

## Rehearse installed sign-in

Supply the previous publication inputs and set `rehearse_signin: true`.
The job installs both controller versions in sequence on a disposable k3d cluster
with a populated database and test identity provider. It checks sign-in during
forward and return replacement, one-use collection, replay refusal, and expiry.

Require `staging-signin-qualification.json`. The current reviewed case covers
compatible v3 controllers, not the historical v2-to-v3 transition. It does not
check normal ingress availability or controllers writing concurrently. Cleanup
must succeed; ambiguous resource ownership blocks automatic cleanup.

## Results and limits

Keep the success file with your upgrade evidence. A failure can retain partial
results without a success file. These checks do not cover arm64, installed Agent
workflows, live staging traffic, or production readiness. Continue with the
[production upgrade checks](../guides/deploy/production-upgrade.md#rehearse-before-the-maintenance-window)
before an approved upgrade.

## Files

- [Workflow](../../.github/workflows/staging-qualification.yml)
- [Qualification command](../../scripts/ci/staging-qualification.ts)
- [Packaging](../../scripts/ci/test-suites/images-packaging.json) and
  [startup](../../scripts/ci/test-suites/images-runtime-startup.json) manifests
