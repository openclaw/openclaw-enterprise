#!/usr/bin/env python3
"""Record, suspend and terminate only the rehearsal's real Helm upgrade client."""
import json
import os
from pathlib import Path
import signal
import sys
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def process(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return fields[0], fields[19]
    except FileNotFoundError:
        return None


if Path(sys.argv[0]).name == "helm":
    executable = os.environ["OCE_REHEARSAL_HELM"]
    arguments = sys.argv[1:]
    if arguments[:3] == ["upgrade", "--install", os.environ["OCE_REHEARSAL_RELEASE"]] and not any(
        arg.startswith("--dry-run") for arg in arguments
    ):
        receipt = Path(os.environ["OCE_REHEARSAL_HELM_CLIENT"])
        record = {"pid": os.getpid(), "startTicks": process(os.getpid())[1],
                  "processGroup": os.getpgrp(),
                  "executable": os.path.realpath(executable), "arguments": arguments}
        descriptor = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(record, output)
            output.flush()
            os.fsync(output.fileno())
    os.execv(executable, [executable, *arguments])

receipt = json.loads(Path(sys.argv[1]).read_text())
action = sys.argv[2]
require(action in ("stop", "kill", "absent"), "unsupported client action")
pid = receipt["pid"]
# Pin the process before reading /proc; PID reuse after validation must never
# redirect either signal to an unrelated process. This fixture is Linux-only.
try:
    descriptor = os.pidfd_open(pid)
except ProcessLookupError:
    descriptor = None
observed = process(pid)
same_process = observed is not None and observed[1] == receipt["startTicks"]
if action == "kill" and (not same_process or observed[0] == "Z"):
    print(json.dumps({"pid": pid, "startTicks": receipt["startTicks"], "alreadyExited": True}))
    sys.exit(0)
if action == "absent":
    require(not same_process, "the original Helm client has not been reaped")
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
        except FileNotFoundError:
            continue
        require(int(fields[2]) != receipt["processGroup"], "an owned helper process is still running")
    print(json.dumps({"pid": pid, "startTicks": receipt["startTicks"],
                      "processGroup": receipt["processGroup"], "reaped": True}))
    sys.exit(0)
require(same_process, "the owned Helm client exited before interruption")
require(descriptor is not None, "the owned Helm client exited before interruption")
require(os.path.realpath(f"/proc/{pid}/exe") == receipt["executable"], "Helm executable changed")
arguments = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
require([arg.decode() for arg in arguments[1:-1]] == receipt["arguments"], "Helm arguments changed")
try:
    signal.pidfd_send_signal(descriptor, signal.SIGSTOP if action == "stop" else signal.SIGKILL)
except ProcessLookupError:
    if action != "kill":
        raise
    print(json.dumps({"pid": pid, "startTicks": receipt["startTicks"], "alreadyExited": True}))
    sys.exit(0)
finally:
    os.close(descriptor)
if action == "stop":
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        observed = process(pid)
        require(observed is not None and observed[1] == receipt["startTicks"],
                "the owned Helm client exited while stopping")
        if observed[0] == "T":
            break
        time.sleep(0.01)
    else:
        raise RuntimeError("Helm client did not stop")
print(json.dumps({"pid": pid, "startTicks": receipt["startTicks"], "action": action}))
