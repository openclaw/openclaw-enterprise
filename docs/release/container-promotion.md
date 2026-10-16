# Docker Hub promotion

[`container-promote.yml`](../../.github/workflows/container-promote.yml) copies the exact
controller and runtime digests already published by
[Enterprise Containers](containers.md). It never builds images, creates a
repository, changes visibility, or falls back to an alternate destination.

Promotion requires an ordinary successful publication from the public Enterprise
source repository to public GHCR packages. The Docker Hub destinations remain
private and separately authorized. No-push preparation with `PUBLISH=false` does
not create a promotion source.

## Operator setup

Complete the [publication configuration](configuration.md#publication-configuration),
including the separately authorized private Docker Hub destinations and scoped
credentials. That page owns the environment, variable, and secret requirements.

The workflow checks Docker Hub's authenticated namespace-scoped repository API
for exact identity and `is_private: true` before any image transfer. A missing
repository, inaccessible API, public visibility, or conflicting source tag fails
closed. No private-code bootstrap is attempted.

## Promote

1. Merge the reviewed promotion workflow to `main`.
2. From a successful GHCR publication, record its full source SHA, run ID, and
   exact attempt. Its publication receipt must still be retained.
3. Under an explicit publication request, manually dispatch **Promote Enterprise
   Containers to Docker Hub** on `main` with those three inputs after checking
   the producer, destinations, and
   [GHCR package linkage](containers.md#confirm-package-linkage).
4. Use the digest references in the job summary. Skopeo copies from GHCR by digest
   with `--all --preserve-digests`; the copied digest is verified at Docker Hub.
   Existing identical tags are left unchanged; conflicting tags are rejected.

Source must be in the selected main workflow's history and retain successful
exact CI. The receipt's base digest must still match `CONTAINER_NODE_BASE_IMAGE`.
The two images are not an atomic transaction. Inspect the remote digests after
partial failure; do not remove or replace tags automatically.

Local contract checks: `node --test tests/integration/container-promote.test.mjs`.
These tests do not authenticate to either registry or prove a live transfer.
