# Verify image version changes

Always run this workflow before merging a change to a default controller or
runtime image version, image digest, upstream source pin, or bundled runtime
version such as Codex. Also use it when changing image recipes or version gates.
Record the evidence in the PR's Verification section. Missing, failed, cancelled,
or skipped required image checks block merging.

The branch check and publication have different inputs. The
[native image workflow](../../../../.github/workflows/container-check.yml) accepts
a branch revision and never pushes images. The
[publication workflow](../../../../.github/workflows/container-publish.yml)
requires a revision already on main and its successful main-push CI run. Run the
branch check before merge; complete the authorized publication after merge.

## Before merge

1. Identify every consumer of the changed default: Dockerfiles, upstream source
   and lockfiles, workspace templates, version and sandbox gates, startup checks,
   and current documentation. Update the affected consumers together. Use the
   [runtime recipe](../../../../deploy/runtime/README.md) and
   [publication flow](../../../../docs/flows/container-publication.md) to trace
   their owners. Do not lower or bypass a gate to accept an older image.
2. Push the candidate to its authorized PR branch and record the full head SHA.
   Select a repository and ref containing that exact commit with the native
   workflow, configured runners, and required repository variables. Arrange
   verification of the PR's exact head commit; a branch with the same name in
   another repository does not select that commit. Do not change PR ownership
   or push another author's branch to obtain a runner.
3. Dispatch **Check Native Container Images** (`container-check.yml`) on that
   ref. For example, after setting the verified repository and branch:

   ```sh
   gh workflow run container-check.yml --repo "$IMAGE_CHECK_REPO" --ref "$IMAGE_CHECK_REF"
   gh run list --repo "$IMAGE_CHECK_REPO" --workflow container-check.yml \
     --commit "$PR_HEAD_SHA" --event workflow_dispatch \
     --json databaseId,headSha,createdAt,status,conclusion,url
   ```

   Select the dispatched run by its SHA and creation time, then inspect it:

   ```sh
   gh run watch "$IMAGE_CHECK_RUN_ID" --repo "$IMAGE_CHECK_REPO" --exit-status
   gh run view "$IMAGE_CHECK_RUN_ID" --repo "$IMAGE_CHECK_REPO" \
     --json headSha,status,conclusion,url,jobs
   ```

   A manual **CI** dispatch on that same revision is also valid: its
   **Native Container Verification** job calls this same workflow. Ordinary
   pull-request CI does not run that job.

4. Require successful controller and runtime builds and startup checks on both
   native Linux AMD64 and ARM64 runners. Inspect the logs and platform receipts,
   not just the aggregate result. The runtime preparation exercises the actual
   built image's Codex version and sandbox probes; the startup checks exercise
   that same image. A local single-architecture build, mocked version result,
   or existing `latest` image does not satisfy this requirement.
5. Record the candidate SHA, run URL, all four image/architecture outcomes, and
   relevant version/probe results. Confirm the run SHA still equals the final
   PR head; rerun after further commits. State any remaining real-cluster or
   model verification gap separately; native startup proof is not deployment
   proof. Identify the publication owner and whether publication is authorized
   before handing off the merge.

## After merge and before announcing updated images

Follow [Prepare and publish](../../../../.github/containers.md#prepare-and-publish)
with the exact selected main SHA and its successful main-push CI run. Leave
`image_tag` blank when publishing `latest`; a custom tag does not update it.
Image-only publication uses `publish_chart: false`. Repository access or merge
permission alone does not authorize publication; preserve existing authorization
and report a pending publisher handoff when it is absent.

Publication rebuilds and checks both architectures before transferring the
sealed images, verifies registry digests, and writes the image receipt. Match
both remote `latest` digests and both images' source-revision labels to that
receipt before reporting success. Check image and chart job outcomes separately:
a later chart failure can leave valid published images. On a partial image
failure, inspect both aliases and follow the documented recovery procedure;
never assume that the two alias updates are atomic.

Use [the published-image procedure](../../../../docs/guides/deploy/published-images.md)
before installation: resolve both images, verify their publication receipt,
and select their matching source checkout before running version or sandbox
checks. If the checkout and image revisions differ, report both revisions and
the matching checkout command first. Rebuild/publish the newer source or use
the older images' exact checkout; do not weaken the version gate.

Publication is currently manual. Passing branch checks or merging to main does
not update `latest`. Keep publication pending until the receipt and remote pair
are verified, and retain their source SHA, immutable digests, and run URL in the
handoff. Automated post-merge dispatch and registry preflight before alias
promotion are separate pipeline changes; this workflow does not claim they exist.
