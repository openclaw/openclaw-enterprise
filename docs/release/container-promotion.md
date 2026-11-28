# Docker Hub promotion

Copy verified public GHCR controller and runtime digests to separately authorized
private Docker Hub repositories. Complete [promotion configuration](configuration.md#publication-configuration)
first. The workflow does not build images, create repositories, or change visibility.

## Operator setup

Confirm both configured Docker Hub destinations exist and are private. The
workflow checks their authenticated namespace-scoped API identity and visibility
before transfer. Missing or inaccessible metadata fails closed.

## Promote

1. Record the full source SHA, publication run ID, and exact attempt from a
   successful full Release OCE or standalone Enterprise Containers publication.
   Its receipt must still be retained. Image-only Release OCE runs, including
   image-only recovery runs, are not eligible. For a completed full Release OCE recovery, select
   the successful recovery run; its final alias job and original preparation
   evidence must remain available. Standalone image recovery receipts are ineligible.
2. Under an explicit publication request, dispatch
   [Promote Enterprise Containers to Docker Hub](../../.github/workflows/container-promote.yml)
   on `main` with `source_sha`, `publication_run_id`, and `publication_attempt`.
   Check the producer, destinations, and [GHCR linkage](configuration.md#confirm-package-linkage).
3. Compare both Docker Hub digests with the job summary and original GHCR
   digests. Existing identical tags remain unchanged; conflicting tags are refused.

The source must remain in the workflow's `main` history. Release OCE promotion
checks the qualification record and full-suite aggregate; standalone promotion
checks exact push CI. The receipt's base digest must match `CONTAINER_NODE_BASE_IMAGE`.
The two copies are not atomic. After partial failure, inspect both remote
digests before retrying; do not remove or replace tags automatically.

## Verify the served Console

After traffic selection, use the production upgrade guide's
[served Console check](../guides/deploy/production-upgrade-console.md).
