"""Run as control, outer Box launcher, or contained agent in disposable lab only."""

import errno
import json
import os
from pathlib import Path
import stat
import subprocess
import sys


def path_access(name):
    try:
        entry = os.stat(name)
        if stat.S_ISCHR(entry.st_mode) and entry.st_rdev == os.makedev(1, 3):
            return "masked-null"
        fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK)
        os.close(fd)
    except OSError as error:
        return errno.errorcode[error.errno]
    return "open"


def main(role):
    defaults = json.loads(Path("/defaults.json").read_text())
    paths = sorted(defaults["maskedPaths"] + defaults["readonlyPaths"])
    labels = Path("/proc/self/attr/current").read_text().rstrip("\n\0")
    status = dict(
        line.split(":", 1)
        for line in Path("/proc/self/status").read_text().splitlines()
    )
    print(
        json.dumps(
            {
                "role": role,
                "label": labels,
                "uid": os.geteuid(),
                "gid": os.getegid(),
                "mappings": {
                    key: [
                        list(map(int, line.split()))
                        for line in Path(f"/proc/self/{key}_map")
                        .read_text()
                        .splitlines()
                    ]
                    for key in ("uid", "gid")
                },
                "namespaces": {
                    name: os.stat("/proc/self/ns/" + name).st_ino
                    for name in ("pid", "mnt", "user", "net")
                },
                "status": {
                    k: status[k].strip()
                    for k in ("NoNewPrivs", "CapEff", "Seccomp", "Seccomp_filters")
                },
                "paths": {
                    p: {
                        "open": path_access(p),
                        "writable": os.access(p, os.W_OK),
                        "readonlyMount": os.path.exists(p)
                        and bool(os.statvfs(p).f_flag & os.ST_RDONLY),
                        "underlying": os.path.exists(p)
                        and os.stat(p).st_dev == os.stat("/" + p.split("/")[1]).st_dev,
                        "metadata": stat.filemode(os.stat(p).st_mode)
                        if os.path.exists(p)
                        else None,
                    }
                    for p in paths
                },
            }
        ),
        flush=True,
    )
    if role in ("inner", "control"):
        subprocess.run([sys.executable, __file__, role + "-child"], check=True)


if __name__ == "__main__":
    main(sys.argv[1])
