#!/usr/bin/env python3
"""Exercise the built launcher, including Box hardening and its real callback."""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def refusal(binary, environment, trace, prefix=()):
    result = subprocess.run(
        [*prefix, "strace", "-f", "-s", "256", "-e",
         "trace=prctl,prlimit64,openat,connect,execve", "-o", str(trace), str(binary)],
        env=environment, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode != 0, "invalid installation admitted"
    assert "on_ready callback failed: protected sender installation unavailable" in result.stderr, result.stderr
    events = trace.read_text()
    hardening = re.search(r"prctl\(PR_SET_DUMPABLE, (?:0|SUID_DUMP_DISABLE)\)\s+= 0", events)
    assert hardening, "Box did not successfully harden before sender initialization"
    # After PR_SET_DUMPABLE the tracer may no longer read pathname memory.
    # The callback-specific error proves it was reached. Only the nonsecret
    # pins may be read before hardening, never installation or key material.
    assert "installation.json" not in events[:hardening.start()], "early installation read"
    assert "connect(" not in events, "startup attempted networking"
    assert events.count("execve(") == 1, "startup executed a workload"
    assert "sensitive-input-marker" not in result.stderr


def main():
    binary = Path(sys.argv[1]).resolve(strict=True)
    installation = Path("/etc/oce-protected-sender/installation.json")
    if installation.exists():
        raise RuntimeError("run this negative control on a host without a sender installation")
    environment = {**os.environ, "EXPERIMENTAL_LINUX_SUPPORT": "TRUE"}
    with tempfile.TemporaryDirectory(prefix="oce-native-startup-") as directory:
        root = Path(directory)
        refusal(binary, environment, root / "missing.trace")
        print("PASS: missing installation refused in the hardened callback; no network or workload")
        inputs = root / "inputs"
        inputs.mkdir()
        (inputs / "pins.json").write_text("[]")
        prefix = ["bwrap", "--unshare-user", "--ro-bind", "/", "/",
                  "--bind", directory, directory, "--tmpfs", "/etc",
                  "--ro-bind", str(inputs), "/etc/oce-protected-sender", "--"]
        for label, content in [("malformed", "sensitive-input-marker{"), ("incomplete", "{}")]:
            (inputs / "installation.json").write_text(content)
            refusal(binary, environment, root / (label + ".trace"), prefix)
            print(f"PASS: {label} mounted installation refused in the hardened callback")
    result = subprocess.run(
        [str(binary), "run"], env=environment, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode != 0 and "no arguments accepted" in result.stderr, result.stderr
    print("PASS: workload arguments cannot select launcher inputs")


if __name__ == "__main__":
    main()
