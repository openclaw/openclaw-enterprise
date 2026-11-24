# Deliver images to a private registry

Select a controller, runtime, and Helm chart from a verified source commit,
then make the images available to every eligible Kubernetes node. This guide
copies an already published image pair from public GHCR to private Amazon
Elastic Container Registry (ECR) without rebuilding it. Use the
[production installation guide](production-installation.md) to configure and
install the resulting references. Operators can instead build their own images
from the selected clean source; those builds have their own digests and need
independent verification.

## Select a release and chart

From a successful [container publication](../../release/containers.md), record
its source commit, successful CI run, publication run and attempt, and both
immutable image digests. Check the publication receipt and remote digests; a tag
alone does not establish the image contents. Publication smoke checks do not
prove a production deployment. Select images that include the features you need
and support the target node architectures.

For the current production example, select a controller supporting the curated
Codex catalog (`catalogSource: openai-curated`) and the
[browser request origin check](../../reference/authentication.md#browser-request-origin).

Use a clean checkout at that exact commit for the Helm chart, Installation
examples, and helpers. From the repository root, compare `git rev-parse HEAD`
with the recorded full source SHA and check `git status --short` for changes.
If a separately published chart is available, verify its publication receipt,
source commit, chart digest, and image annotations against the selected image publication;
use it only when the release owner confirms compatibility. Chart publication
is a separate process and is not assumed to have occurred for an image release.

## Copy the verified images to ECR

The operator needs Skopeo, AWS CLI, ECR push and read access, existing ECR
repositories, and network access to both registries. GHCR source pulls are
public. Verify that both ECR repositories enforce immutable tags, with no
exclusions for the chosen tags, and restrict other writers. Choose a unique tag
for this publication; never replace an existing tag. See
[ECR tag immutability](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-tag-mutability.html).
The ECR account and Region must be the ones approved for the cluster.

Set the values from the publication record and the target registry. Use the
published **index** digests for GHCR source references. Replace all placeholders.

```bash
export AWS_REGION='<aws-region>'
export ECR_REGISTRY='<aws-account-id>.dkr.ecr.<aws-region>.amazonaws.com'
export SOURCE_CONTROLLER='ghcr.io/openclaw/openclaw-enterprise-controller@sha256:<64-hex-digest>'
export ECR_CONTROLLER="$ECR_REGISTRY/openclaw-enterprise/controller"
export ECR_RUNTIME="$ECR_REGISTRY/openclaw-enterprise/runtime"
export ECR_TAG='<unique-release-tag>'
unset RUNTIME_SOURCE RUNTIME_INDEX
```

### Select the runtime source

Before starting Bash, select exactly one runtime source in the parent shell.
For GHCR, set and export the following pair, then continue at
[Copy and verify the destination](#copy-and-verify-the-destination). For a local
image, continue at [Use a qualified local runtime](#use-a-qualified-local-runtime).
Keep the parent shell open for copy retries.

```bash
SOURCE_RUNTIME='ghcr.io/openclaw/openclaw-enterprise-runtime@sha256:<64-hex-digest>'
export RUNTIME_SOURCE="docker://$SOURCE_RUNTIME" RUNTIME_INDEX="${SOURCE_RUNTIME##*@}"
```

### Use a qualified local runtime

If you built and qualified the runtime locally, you can use its OCI archive as
the source for the runtime copy. Use the root index digest recorded during
qualification. An index can include a platform image and a provenance attestation
even when the runtime supports only one architecture. A platform-specific export
can omit the attestation and change the digest.

Use the qualified `rootDigest` and a new absolute archive path in your private
build directory. Export the source and index only after the archive is saved.

```bash
unset RUNTIME_SOURCE RUNTIME_INDEX
ROOT_DIGEST='<qualified-rootDigest>'
RUNTIME_ARCHIVE='<absolute-path-to-new-runtime.tar>'
[[ "$RUNTIME_ARCHIVE" == /* ]] &&
  ( umask 077; set -o noclobber; docker image save "$ROOT_DIGEST" > "$RUNTIME_ARCHIVE" ) &&
  export RUNTIME_SOURCE="oci-archive:$RUNTIME_ARCHIVE" RUNTIME_INDEX="$ROOT_DIGEST"
```

If selection fails, stop. Reuse the saved archive for copy retries.

### Copy and verify the destination

Start a dedicated Bash shell for registry authentication and copying. Its
cleanup trap removes the credential file when the shell exits or is interrupted;
do not run this in a shell with other work or traps:

```bash
bash
```

In that shell, create the private auth file, register cleanup immediately, and
authenticate to ECR. If an operation fails unexpectedly, exit this shell before
investigating or retrying; start a fresh one and authenticate again. The tag
lookup below can return the expected `ImageNotFoundException`.

```bash
{
  set -o pipefail
  [[ -n "${RUNTIME_SOURCE:-}" && -n "${RUNTIME_INDEX:-}" ]] || exit 1
  if [[ "$RUNTIME_SOURCE" == oci-archive:* ]]; then
    archive_hash=$(skopeo inspect --raw "$RUNTIME_SOURCE" | sha256sum) || exit 1
    [[ "sha256:${archive_hash%% *}" == "$RUNTIME_INDEX" ]] || exit 1
  fi
  umask 077
  REGISTRY_AUTH="$(mktemp "${TMPDIR:-/tmp}/oce-registry-auth.XXXXXXXX")" || exit 1
  export REGISTRY_AUTH
  trap 'rm -f -- "$REGISTRY_AUTH"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf '{"auths":{}}\n' > "$REGISTRY_AUTH" || exit 1
  aws ecr get-login-password --region "$AWS_REGION" | \
    skopeo login --authfile "$REGISTRY_AUTH" --username AWS --password-stdin "$ECR_REGISTRY"
}
```

If the archive's raw index digest differs from the qualified digest, recover the
complete index and its referenced manifests from the build's image store.

Run `aws sts get-caller-identity` and confirm the selected account before writing
to ECR. The temporary auth file contains registry credentials. The ECR login
expires; renew it before retrying if necessary. Before copying, inspect each
target tag using `aws ecr describe-images` in the approved account and Region. An
`ImageNotFoundException` establishes that the tag is absent; permission,
network, and other errors do not. For each repository, read its policy and the
exact target tag, substituting the repository name:

```bash
aws ecr describe-repositories --region "$AWS_REGION" \
  --repository-names openclaw-enterprise/controller openclaw-enterprise/runtime \
  --query 'repositories[].{name:repositoryName,mutability:imageTagMutability,exclusions:imageTagMutabilityExclusionFilters}'
aws ecr describe-images --region "$AWS_REGION" \
  --repository-name openclaw-enterprise/controller --image-ids "imageTag=$ECR_TAG" \
  --query 'imageDetails[0].imageDigest' --output text
```

Repeat the tag lookup for `openclaw-enterprise/runtime`. For tag lookup,
destination verification and retry, the expected controller index is
`${SOURCE_CONTROLLER##*@}` from the publication receipt and the expected runtime
index is `$RUNTIME_INDEX`. Use an existing tag only if its digest matches the
expected index. Stop on a conflicting digest. Immutable tags protect against
overwrites. You must still verify the digest and coordinate with other writers.

Copy each absent tag and verify the destination digest before continuing. Run
each command separately and stop on an error:

```bash
skopeo copy --all --preserve-digests --authfile "$REGISTRY_AUTH" \
  "docker://$SOURCE_CONTROLLER" "docker://$ECR_CONTROLLER:$ECR_TAG"
skopeo copy --all --preserve-digests --authfile "$REGISTRY_AUTH" \
  "$RUNTIME_SOURCE" "docker://$ECR_RUNTIME:$ECR_TAG"

skopeo inspect --raw --authfile "$REGISTRY_AUTH" \
  "docker://$ECR_CONTROLLER:$ECR_TAG" | sha256sum
skopeo inspect --raw --authfile "$REGISTRY_AUTH" \
  "docker://$ECR_RUNTIME:$ECR_TAG" | sha256sum
```

Prefix each printed hash with `sha256:` and compare it with the expected index.
Hashing the raw manifest checks the index itself. `--all` copies the platform
manifests, and `--preserve-digests` fails if the registry cannot preserve them.

If a copy fails or times out, exit the dedicated shell. Start a fresh copy shell
from the same parent shell and authenticate again. Look up both exact target
tags because one copy can succeed while the other fails. Accept a digest that
matches the expected index. Stop on a conflicting digest or an unknown outcome.
Retry only a tag confirmed absent by
`ImageNotFoundException` after resolving the error.

Record the source and destination references with the chart and receipt. Exit
the dedicated shell; its trap removes the auth file. In the original shell,
export the verified readback digests:

```bash
exit
```

```bash
export CONTROLLER_IMAGE="$ECR_CONTROLLER@sha256:<verified-controller-digest>"
export RUNTIME_IMAGE="$ECR_RUNTIME@sha256:<verified-runtime-digest>"
```

## Configure node pull access

Configure node pull permissions separately. OCE adds no `imagePullSecrets` to the Pods
it creates, so every node that runs control-plane or Agent Pods needs its own pull
access. Don't pull an OCE image through a Pod's `imagePullSecrets` either: where
kubelet verifies pull credentials (`KubeletEnsureSecretPulledImages`), every later Pod
on that node that uses the image without that Secret, such as a restarted API or
worker or the initialization Job, must then pull it again, which fails without node
access.

EKS managed nodes use their node
IAM role for ECR pulls; cross-account repository policies may also be needed.
For nodes without internet egress, configure ECR API and registry endpoints,
S3 layer access, DNS, routes, security groups, and endpoint policies as described
in [ECR VPC endpoints](https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html)
and [ECR images on EKS](https://docs.aws.amazon.com/AmazonECR/latest/userguide/ECR_on_EKS.html).
Builder credentials do not grant node access. Confirm actual pulls on both
control-plane and Agent nodes for the intended architectures. Direct public GHCR
pulls need internet egress to GHCR and its layer hosts, not pull credentials.

Continue at [Configure the Installation](production-installation.md#configure-the-installation)
with the two ECR digest references. Use the same runtime digest for gateway and
Agent unless a separately verified pair is required.
