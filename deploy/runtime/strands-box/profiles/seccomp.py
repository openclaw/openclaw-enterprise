"""Build the lab-only Localhost profile from a checked containerd RuntimeDefault."""

import copy
import hashlib
import json
import sys

# Linux arm64, containerd 2.2.10-k3s1, nonroot user namespaces, drop ALL.
BASELINE = "e3ac895975aa081e0425db9a5144c6f04d916eecd29c24b2eef5af0b5fd01b12"


MASKED = {
    "/proc/acpi",
    "/proc/asound",
    "/proc/interrupts",
    "/proc/kcore",
    "/proc/keys",
    "/proc/latency_stats",
    "/proc/sched_debug",
    "/proc/scsi",
    "/proc/timer_list",
    "/proc/timer_stats",
    "/sys/firmware",
    "/sys/devices/virtual/powercap",
}
READONLY = {"/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"}


def generate(linux):
    if set(linux["maskedPaths"]) != MASKED or set(linux["readonlyPaths"]) != READONLY:
        raise ValueError("unreviewed containerd kernel paths")
    profile = copy.deepcopy(linux["seccomp"])
    canonical = json.dumps(profile, sort_keys=True, separators=(",", ":"))
    if hashlib.sha256(canonical.encode()).hexdigest() != BASELINE:
        raise ValueError("unreviewed RuntimeDefault")

    def allow(name, index, values):
        for value in values:
            profile["syscalls"].append(
                {
                    "names": [name],
                    "action": "SCMP_ACT_ALLOW",
                    "args": [{"index": index, "op": "SCMP_CMP_EQ", "value": value}],
                }
            )

    # Private user, mount/IPC/UTS/network, then PID namespaces.
    allow("unshare", 0, [0x10000000, 0x4C020000, 0x20000000])
    # Recursive private and bind, empty-file bind, fresh mounts and bind remounts.
    # AppArmor additionally restricts their targets to Box's staging tree.
    allow(
        "mount",
        3,
        [0x44000, 0x5000, 0x1000, 0x7, 0xE, 0xF, 0x102A, 0x102F, 0x1027, 0x102E],
    )
    profile["syscalls"].append({"names": ["pivot_root"], "action": "SCMP_ACT_ALLOW"})
    allow("umount2", 1, [2])  # MNT_DETACH
    return profile


if __name__ == "__main__":
    print(json.dumps(generate(json.load(sys.stdin)), indent=2))
