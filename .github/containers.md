# Enterprise container publication

[`container-publish.yml`](workflows/container-publish.yml) prepares the existing
controller (`Dockerfile`, target `runtime`) and combined gateway/Agent runtime
(`deploy/runtime/Dockerfile`) as OCI archives containing both `linux/amd64` and
`linux/arm64`. Each image has one multi-platform index digest; Docker selects
the matching architecture when pulling it. It does not change recipes,
package versions, Kubernetes deployment, or the existing CI test matrix.

## Source visibility

No-push preparation supports private or public source in
`openclaw/openclaw-enterprise` only when this workflow receives `publish: false`
(`PUBLISH` is the exact string `"false"`). The trusted main workflow, immutable
source SHA, successful exact-source CI, and approved base-image checks still apply.
Actual GHCR publication and Docker Hub promotion continue to require private
source and private GHCR packages. From public source, both remain blocked
pending an explicitly reviewed package-access and credential design.

[GitHub warns](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility#ensuring-workflow-access-to-your-package)
that granting a public repository Actions access to private packages can expose
those packages to forks. These workflow guards do not revoke existing package
grants or inherited access. Before any repository visibility transition, an
operator must review package permissions, Actions grants, credentials, and
retained artifacts; private package visibility alone is not a confidentiality
guarantee.

## Operator setup

Maintainers publish by manually dispatching the workflow. GitHub requires
[repository write access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
to run it; repository writers can dispatch it too. There is no second-person
approval or approval-comment requirement. Complete these prerequisites first.

- Protect `main`, require the real `CI Required` check, and review workflow changes.
- Create a dedicated `container-publish` environment with no required reviewers or
  wait timer, administrator bypass disabled, and one deployment branch policy:
  branch `main`. Do not reuse the integration environments.
- Set repository or organization variable `CONTAINER_NODE_BASE_IMAGE` to the
  approved Node 24 digest used by `scripts/ci/test-suites.json` and the runtime
  Dockerfile. All three must agree. This is an explicit approval, not a default.
- Bootstrap two **private**, pre-existing GHCR container packages,
  link each to `openclaw/openclaw-enterprise`, and grant this repository Actions
  access. GHCR packages are first created by pushing an image; the Enterprise
  publisher deliberately cannot perform that initial push. Use the manual
  [marker bootstrap](#bootstrap-private-packages), then confirm private
  visibility and linkage.
- Set environment variables `GHCR_CONTROLLER_IMAGE` and `GHCR_RUNTIME_IMAGE`
  to their full `ghcr.io/openclaw/...` names without tags or digests. They must be
  different packages. There is no public destination fallback.

The publishing job uses its short-lived `GITHUB_TOKEN` with `packages: write`;
preparation has only `contents: read`, no environment or registry credentials.
No-push preparation needs the approved base-image variable and trusted source/CI,
not the publishing environment or package-access grants. Do not apply the
private-package setup above to a public source repository.
Missing settings, inaccessible metadata, conflicting package linkage, or nonprivate
visibility stop publication. GitHub may omit repository metadata; that omission
does not require an approval comment.
Repository-level secrets/variables alone do not
describe effective organization/environment credentials.

## Confirm package linkage

GitHub's [package response](https://docs.github.com/en/rest/packages/packages#get-a-package-for-an-organization)
may omit `repository` or return `null` even for a connected GHCR package. The
workflow always verifies package identity and private visibility. An explicit
repository must match the private Enterprise repository; conflicting metadata
stops publication.

During package setup, open **Package settings** for each destination and confirm
its connected repository is `openclaw/openclaw-enterprise`, its visibility is
**Private**, and that repository has the required **Manage Actions access**
grant. Source labels alone do not prove linkage. When GitHub omits repository
metadata, the publisher relies on this configured package access and still
checks package identity, private visibility, and immutable tag contents. It does
not claim to verify omitted linkage through the API.

To migrate an existing environment, first merge this manual-publication change
and wait for its main-push CI. Then remove required reviewers and any wait timer
from **Settings → Environments → container-publish**. Retain the environment
variables, main-only branch policy, and disabled administrator bypass. Old runs
execute their original workflow code; use a new recovery dispatch to publish
retained artifacts under the updated policy.

## Bootstrap private packages

After configuring the environment and both destination variables, merge the
reviewed [bootstrap workflow](workflows/container-bootstrap.yml) and wait for
its exact main-push CI run to succeed. An operator must first confirm that the
organization permits creation of private container packages under those names.
Dispatch **Bootstrap Enterprise Container Packages** on `main` with that
`ci_run_id`. The manual dispatch authorizes the run.

The workflow uses its short-lived `GITHUB_TOKEN` to build and push a scratch
image containing only a fixed marker. Its temporary context contains no checkout
files or credentials. Existing packages must be private and are left unchanged;
explicit conflicting repository metadata fails. An authenticated metadata 404 permits only this harmless
push; it is not proof that a package is absent rather than inaccessible. Other
metadata errors stop the run. After each push, the metadata lookup retries only
404 responses up to five times at two-second intervals for registry propagation;
persistent 404 responses fail. Private visibility and the remote digest must
verify before bootstrap succeeds. Confirm package linkage during setup before
real-image publication.

The job summary records package coordinates and marker digests. The unique
`bootstrap-<run-id>-<attempt>` tags are not runnable Enterprise images. Bootstrap
does not change visibility or access grants; if verification fails, inspect the
package settings and fix the reported cause before retrying. A partial result is retained,
and a subsequent dispatch leaves valid existing packages untouched. The ordinary
publisher still requires verified private packages before copying any source.
See the [bootstrap execution flow](../docs/flows/container-package-bootstrap.md).

An authenticated local pull of private images separately requires a credential
with package read access. Repository administration or an OAuth token with only
`repo` scope does not establish that access. Workflow package permissions do not
grant a workstation credential additional scopes.

## Pull-request builds

**Enterprise Containers** builds controller and runtime images on every pull
request when it is opened, reopened, or updated. It tests the PR merge commit
on disposable GitHub-hosted runners, using the Node base pinned in that
revision's CI suite manifest. Both Linux amd64 and arm64 variants run the same
startup checks used by manual release preparation. ARM64 uses QEMU.

PR jobs have only `contents: read`, no publishing environment or registry login,
and never publish images or upload sealed release archives. A new PR update
cancels the previous preparation jobs for that PR. Fork runs remain subject to
GitHub's workflow approval policy. These checks run alongside ordinary CI;
`CI Required` does not aggregate this separate workflow.

To publish a PR's changes, merge them and follow the manual process below with
the resulting main commit and successful main-push CI. PR results and image
bytes cannot substitute for that release evidence.

## Prepare and publish

1. Merge the reviewed workflow and source changes to `main`. Wait for that exact
   main **push** run of `.github/workflows/ci.yml` to finish successfully, including
   its `CI Required` job. A PR merge SHA or a matching check name is insufficient.
2. Manually dispatch **Enterprise Containers**, selecting branch `main`, its full
   current `source_sha`, and that `ci_run_id`. Leave `publish` false for no-push
   preparation. If main moved, select the new SHA and its own completed CI run.
3. To publish, dispatch with `publish` true after reviewing the SHA, CI run,
   and [package setup](#confirm-package-linkage). Preparation builds
   both platforms in one OCI archive, checks the index and child manifest/config
   digests, and loads each platform into Docker separately. Its config ID must
   match that index entry. Both platforms run the existing controller or runtime
   startup smoke before sealing/uploading. ARM64 builds and smoke tests use QEMU
   on the amd64 runner; this is not native ARM64 performance proof. The publisher copies those exact
   archive and all child manifests with Skopeo and verifies the remote index digests. Source, CI attempt,
   environment branch policy, and package visibility are rechecked before transfer.
4. Use the `image@sha256:...` references in the job summary and
   `container-publication-<run-id>-<attempt>` receipt for deployment. No Git tag,
   release, `latest` alias, or deployment is created. Existing `sha-<source-sha>`
   image tags cannot be replaced by different bytes.

The multi-platform publisher requires both architectures in every seal. Earlier
amd64-only tags retain their original bytes and digests; building this workflow
requires a new source SHA. Old single-platform archives are not accepted by the
current recovery or promotion validator. See the [publication execution flow](../docs/flows/container-publication.md).

OCI archives are retained for seven days and publication receipts for 30 days.
Uploaded archives follow the repository's
[workflow-artifact access](https://docs.github.com/en/actions/managing-workflow-runs/downloading-workflow-artifacts):
repository readers can download them. Public-source preparation can therefore
expose the built images to public repository readers even with `publish: false`.
No registry push does not mean artifact confidentiality; review the image
contents and artifact audience before dispatch.

A new dispatch rebuilds, so rerunning publication for the same source may be
rejected if registry-resolved dependencies changed the bytes. Do not delete or
overwrite existing tags to evade that rejection. Publication of the two images
is not transactional; on a partial failure inspect each recorded registry digest
before deciding on recovery. The publisher's concurrency lock serializes these
workflow writes, not external registry administrators.

## Recover a partial publication

Preserve the original seven-day OCI artifacts. Do not rerun their producer: its
attempt identity must remain unchanged. If those archives have expired, this
recovery path cannot reconstruct their exact bytes.

After merging reviewed recovery code and waiting for its successful main-push CI,
dispatch [Resume Enterprise Container Publication](workflows/container-resume.yml)
on `main` with:

- `source_sha`: the original image source SHA.
- `preparation_run_id` and `preparation_attempt`: the original **Enterprise
  Containers** run, with successful validation and both prepare/smoke jobs.
- `workflow_ci_run_id`: successful main-push CI for the current recovery workflow
  revision. This is separate from the original image's CI evidence in its seal.

Review the original digests and current private package settings before dispatch.
Recovery validates artifact IDs and downloads the exact
artifact IDs from the original run, verifies seals and archive hashes, and
rechecks original source CI as well as recovery workflow CI. Source must remain
in main history and precede the recovery workflow revision. The approved Node
base must still match the original seals.

An existing source tag must match both package metadata and its remote manifest
digest; recovery leaves it untouched even when package metadata lags. Only an
authenticated manifest-unknown response permits copying an unlisted tag; other
inspection failures stop the run. Missing tags receive the original OCI bytes, with digest preservation and remote verification. Conflicting tags,
expired or changed producer evidence, or failed checks stop the
run. Neither recovery nor ordinary publication automatically rolls back a copy.
GitHub metadata GET transport failures receive bounded retries (normally three
attempts) and report the failing endpoint; authorization failures and other HTTP
errors still fail immediately, except the bootstrap's explicit 404 retry.

Success produces `container-recovery-publication-<run-id>-<attempt>` with a
`publication.json` receipt containing original image seals, preparation artifact
IDs/digests, and separate recovery publication run/attempt/workflow/CI identity.
Both remote digests must match before the receipt is written. Its 30-day retention
matches ordinary receipts. This recovery receipt is not accepted by the existing
Docker Hub promotion workflow, which requires an ordinary successful producer.
No build, visibility change, tag replacement, or deployment occurs during recovery.

For a separately authorized copy of ordinary publication digests to private Docker Hub
repositories, use [Docker Hub promotion](container-promotion.md).

## Proof boundaries

The existing CI Images and Packaging lane gates the selected source. Preparation
reuses its controller/runtime startup tests against the newly prepared bytes:
source CI alone cannot prove a subsequent build with newly resolved npm
transitives. Loading does not rebuild; each loaded config ID, its index entry, and the
unchanged archive hash bind both platform smokes to the prepared image. Skopeo preserves manifest
digests during publication. These are not provider, cluster, or registry
end-to-end tests.

Local gate and recovery tests: `node --test tests/integration/container-{release,resume,promote}.test.mjs`.
Recovery tests use HTTP and transport fixtures; they prove gate ordering, original
identity, conflict rejection, unchanged existing images, and receipt behavior,
not a live GHCR transfer.
Workflow syntax: `actionlint .github/workflows/*.yml`.
Actual no-push builds and the first private-registry transfer still require
their respective authorized hosted runs; configuration and unit tests alone
do not prove them.
