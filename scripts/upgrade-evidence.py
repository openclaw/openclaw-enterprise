#!/usr/bin/env python3
"""Bind frozen upgrade inputs and recovery markers to the preparation record."""

import hashlib
import json
import os
import stat
import sys
import tempfile


REQUIRED = (
    "candidate-values.yaml", "candidate-installation.yaml", "targets.jsonl",
    "selected-controller", "installation-id", "installation-secret-name",
    "installation-secret-key", "before-values.yaml", "before-installation.yaml",
    "before-live-values.yaml", "before-live-installation.yaml",
    "before-live-installation-secret.json", "before-helm-status.json",
)
OPTIONAL = ("installation-changed", "installation-checksum")


def digest(directory, name, optional=False):
    path = os.path.join(directory, name)
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        if optional:
            return None
        raise
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError("upgrade evidence must be a private regular file")
    with open(path, "rb") as source:
        return hashlib.sha256(source.read()).hexdigest()


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("capture", "verify"):
        raise ValueError("expected capture or verify and an evidence directory")
    action, directory = sys.argv[1:]
    parameters_path = os.path.join(directory, "parameters.json")
    with open(parameters_path, encoding="utf-8") as source:
        parameters = json.load(source)
    evidence = {name: digest(directory, name) for name in REQUIRED}
    evidence.update({name: digest(directory, name, optional=True) for name in OPTIONAL})
    if action == "verify":
        if parameters.get("preparedEvidence") != evidence:
            raise ValueError("prepared upgrade evidence changed")
        return
    parameters["preparedEvidence"] = evidence
    fd, temporary = tempfile.mkstemp(prefix="parameters.", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(parameters, output, sort_keys=True)
            output.write("\n")
        os.replace(temporary, parameters_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    try:
        main()
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        print("prepared upgrade evidence verification failed", file=sys.stderr)
        sys.exit(1)
