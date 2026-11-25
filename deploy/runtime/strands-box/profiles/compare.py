"""Compare probe output and OCI specs from the same disposable node."""

import json
from pathlib import Path
import sys

from seccomp import MASKED, READONLY, generate

CONTROL = "cri-containerd.apparmor.d"
BOX = "oce-strands-box-v0.3.1"


def require(condition, context):
    if not condition:
        raise ValueError(context)


def inspect(filename, label):
    data = json.loads(filename.read_text())
    status = data["status"]
    spec = data["info"]["runtimeSpec"]
    require(status["state"] == "CONTAINER_EXITED" and status["exitCode"] == 0, label)
    require(spec["process"]["apparmorProfile"] == label, label)
    require(
        spec["process"]["user"]["uid"] == spec["process"]["user"]["gid"] == 1000, label
    )
    require(spec["process"]["noNewPrivileges"], label)
    require(
        {"pid", "mount", "user", "network"}.issubset(
            ns["type"] for ns in spec["linux"]["namespaces"]
        ),
        label,
    )
    return status["imageRef"], spec["linux"]


def records(filename, roles, label):
    reports = [json.loads(line) for line in filename.read_text().splitlines()]
    require(
        [report["role"] for report in reports] == roles, "missing or duplicate reports"
    )
    for report in reports:
        role = report["role"]
        require(report["label"] == label + " (enforce)", role)
        status = report["status"]
        require(status["NoNewPrivs"] == "1" and int(status["CapEff"], 16) == 0, role)
        require(status["Seccomp"] == "2" and int(status["Seccomp_filters"]) >= 1, role)
        require(set(report["paths"]) == MASKED | READONLY, role)
        require(set(report["namespaces"]) == {"mnt", "pid", "net", "user"}, role)
    # A new executable must inherit its parent's observations.
    require(
        {**reports[-1], "role": roles[-2]} == reports[-2], "exec changed protections"
    )
    return reports


def check(directory):
    image, baseline = inspect(directory / "control-inspect.json", CONTROL)
    candidate_image, candidate = inspect(directory / "box-inspect.json", BOX)
    require(image and image == candidate_image, "image mismatch")
    require(candidate["seccomp"] == generate(baseline), "seccomp mismatch")
    require(
        not candidate.get("maskedPaths") and not candidate.get("readonlyPaths"),
        "expected Unmasked",
    )
    control, _ = records(
        directory / "control.jsonl", ["control", "control-child"], CONTROL
    )
    outer, inner, _ = records(
        directory / "workload.jsonl", ["outer", "inner", "inner-child"], BOX
    )
    require(
        all(
            value != inner["namespaces"][key]
            for key, value in outer["namespaces"].items()
        ),
        "missing private namespace",
    )
    require(
        int(inner["status"]["Seccomp_filters"])
        > int(outer["status"]["Seccomp_filters"]),
        "missing nested filters",
    )
    for key in ("uid", "gid"):
        for report, linux in ((control, baseline), (outer, candidate)):
            (mapping,) = linux[key + "Mappings"]
            require(
                report[key] == 1000
                and mapping["containerID"] == 0
                and mapping["hostID"] >= 65536
                and mapping["size"] == 65536
                and report["mappings"][key] == [[0, mapping["hostID"], 65536]],
                f"unexpected {report['role']} {key} mapping",
            )
        require(
            inner[key] == 0 and inner["mappings"][key] == [[0, outer[key], 1]],
            f"unexpected inner {key} mapping",
        )
    present = 0
    for path in MASKED:
        reference = control["paths"][path]
        protected = inner["paths"][path]
        require(not reference["underlying"], path)
        require(not protected["underlying"] and not protected["writable"], path)
        require(outer["paths"][path]["open"] in ("ENOENT", "EACCES"), path)
        if protected["metadata"] is None:
            require(protected["open"] == "ENOENT", path)
        else:
            require(protected["open"] == "EACCES" and protected["readonlyMount"], path)
            present += 1
    for path in READONLY:
        for report in (control, inner):
            result = report["paths"][path]
            require(result["readonlyMount"] and not result["writable"], path)
    print(
        f"Box and child passed {present} replaced, {len(MASKED) - present} absent, "
        f"{len(READONLY)} read-only path checks."
    )


if __name__ == "__main__":
    check(Path(sys.argv[1]))
