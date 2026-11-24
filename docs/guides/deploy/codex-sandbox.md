# Enable Codex sandbox execution on Kubernetes

Use a reviewed node-local seccomp profile when the container runtime's
`RuntimeDefault` profile blocks Codex's bubblewrap sandbox. This default procedure
keeps the Agent's `workspace-write` sandbox enabled. The Kubernetes Compute Driver's existing
`runtime.codexSeccompProfile` setting selects the profile for the dedicated Codex
container; [security](../../reference/security.md#pod-and-container-hardening) defines
the remaining containment requirements.

This guide covers syscall containment. Codex network proxy policy is a separate
boundary. Repository-bound Codex consumers use stock Codex `0.164.0` with
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

## Explicit container-only development verification

For an authorized disposable development run with Sandbox Driver `none`, set
`OCC_DEVELOPMENT_CODEX_VERIFICATION_MODE=danger-full-access` before `occ dev up`.
The default is `workspace-write`. This selector changes startup verification;
it does not change Agent or Preset configuration.

The launcher reports workspace-write sandbox proof as not applicable and not
performed. It installs no custom seccomp profile and does not verify the container
boundary at startup. The real Agent workflow must verify its Pod security,
NetworkPolicies and effective native turn policy.

Configure each intended Codex Agent explicitly with
`plugins.entries.codex.config.appServer.sandbox: danger-full-access` and disable
that Agent's inner Codex network proxy profile, which otherwise selects a workspace
permission profile. Keep Kubernetes NetworkPolicies in force. Retain its
approval policy and reviewer. Verify the authenticated runtime's effective grant
before model execution: managed requirements can refuse this mode. The container
is the containment boundary for this run. Do not describe it as workspace-write
proof. Standard presets and host security policy remain unchanged.

## Identify the restriction

The message `bwrap: No permissions to create a new namespace` does not identify
which layer denied the request. Record the node OS, kernel, container runtime,
architecture, runtime image digest, Codex version, effective OCI seccomp policy,
and container security context. Check the host's user-namespace support and any
AppArmor or SELinux restrictions separately. Successful execution through
`require_escalated` establishes neither sandbox compatibility nor containment.

On disposable k3d, a failed probe on a Ready Pod emits an
`OCE_CODEX_SECCOMP_PROBE_FAILURE` record before cleanup. Use the Pod and container
IDs, node, image digest, and timestamps to correlate authorized host evidence.
`profileVerification: "passed"` means the effective OCI profile matched the
installed profile. The sandbox probe still failed. The record reports the
Pod's security settings and omits raw command output and runtime inspection.

An EKS investigation on Amazon Linux 2023, kernel `6.12.103`, containerd `2.2.7`,
and Codex `0.156.0` found that the effective profile defaulted to
`SCMP_ACT_ERRNO`. Its `clone` mask excluded namespace flags, and it omitted
`unshare`, `mount`, and `pivot_root` allowances. A host probe for user-namespace creation, run as UID 1000
with no-new-privileges, could create a user namespace. This isolated the
container syscall policy as the blocker without changing host sysctls.

Do not infer the same cause on another node image. Stop if the captured policy
or host probe contradicts that diagnosis.

## Capture and generate the profile

On each distinct eligible node configuration, create a disposable probe Pod
using your approved runtime digest, `RuntimeDefault`, UID/GID 1000, dropped
capabilities, `allowPrivilegeEscalation: false`, and a read-only root filesystem.
Use this setup for both the baseline Pod and the profile check below.

- Set `spec.automountServiceAccountToken: false` and `spec.securityContext.fsGroup: 1000`.
- Mount separate size-limited `emptyDir` volumes at `/workspace`, `/home/node`, and
  `/tmp`. Set `CODEX_HOME=/home/node/.codex`.
- Name the container `probe`. Set its `command` to
  `["node", "-e", "setInterval(()=>{},1000)"]` to keep it running.

Do not include credentials or persistent data. Keep the default kubeconfig
unchanged. Wait until the container is Ready before you inspect it.

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
node scripts/generate-codex-seccomp.ts \
  --baseline runtime-default.json \
  --codex-version 0.164.0 \
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

The pinned runtime and automatic preparation use Codex `0.164.0`. Its reviewed
default sandbox uses the same syscall rules; the optional inherited PID namespace
mode is outside this profile's scope. Profile generation does not upgrade the
deployed image.

## Install on eligible nodes

Use your existing node provisioning mechanism to install the approved artifact
under the kubelet's seccomp root, normally `/var/lib/kubelet/seccomp`. Give it a
versioned, content-addressed name, for example:

```sh
PROFILE_SHA256=$(jq -r .profileSha256 codex-bwrap.json.provenance.json)
PROFILE_RELATIVE="openclaw/codex-0.164.0-${PROFILE_SHA256}.json"
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

## Verify the sandbox boundary

Create a second [restricted disposable Pod](#capture-and-generate-the-profile)
on the same node with the same container command and volume settings.
Keep the Pod on `RuntimeDefault`. Select the installed `Localhost` profile
for the `probe` container. Wait until it is Ready. Verify its running image
digest and effective OCI policy before you run the probe.
**Never use an Agent Pod or persistent data.** The probe deletes and rewrites
fixed marker files in the home directory and workspace.

From the OCE checkout for your runtime, run the following command with permission
to execute commands in the disposable Pod. Set the four `PROBE_*` variables to
select that Pod. Use the Codex version approved for the profile.

```sh
script=$(cat scripts/lib/codex-sandbox-probe.sh) &&
nonce=$(openssl rand -hex 16) &&
timeout 90s kubectl --kubeconfig "${PROBE_KUBECONFIG:?}" --context "${PROBE_CONTEXT:?}" \
  --namespace "${PROBE_NAMESPACE:?}" exec "${PROBE_POD:?}" --container probe -- \
  sh -c "$script" codex-sandbox-probe 0.164.0 "$nonce"
```

Require exit status 0 and these stderr markers, each once and in order, with
the value of `$nonce`.

```text
OCE_SANDBOX_PROBE_V1:<nonce>:START
OCE_SANDBOX_PROBE_V1:<nonce>:ENTERED
OCE_SANDBOX_PROBE_V1:<nonce>:END:DONE:0
```

The probe checks that `workspace-write` permits a workspace write and blocks
a write to a file the container can modify outside the sandbox. It verifies
that the outside file is unchanged. Sandbox network access is disabled. Check
enabled access separately if your deployment requires it.

If the command exits 1 and bubblewrap reports `Failed RTM_NEWADDR`, check
the markers. Exactly `START` followed by `END:SANDBOX:1` for this nonce,
without `ENTERED`, means sandbox setup failed. Use
[node evidence](#identify-the-restriction) to identify the restriction.
A timeout, lost connection, incomplete or duplicate markers, a different
nonce, or a conflicting exit status leaves the result unknown.

Repeat with a separate disposable Pod on the same node. Change only the
`Localhost` profile path to one that does not exist. Require no container ID
and a `CreateContainerError` that identifies that exact missing profile.
Remove only probe-owned resources.

After these checks pass, set the relative path in the Installation configuration
for both API and Worker.

```yaml
drivers:
  compute:
    configuration:
      runtime:
        codexSeccompProfile: openclaw/codex-0.164.0-<profile-sha256>.json
```

Replace the placeholder with the approved hash and preserve the other runtime
settings. Only the dedicated Codex container receives `Localhost`; the Pod,
gateway, embedded runtime, controller, and init containers retain
`RuntimeDefault`. Reconcile a disposable Agent through the normal deployment
workflow and inspect its effective OCI policy. Do not claim success from the
rendered manifest or a Ready Pod alone.

Verify the ordinary Agent workflow with `sandbox: workspace-write` and
`approvalPolicy: never`. Use a disposable Agent.

1. Outside the sandbox, in that Agent's Codex container, use authorized
   access as the runtime user. Create a unique test file outside all
   sandbox-writable roots. Overwrite it and read back the result. If you
   cannot do this, the test is inconclusive.
2. Request a native command that writes and reads a unique workspace file,
   reads the expected contents of the outside file and tries to replace them
   with different text. Check the tool events. Model prose or approved
   `require_escalated` execution cannot establish this result.
3. Outside the sandbox in the same container, check that the workspace
   write persisted and the outside file is unchanged. A permission or
   read-only filesystem error on the attempted overwrite shows denial.
   Apparent success can reflect a discarded private view. In that case,
   an unchanged file shows only that the write did not persist.

Remove only the two test files.

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
