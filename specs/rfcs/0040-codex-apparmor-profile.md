---
status: Proposed
implementation_status: Not implemented
author: philbritton
---

# Select a node-installed AppArmor profile for dedicated Codex

- **ID:** RFC-0040
- **Created:** 2026-11-17

## Summary

Add optional `runtime.codexAppArmorProfile` to the Kubernetes Compute Driver. An
installation operator can select a reviewed, node-installed AppArmor profile
for the dedicated Codex container. This allows Codex to start its Linux sandbox
on nodes whose default AppArmor profile denies the sandbox mount setup.

## Motivation

Codex uses Bubblewrap to isolate shell commands. On an Azure Kubernetes Service
1.35.9 node running Ubuntu 24.04 and containerd 2.3.7, Codex 0.163.0-alpha.2
failed to start its sandbox after a compatible seccomp profile passed the
namespace checks. Bubblewrap failed at mount propagation and the container's
effective AppArmor profile, `cri-containerd.apparmor.d`, denied mount operations.
The Kubernetes Compute Driver can select a
[Codex seccomp profile](../../docs/reference/drivers/kubernetes-compute/configuration.md).
Seccomp and AppArmor enforce separate restrictions.

## Proposal

The installation operator supplies the exact name of an enforcing AppArmor
profile under `drivers.compute.configuration.runtime.codexAppArmorProfile`.
The Driver accepts a single explicit profile name with ASCII letters, digits,
periods, underscores, and hyphens, starting with a letter or digit.
The setting is optional. The Driver rejects malformed values during
configuration validation.

When the Agent deployment worker reconciles a dedicated Codex workload, the
Kubernetes Compute Driver sets the Codex container's
`securityContext.appArmorProfile` to type `Localhost` with this name as its
`localhostProfile`. With the setting omitted, Kubernetes uses its normal
runtime default on AppArmor-enabled nodes. The gateway, embedded gateway,
init containers, and other drivers keep their existing security contexts.
The dedicated Codex container retains its existing user, capability, privilege
escalation, and seccomp settings.

The cluster operator owns profile content, review, installation, and placement.
Use a versioned profile name and load the matching profile in enforce mode on
every eligible node before selecting it. Include replacements and upgrades in
node provisioning. Use existing workload placement settings to restrict
eligible nodes when needed. The Driver passes the profile name to Kubernetes.
The kubelet prevents the container from starting when the profile is unavailable.
Restore the profile on eligible nodes or select a valid profile and redeploy
through the normal Agent lifecycle. Cluster admission can restrict the
permitted names.

## Delivery and verification

- Pass the optional name through the supported installation profile renderer.
  Verify that the Driver rejects invalid names before workload creation.
- Deploy a dedicated Codex Agent through the normal Agent workflow. Inspect the
  admitted workload for the exact AppArmor profile on the Codex container and
  the existing security contexts on all other containers. Cover omission.
- On a compatible Kubernetes node, verify a sandboxed command with the exact
  Codex image, seccomp profile, and enforcing AppArmor profile. Compare it with
  the same workload using runtime-default AppArmor. Request an unloaded profile
  and verify that the Codex container cannot start.

## Rationale and alternatives

The existing per-container seccomp setting establishes the installation and
reconciliation boundary. An AppArmor selection at the same boundary limits
the change to dedicated Codex workloads and works with cluster admission.
Keeping only the runtime default requires operators to select nodes whose
default policy allows the sandbox. A Pod-wide profile would also affect init
containers in the dedicated workload.

## References

- [Kubernetes Compute Driver](../../docs/reference/drivers/kubernetes-compute.md)
- [Kubernetes AppArmor profiles](https://kubernetes.io/docs/tutorials/security/apparmor/)
- [Kubernetes Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
