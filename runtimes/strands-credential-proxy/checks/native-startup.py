#!/usr/bin/env python3
"""Exercise the built launcher, including Box hardening and its real callback."""
import argparse
from contextlib import contextmanager
import os
from pathlib import Path
import re
import stat
import subprocess
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


FIXTURE = Path("/etc/oce-protected-sender")


def checked_root_directory(expected):
    current = FIXTURE.lstat()
    assert (current.st_dev, current.st_ino) == expected, "fixture directory replaced"
    assert current.st_uid == 0 and stat.S_ISDIR(current.st_mode)
    assert stat.S_IMODE(current.st_mode) == 0o755, "fixture directory must be root-owned and nonwritable"


def checked_root_file(path):
    current = path.lstat()
    assert current.st_uid == 0 and stat.S_ISREG(current.st_mode)
    assert stat.S_IMODE(current.st_mode) == 0o644 and current.st_nlink == 1


@contextmanager
def hosted_fixture(content):
    # Only root can modify this exclusively created directory. Never adopt an
    # existing directory, even an empty one or a dangling symlink.
    subprocess.run(["sudo", "-n", "mkdir", "--mode=0755", "--", str(FIXTURE)], check=True)
    created = FIXTURE.lstat()
    identity = (created.st_dev, created.st_ino)
    files = {"pins.json": "[]", "installation.json": content}
    try:
        checked_root_directory(identity)
        for name, value in files.items():
            subprocess.run(
                ["sudo", "-n", "install", "--mode=0644", "/dev/stdin", str(FIXTURE / name)],
                input=value, text=True, check=True,
            )
        assert set(os.listdir(FIXTURE)) == set(files), "unexpected fixture entries"
        for name, value in files.items():
            checked_root_file(FIXTURE / name)
            assert (FIXTURE / name).read_text() == value, "fixture content mismatch"
        yield
    finally:
        checked_root_directory(identity)
        # No recursive deletion, glob, or cleanup of pre-existing paths. Partial
        # setup and a failed launcher assertion still remove these owned files.
        for name in files:
            path = FIXTURE / name
            if os.path.lexists(path):
                checked_root_file(path)
                subprocess.run(["sudo", "-n", "rm", "--", str(path)], check=True)
        subprocess.run(["sudo", "-n", "rmdir", "--", str(FIXTURE)], check=True)
        assert not os.path.lexists(FIXTURE), "fixture cleanup incomplete"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--hosted-fixture", action="store_true",
                        help="root-stage synthetic files on an explicitly disposable GitHub-hosted runner")
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    assert os.getuid() != 0 and os.geteuid() != 0, "run the checks and launcher as an ordinary user"
    installation = FIXTURE / "installation.json"
    if os.path.lexists(installation):
        raise RuntimeError("run this negative control on a host without a sender installation")
    if args.hosted_fixture:
        assert os.environ.get("GITHUB_ACTIONS") == "true"
        assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "hosted fixtures require a disposable runner"
        assert not os.path.lexists(FIXTURE), "refusing an existing fixture directory"
        subprocess.run(["sudo", "-n", "true"], check=True)
    environment = {**os.environ, "EXPERIMENTAL_LINUX_SUPPORT": "TRUE"}
    with tempfile.TemporaryDirectory(prefix="oce-native-startup-") as directory:
        root = Path(directory)
        # Diagnose unavailable tracing before any privileged fixture setup.
        subprocess.run(["strace", "-o", str(root / "preflight.trace"), "/usr/bin/true"], check=True)
        refusal(binary, environment, root / "missing.trace")
        print("PASS: missing installation refused in the hardened callback; no network or workload")
        inputs = root / "inputs"
        if not args.hosted_fixture:
            inputs.mkdir()
            (inputs / "pins.json").write_text("[]")
        for label, content in [("malformed", "sensitive-input-marker{"), ("incomplete", "{}")]:
            if args.hosted_fixture:
                with hosted_fixture(content):
                    refusal(binary, environment, root / (label + ".trace"))
            else:
                (inputs / "installation.json").write_text(content)
                prefix = ["bwrap", "--unshare-user", "--ro-bind", "/", "/",
                          "--bind", directory, directory, "--tmpfs", "/etc",
                          "--ro-bind", str(inputs), str(FIXTURE), "--"]
                refusal(binary, environment, root / (label + ".trace"), prefix)
            print(f"PASS: {label} mounted installation refused in the hardened callback")
    result = subprocess.run(
        [str(binary), "run"], env=environment, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode != 0 and "no arguments accepted" in result.stderr, result.stderr
    print("PASS: workload arguments cannot select launcher inputs")


if __name__ == "__main__":
    main()
