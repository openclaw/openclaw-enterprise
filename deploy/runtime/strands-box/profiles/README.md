# Stock Box 0.3.1 node profiles and lab checks

Experimental scope is Ubuntu ARM64 with AppArmor ABI 4, Linux 6.8.0-147-generic,
K3s 1.35.10 and containerd 2.2.10-k3s1 using runc. Use an isolated node for
qualification. Do not change RuntimeDefault or disable Pod Security. These
profiles provide no admission policy.

The two diagnostic fixtures run as UID/GID 1000. OCE Pods run as UID/GID 1000
and need a separate installed check. Run the Restricted control with private user and PID namespaces,
all capabilities dropped, no privilege escalation and both profiles set to
RuntimeDefault. Use the control container's CRI ID to extract the actual node
defaults. Keep any full inspect output private.

```sh
crictl inspect "$control_id" | jq '.info.runtimeSpec.linux' >linux.json
python3 seccomp.py <linux.json >oce-strands-box-v0.3.1.json
jq '{maskedPaths,readonlyPaths}' linux.json >defaults.json
```

The generator rejects changes to the observed path sets and ARM64 syscall
policy. Review the generated file and the AppArmor policy before installing
them. Install the JSON at the root of the kubelet seccomp directory. Load
`oce-strands-box-v0.3.1.apparmor` in enforce mode. Restrict these Localhost
profiles to the approved stock launcher. A profile name and enforcement mode
cannot attest the loaded policy's contents. Node operators own that check and
must repeat qualification after changes.

The outer container requests unmasked procfs. AppArmor denies opening the
sensitive entries but permits observation of their metadata. The launcher
adds existing proc entries to the Box filesystem deny list. Box replaces them
in the private workload mount namespace. The workload receives no protected
sysfs grants. The launch guards check the enforced profile, privilege state
and nested mask devices. They are startup checks. Optional paths that appear
later are still covered by AppArmor but may expose metadata.

## Compare the workload with a same-node control

Use a disposable image with the verified release binaries, Python 3,
`/probe.py` and the extracted `/defaults.json`. Use the same image and node
for both measurements. Do not add provider keys or an application sandbox.

1. Run `python3 /probe.py control` under the Restricted settings above.
2. With the stock launcher security settings, run `python3 /probe.py outer`
   before starting Box. Set the Box agent command to
   `["/usr/bin/python3", "/probe.py", "inner"]`. Grant read access to the
   probe, defaults file and Python standard library. Populate
   `agent.filesystem.deny` from the same existing proc entries as
   `prepareStockConfig`. A separate containerd fixture tests the node
   settings without granting the test image access to the installed admission
   exception.
3. Save each exited container's CRI inspect result as `control-inspect.json`
   or `box-inspect.json`. Save the probe's JSON lines as `control.jsonl`
   and `workload.jsonl`. Run `python3 compare.py DIRECTORY` against those
   four files. Separately verify same-node placement and the node artifacts.

The probe records kernel path metadata, read-only opens, write permission and
mount flags. It reads no protected file contents and performs no writes.
It starts a child executable to check inheritance. The comparison checks
effective UID and GID against each container's private user namespace and
requires the single inner ID 0 to map to outer ID 1000. It checks
each configured root, including whether a mask still exposes the underlying
filesystem device. It does not enumerate descendants, test every access
method, prove supervisor credential isolation or exercise OCE admission.
An installed Agent and its application traffic need separate validation.
