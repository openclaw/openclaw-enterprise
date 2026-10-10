# k3d image preparation in CI

How CI preparation selects images and imports them into the k3d clusters that the
Kubernetes lanes use. For lanes, coverage and failures, see [GitHub Actions testing](ci.md).

## Import and verify

Imports stream `docker image save` into node-local `ctr image import` on each owned
k3d node (`image-stream-import`): k3d `tools-node` can hide per-node failures while
exiting successfully. Before each import, preparation polls `ctr version` on every
node until its containerd answers, because a Ready node's containerd can still refuse
connections; after 60 seconds (`OPENCLAW_CI_K3D_CONTAINERD_WAIT_MS` overrides it) it
fails and names the node. An import that containerd refuses is retried once after the
same wait; for the k3d fixture lanes, a failed import writes the cluster diagnostics.
Imports are serialized per cluster, then preparation verifies
digest and CRI references. Each node check and tag, and each host engine image
inspect and tag before the import, times out after 30 seconds
(`OPENCLAW_CI_K3D_IMAGE_CHECK_TIMEOUT_MS` overrides it; it also bounds source image
inspects in lanes without k3d). A timeout fails preparation; it never counts as a
missing image, so nothing is pulled for it.

## Select immutable images for local preparation

Ordinary Kubernetes lanes default to the digest-pinned K3s 1.35 image in
`defaultK3sImage` (`scripts/ci/prepare.mjs`), so cluster creation never queries
k3d's online release channel. Set `OPENCLAW_CI_K3S_IMAGE` to another approved
`image@sha256:<digest>` before
`node scripts/ci/prepare.mjs --lane <lane> --state <private-state-file>` to
override it. Both paths require the API server to report Kubernetes 1.35.x;
OpenShell retains its separately pinned image. Mutable overrides fail before
resource creation. Clean up a failed run's owned resources with
`node scripts/ci/cleanup.mjs --state <private-state-file>` before reusing its state path.

`k3d cluster create` times out after five minutes (hosted runners take under a
minute, node image pull included; `OPENCLAW_CI_K3D_CREATE_TIMEOUT_MS` overrides
it). The timeout stops k3d's whole process group. Preparation then writes the
lane's cluster diagnostics, deletes the partial cluster and retries once; a second
timeout fails preparation and leaves the cluster to lane cleanup. The node Ready wait
starts only after every owned node has registered (up to two minutes).

Preparation reuses a supplied immutable workload image in the local Docker daemon
only when `docker image inspect` records the requested digest in `RepoDigests`;
a mutable tag or unverified image is insufficient. Missing or mismatched images
are pulled and rechecked before import. Other Docker inspection failures stop
preparation. Cleanup removes owned import tags and preserves the supplied image.

On GitHub-hosted runners, both observability lanes require 36 GiB free before
building and importing images, removing unused SDKs only when less is free
(concurrently, ten-minute deadline, per-directory timing receipts); local runs
omit this guarded cleanup. Both use single-node clusters and overlap independent
pulls, builds, and cluster setup, then serialize k3d imports per cluster to avoid
importer races. The demo lane imports only its three services and a Node
image for protocol fixtures; it does not build OCC. State writes remain
serialized, and all in-flight operations settle before failure cleanup.

Image imports time out after ten minutes. Preparation verifies each immutable
reference on every schedulable node. Errors and timeouts fail preparation; lane
cleanup removes the owned cluster and partial imports.

## Reuse an image the engine already holds

Hosted image lanes that only restore the BuildKit cache first resolve each image
from it without its layers (`reuseEngineImage` in `scripts/ci/prepare.mjs`). If
the runner's Docker engine already holds that image ID, as hosted runners often
do from their shared image cache, preparation tags it instead of downloading
and loading every layer (about 20 s for the runtime image). The ID is the
digest of a config that names each layer's content digest. Any other result,
or a lane that exports the cache, builds and loads as before.

The shared image cache keeps images a job leaves tagged, and lane cleanup
removes every owned tag. So main's never-cancelled cache workflow also tags its
runtime image as `localhost/openclaw-ci-main/runtime:<first 12 hex of its ID>`
and logs it as `runtime-image-kept`; compare that ID with the lanes'
`runtime-image-reuse` lines. Cleanup does not own that name, nothing pushes it,
and the cache evicts images unused for 8 days. Without it, the cache keeps
whichever older image a job happened to leave behind.
