# Docker Hub promotion

[`container-promote.yml`](workflows/container-promote.yml) copies the exact
controller and runtime digests already published by
[Enterprise Containers](containers.md). It never builds images, creates a
repository, changes visibility, or falls back to a public destination.

## Operator setup

Complete the GHCR setup first. Under separate operator authorization, create two
private Docker Hub repositories. In the same protected `container-publish`
environment, configure:

- Variables `DOCKERHUB_CONTROLLER_IMAGE` and `DOCKERHUB_RUNTIME_IMAGE`: different
  full `docker.io/<namespace>/<repository>` names, without tags or digests.
- Secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`: an account identifier and
  scoped PAT or organization access token with read/write access only to the
  approved repositories. With an organization token, the identifier is its
  organization name.

The workflow checks Docker Hub's authenticated namespace-scoped repository API
for exact identity and `is_private: true` before any image transfer. A missing
repository, inaccessible API, public visibility, or conflicting source tag fails
closed. No private-code bootstrap is attempted. The GitHub token needs only
`packages: read`; Docker Hub credentials exist only in the promotion step.

## Promote

1. Merge the reviewed promotion workflow to `main`.
2. From a successful GHCR publication, record its full source SHA, run ID, and
   exact attempt. Its publication receipt must still be retained.
3. Under an explicit publication request, manually dispatch **Promote Enterprise
   Containers to Docker Hub** on `main` with those three inputs. Approve the
   protected environment after checking the producer and destinations.
4. Use the digest references in the job summary. Skopeo copies from GHCR by digest
   with `--all --preserve-digests`; the copied digest is verified at Docker Hub.
   Existing identical tags are left unchanged; conflicting tags are rejected.

Source must be in the selected main workflow's history and retain successful
exact CI. The receipt's base digest must still match `CONTAINER_NODE_BASE_IMAGE`.
The two images are not an atomic transaction. Inspect the remote digests after
partial failure; do not remove or replace tags automatically.

Local contract checks: `node --test tests/integration/container-promote.test.mjs`.
These tests do not authenticate to either registry or prove a live transfer.
