# Rehearse a populated controller return

Use this local test to check whether the previous OpenClaw Control Plane (OCC)
controller can serve a draft that the candidate saved. The test creates a new
installation and PostgreSQL instance, then uses the
[local image upgrade command](../guides/deploy/local-k3d-image-upgrade.md)
to change the controller image.

## Prepare the cluster and images

Use native Linux with rootful Docker 29 or newer at `/var/run/docker.sock`.
Install k3d, Go, kubectl, Helm, OpenSSL, jq, yq v4, and Python 3. From the test
checkout, install the [workspace dependencies](README.md#requirements-and-credentials).

Create a fresh, disposable k3d cluster for this run. Use one server, no agents,
and these `k3d cluster create` flags:

```text
--no-lb --api-port 127.0.0.1:<free-port>
--kubeconfig-update-default=false --kubeconfig-switch-context=false
```

Keep the cluster exclusive through cleanup. The test derives a private kubeconfig
from the cluster and checks that the API endpoint matches the local Docker
server container. You are responsible for the cluster's freshness and exclusive
use.

Stage two distinct, compatible controller images in Docker and k3d. Use
[verified publications](../guides/deploy/published-images.md#check-publication-and-source)
or transfer the OCI artifacts from successful
[native image checks](../release/containers.md#check-native-images-without-publication).
Public registry publication is not required. For transferred artifacts, retain
the source SHA, native build/check run and attempt, platform receipt, and OCI
blob hashes. Verify the archive's root, platform receipt, and reachable blobs
before loading the images; the source revision label alone does not establish
approval.

Use owned local image names with their actual SHA-256 digests. Load the same
verified OCI archive into Docker and the owned k3d node's containerd, retaining
its original manifest or index target. Do not use an export that replaces an
index with a selected platform manifest. Verify the imported image identity:
the rehearsal compares Docker's reported root digest with the selected digest,
hashes the selected platform manifest and configuration, then checks the running
controller against those identities. Stop if
transport changes or loses the expected identity; do not assign a published
name to an unverified local image. Keep one approved runtime image fixed across
both controllers.

In a private environment file, set the values below. Run from a local shell
without model or Git credentials. Release checkouts must
contain only their committed files, with no ignored build artifacts, hidden
index changes, or additional files. Keep them unchanged throughout the run;
workspace dependencies belong in the separate test checkout.

| Variable                                                                                                    | Value                                                                 |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `OCC_TEST_REHEARSAL_K3D_CLUSTER`                                                                            | Name of the disposable k3d cluster.                                   |
| `OCC_TEST_REHEARSAL_PREVIOUS_SOURCE`, `OCC_TEST_REHEARSAL_CANDIDATE_SOURCE`                                 | Absolute paths to the clean previous and candidate release checkouts. |
| `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`, `OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE`                      | Previous and candidate controller images by digest.                   |
| `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`, `OCC_TEST_PRODUCTION_POSTGRES_IMAGE`, `OCC_TEST_PRODUCTION_NODE_IMAGE` | Fixed fixture images by digest.                                       |

## Run the test and check the result

```bash
TEST_ENV_FILE="$HOME/.config/oce/rehearsal.env"
OCC_TEST_PRODUCTION_TUI_REHEARSAL=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/production-tui-k3d-real.test.mjs
```

Require the rehearsal to pass without a skip. The archive taken before the upgrade
must omit the candidate's acknowledged draft. The archive taken after the write
must contain it. The previous controller must accept the restored migration
history. After the return, both OCC components must use the restored database.
OCC must return both drafts and their acknowledged saved settings, including
execution mode, with the original service key. Metadata-only responses with
unreadable settings fail the rehearsal. OCC must also deny an anonymous read
of the Installation.

See `proof.json` for completed checks and timings and `return-progress.json` for
the last phase started. Both are in the private evidence directory reported by
the test. Inspect retained fixture resources after a failure. Set
`OCC_TEST_PRODUCTION_TUI_KEEP=1` to retain fixture resources after a success.
Remove the disposable cluster when you finish inspecting the evidence.

A result applies only to the selected source and image pair. A historical
compatible pair does not qualify later schema changes or a deployment of current
main. Recheck migration, restore and saved-configuration compatibility when
selecting another pair; retain those limits with the evidence.
