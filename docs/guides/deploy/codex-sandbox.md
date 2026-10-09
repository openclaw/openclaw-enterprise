# Enable Codex sandbox execution on Kubernetes

Use a reviewed node-local seccomp profile when the container runtime's
`RuntimeDefault` profile blocks Codex's bubblewrap sandbox. Keep the Agent's
`workspace-write` sandbox enabled. The Kubernetes Compute Driver's existing
`runtime.codexSeccompProfile` setting selects the profile for the dedicated Codex
container; [security](../../reference/security.md#pod-and-container-hardening) defines
the remaining containment requirements.

This guide covers syscall containment. Codex network proxy policy is a separate
boundary. Repository-bound Codex consumers use stock Codex `0.163.0-alpha.1` with
`allow_local_binding = true`, `mode = "full"`, and the exact broker hostname
allowed. These settings permit local binding, disable Codex's additional
private-address guard, and allow every HTTP method at otherwise allowed
destinations. Explicit denies and the remaining
[network boundaries](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking)
still apply. A working seccomp profile, an operator shell, or a Ready Pod does
not prove repository access through Codex tools.

On production or shared clusters, profile installation belongs to your node
provisioning process. OCE does not install host files on those clusters, change
node sysctls, or provide a privileged installer DaemonSet. Review this
syscall-policy change before applying it, and use a disposable Pod with the exact
production runtime digest before enabling it for Agents. The disposable
[local Kubernetes launcher](local-kubernetes-development.md#start-the-profile)
separately prepares and verifies a profile inside its own k3d node.

## Identify the restriction

The message `bwrap: No permissions to create a new namespace` does not identify
which layer denied the request. Record the node OS, kernel, container runtime,
architecture, runtime image digest, Codex version, effective OCI seccomp policy,
and container security context. Check the host's user-namespace support and any
AppArmor or SELinux restrictions separately. Successful execution through
`require_escalated` establishes neither sandbox compatibility nor containment.

An EKS investigation on Amazon Linux 2023, kernel `6.12.103`, containerd `2.2.7`,
and Codex `0.156.0` found that the effective profile defaulted to
`SCMP_ACT_ERRNO`. Its `clone` mask excluded namespace flags, and it omitted
`unshare`, `mount`, and `pivot_root` allowances. A bounded host probe as UID 1000
with no-new-privileges could create a user namespace. This isolated the
container syscall policy as the blocker without changing host sysctls.

Do not infer the same cause on another node image. Stop if the captured policy
or host probe contradicts that diagnosis.

## Capture and generate the profile

On each distinct eligible node configuration, create a disposable probe Pod
using your approved runtime digest, `RuntimeDefault`, UID/GID 1000, dropped
capabilities, `allowPrivilegeEscalation: false`, and a read-only root filesystem.
Give it bounded writable workspace, home, and temporary volumes without Agent
credentials or persistent data. Keep the default kubeconfig unchanged.

Through your authorized host-management channel, capture only the running
probe container's effective seccomp policy. On a containerd node with `crictl`
configured for its CRI socket:

```sh
umask 077
PROBE_CONTAINER_ID='<container ID for the disposable probe>'
sudo crictl inspect "$PROBE_CONTAINER_ID" \
  | jq -e '.info.runtimeSpec.linux.seccomp' > runtime-default.json
```

Do not save or publish the full container inspection: it can include environment
values and mounts. Retain the node/runtime version inventory privately beside
the extracted policy. Capture the actual policy instead of copying a generic
containerd or Docker profile from the internet.

From the OCE repository root, generate the compatibility artifact offline:

```sh
node scripts/generate-codex-seccomp.mjs \
  --baseline runtime-default.json \
  --codex-version 0.163.0-alpha.1 \
  --out codex-bwrap.json
```

The command creates `codex-bwrap.json` and
`codex-bwrap.json.provenance.json`; existing output paths are refused. Use
`--provenance-out` to choose another metadata path. The metadata records the
normalized baseline and generated profile SHA-256 hashes, Codex version,
architectures, added-rule count, and reviewed upstream source hashes.

The shared generator preserves the baseline and appends the reviewed
bubblewrap calls. It requires an `SCMP_ACT_ERRNO` baseline with containerd's
`clone3` ENOSYS rule and rejects unreviewed Codex versions or unsupported
architectures. Admission by the generator is not runtime proof. Inspect the
delta and repeat live verification for your selected runtime and node versions.
Do not substitute an arbitrary profile or `Unconfined` policy.

The pinned runtime and automatic preparation use Codex `0.163.0-alpha.1`. Its reviewed
default sandbox uses the same syscall rules; the optional inherited PID namespace
mode is outside this profile's scope. Profile generation does not upgrade the
deployed image.

## Install on eligible nodes

Use your existing node provisioning mechanism to install the approved artifact
under the kubelet's seccomp root, normally `/var/lib/kubelet/seccomp`. Give it a
versioned, content-addressed name, for example:

```sh
PROFILE_SHA256=$(jq -r .profileSha256 codex-bwrap.json.provenance.json)
PROFILE_RELATIVE="openclaw/codex-0.163.0-alpha.1-${PROFILE_SHA256}.json"
sha256sum codex-bwrap.json
```

Verify that the reported digest equals `PROFILE_SHA256` before and after
installation. Keep the file root-owned and readable by kubelet. Never overwrite
a different profile at an existing path. Record the artifact and baseline hashes
with the approved OS, kernel, container runtime, architecture, and Codex image
digest. Recapture, review, and reprobe when any of these inputs changes.

Install and verify the profile on every node admitted by
`drivers.compute.configuration.runtime.nodeSelector`, including replacement and
autoscaled nodes, before marking them eligible. A missing profile must prevent
the Codex container from starting. A node label alone does not prove installation;
your provisioning process must verify the file and runtime probe before assigning
eligibility.

Set the relative path in the Installation configuration for both API and worker:

```yaml
drivers:
  compute:
    configuration:
      runtime:
        codexSeccompProfile: openclaw/codex-0.163.0-alpha.1-<profile-sha256>.json
```

Replace the placeholder with the approved hash and preserve the other runtime
settings. Only the dedicated Codex container receives `Localhost`; the Pod,
gateway, embedded runtime, controller, and init containers retain
`RuntimeDefault`. Reconcile a disposable Agent through the normal deployment
workflow and inspect its effective OCI policy. Do not claim success from the
rendered manifest or a Ready Pod alone.

## Verify the sandbox boundary

First use the restricted disposable Pod to verify the exact runtime image and
profile. Bound each command with a timeout and remove only probe-owned resources.

1. Outside the Codex sandbox, write a marker to a container-writable path outside
   the workspace, such as a disposable file under the probe's writable home.
   A read-only container root is not a meaningful negative sandbox test.
2. Run the actual `codex sandbox` command with `workspace-write`. Require a
   successful workspace write and a denied write to that same outside path;
   verify the outside marker is unchanged. Check both enabled and disabled
   sandbox network access if both are required by your deployment.
3. Select a nonexistent Localhost profile for a separate disposable probe.
   Require container creation to fail; do not introduce a fallback.

Then verify the ordinary Agent workflow with `sandbox: workspace-write` and
`approvalPolicy: never`. Request a native command that writes and reads a unique
workspace marker and attempts the same outside-workspace write. Inspect the
native tool events and resulting files: a model's prose or an approved
`require_escalated` command does not prove this path. The Agent's sandboxed command can
report the outside write as successful, because paths outside its writable roots may be
a private view that is discarded; the proof is that the container's own copy of the
outside file is unchanged.

Verify repository access separately through genuine native Git reads using the
Agent's existing repository credentials. For dedicated Codex, start that proof
from the Agent interface so Git runs through Codex's tool execution path. Record
the repository, command result, runtime digest, profile hash, and absence of
escalated execution without logging tokens or credential-helper output. Preserve
histories and persistent workspace data. Keep Codex proxy denials,
NetworkPolicy denials and repository-authentication failures separate from
sandbox startup failures.

The EKS investigation's isolated same-image probe passed workspace writes and
denied writes to a separately container-writable `/outside` location with sandbox
network access both enabled and disabled. That evidence establishes the local
sandbox boundary under the tested profile. Ordinary native Agent execution with
`approvalPolicy: never` and credentialed repository reads require separate proof;
the isolated probe does not establish either outcome.

For contributor coverage and disposable k3d preparation, see
[Kubernetes testing](../../testing/kubernetes.md#kubernetes-model-turns-and-secrets).
