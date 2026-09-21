# Enterprise container publication

[`container-publish.yml`](workflows/container-publish.yml) prepares the existing
controller (`Dockerfile`, target `runtime`) and combined gateway/Agent runtime
(`deploy/runtime/Dockerfile`) as OCI archives. It supports `linux/amd64`, matching
the current CI image lane and deployment example. It does not change recipes,
package versions, Kubernetes deployment, or the existing CI test matrix.

## Source visibility

No-push preparation supports private or public source in
`openclaw/openclaw-enterprise` only when this workflow receives `publish: false`
(`PUBLISH` is the exact string `"false"`). The trusted main workflow, immutable
source SHA, successful exact-source CI, and approved base-image checks still apply.
Actual GHCR publication and Docker Hub promotion continue to require private
source and private linked GHCR packages. From public source, both remain blocked
pending an explicitly reviewed package-access and credential design.

[GitHub warns](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility#ensuring-workflow-access-to-your-package)
that granting a public repository Actions access to private packages can expose
those packages to forks. These workflow guards do not revoke existing package
grants or inherited access. Before any repository visibility transition, an
operator must review package permissions, Actions grants, credentials, and
retained artifacts; private package visibility alone is not a confidentiality
guarantee.

## Operator setup

Publication is disabled until an operator independently authorizes and completes
these prerequisites. Adding the workflow does not authorize publication.

- Protect `main`, require the real `CI Required` check, and review workflow changes.
- Create a dedicated `container-publish` environment with required reviewers,
  self-approval disabled, administrator bypass disabled, and one deployment
  branch policy: branch `main`. Do not reuse the integration environments.
- Set repository or organization variable `CONTAINER_NODE_BASE_IMAGE` to the
  approved Node 24 digest used by `scripts/ci/test-suites.json` and the runtime
  Dockerfile. All three must agree. This is an explicit approval, not a default.
- Independently bootstrap two **private**, pre-existing GHCR container packages,
  link each to `openclaw/openclaw-enterprise`, and grant this repository Actions
  access. GHCR packages are first created by pushing an image; the Enterprise
  publisher deliberately cannot perform that initial push. Use the separately
  approved [marker bootstrap](#bootstrap-private-packages), then confirm private
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
visibility stop publication. When GitHub omits repository metadata, publication
requires the independent [linkage confirmation](#confirm-package-linkage) below.
Repository-level secrets/variables alone do not
describe effective organization/environment credentials.

## Confirm package linkage

GitHub's [package response](https://docs.github.com/en/rest/packages/packages#get-a-package-for-an-organization)
may omit `repository` or return `null` even for a connected GHCR package. The
workflow always verifies package identity and private visibility. An explicit
repository must match the private Enterprise repository; an approval cannot
override conflicting metadata.

When repository metadata is absent, the independent environment reviewer must
open **Package settings** for each destination and confirm its connected
repository is `openclaw/openclaw-enterprise`, its visibility is **Private**, and
that repository has the required **Manage Actions access** grant. Source labels
alone are not linkage evidence. Include one exact line per package in the
environment approval comment, replacing the placeholders and image names with
the selected values:

```text
Verified GHCR linkage: ghcr.io/openclaw/openclaw-enterprise-controller -> openclaw/openclaw-enterprise; source=<source_sha>; run=<current_run_id>; attempt=<current_attempt>
Verified GHCR linkage: ghcr.io/openclaw/openclaw-enterprise-runtime -> openclaw/openclaw-enterprise; source=<source_sha>; run=<current_run_id>; attempt=<current_attempt>
```

The publisher and Docker Hub promotion read GitHub's authenticated
[environment review history](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run)
and require an approved review for the current environment ID from someone other
than the run initiator or rerun actor. The statement binds each package and
repository to the selected source, current run, and attempt. A normal approval
without these lines, or a statement from an earlier attempt, does not satisfy
this fallback. For promotion, use the promotion run and attempt, not the producer's.
This is recorded operator verification of the live settings, not an API-derived
proof of linkage. Recheck the settings before approving each attempt.

## Bootstrap private packages

After configuring the environment and both destination variables, merge the
reviewed [bootstrap workflow](workflows/container-bootstrap.yml) and wait for
its exact main-push CI run to succeed. An operator must first confirm that the
organization permits creation of private container packages under those names.
Dispatch **Bootstrap Enterprise Container Packages** on `main` with that
`ci_run_id`; an independent reviewer approves `container-publish`.

The workflow uses its short-lived `GITHUB_TOKEN` to build and push a scratch
image containing only a fixed marker. Its temporary context contains no checkout
files or credentials. Existing packages must be private and are left unchanged;
explicit conflicting repository metadata fails. An authenticated metadata 404 permits only this harmless
push; it is not proof that a package is absent rather than inaccessible. Other
metadata errors stop the run. After each push, the metadata lookup retries only
404 responses up to five times at two-second intervals for registry propagation;
persistent 404 responses fail. Private visibility and the remote digest must
verify before bootstrap succeeds. Missing repository metadata is allowed only
for this marker stage; confirm linkage before approving real-image publication.

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

## Prepare and publish

1. Merge the reviewed workflow and source changes to `main`. Wait for that exact
   main **push** run of `.github/workflows/ci.yml` to finish successfully, including
   its `CI Required` job. A PR merge SHA or a matching check name is insufficient.
2. Manually dispatch **Enterprise Containers**, selecting branch `main`, its full
   current `source_sha`, and that `ci_run_id`. Leave `publish` false for no-push
   preparation. If main moved, select the new SHA and its own completed CI run.
3. Only under an explicit publication request, dispatch with `publish` true and
   approve the protected environment after reviewing the SHA, CI run, and OCI
   artifacts and [package linkage](#confirm-package-linkage). Preparation builds once, loads that archive into Docker, verifies
   its config ID, and runs the existing controller or runtime startup smoke
   against that ID before sealing/uploading. The publisher copies those exact
   archive digests with Skopeo and verifies the remote digests. Source, CI attempt,
   environment protections, and package visibility are checked again after approval.
4. Use the `image@sha256:...` references in the job summary and
   `container-publication-<run-id>-<attempt>` receipt for deployment. No Git tag,
   release, `latest` alias, or deployment is created. Existing `sha-<source-sha>`
   image tags cannot be replaced by different bytes.

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

For a separately authorized copy of these digests to private Docker Hub
repositories, use [Docker Hub promotion](container-promotion.md).

## Proof boundaries

The existing CI Images and Packaging lane gates the selected source. Preparation
reuses its controller/runtime startup tests against the newly prepared bytes:
source CI alone cannot prove a subsequent build with newly resolved npm
transitives. Loading does not rebuild; the loaded config ID and unchanged
archive hash bind smoke to the prepared image. Skopeo preserves manifest
digests during publication. These are not provider, cluster, or registry
end-to-end tests.

Local gate tests: `node --test tests/integration/container-release.test.mjs`.
Workflow syntax: `actionlint .github/workflows/*.yml`.
Actual no-push builds and the first private-registry transfer still require
their respective authorized hosted runs; configuration and unit tests alone
do not prove them.
