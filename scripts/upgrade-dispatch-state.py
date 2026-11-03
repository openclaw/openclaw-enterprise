#!/usr/bin/env python3
"""Keep Agent deploy decisions outside restorable upgrade evidence."""

import fcntl
import hashlib
import json
import os
import stat
import sys
import uuid


JOURNAL_FORMAT = "upgrade-dispatch-v2"


def identity(info):
    return info.st_dev, info.st_ino


def private_file(info):
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_uid == os.geteuid()
        and info.st_nlink == 1
        and stat.S_IMODE(info.st_mode) == 0o600
    )


def check_file(path, fd):
    opened = os.fstat(fd)
    named = os.lstat(path)
    if not private_file(opened) or not private_file(named) or identity(opened) != identity(named):
        raise ValueError("the dispatch journal must be the original owner-only regular file")
    return opened


def append(fd, record):
    data = (json.dumps(record, separators=(",", ":")) + "\n").encode()
    if os.write(fd, data) != len(data):
        raise OSError("incomplete dispatch journal write")
    os.fsync(fd)


def protected_parent(path):
    # A sticky directory (such as /tmp) also protects this private file from
    # removal by another non-owner. The journal stays beside the evidence.
    parent = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(parent)
        if info.st_uid not in (0, os.geteuid()) or (
            info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX
        ):
            raise ValueError("the dispatch journal's parent must protect files from other users")
        return parent
    except BaseException:
        os.close(parent)
        raise


def create(path, operation):
    parent = protected_parent(path)
    try:
        fd = os.open(
            os.path.basename(path),
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent,
        )
        try:
            token = uuid.uuid4().hex
            append(fd, [JOURNAL_FORMAT, operation, token])
            os.fsync(parent)
            print(json.dumps([*identity(os.fstat(fd)), token]))
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def lock(path, fd):
    check_file(path, fd)
    try:
        # Bash holds this open file description for the upgrade and its child
        # commands. A replaced evidence directory cannot create another lock.
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise ValueError("the dispatch journal is locked by another upgrade") from error
    info = check_file(path, fd)
    data = os.pread(fd, info.st_size, 0)
    if len(data) != info.st_size or check_file(path, fd).st_size != info.st_size:
        raise ValueError("the dispatch journal changed while reading")
    if not data.endswith(b"\n"):
        raise ValueError("the dispatch journal is empty or has an incomplete record")
    return [json.loads(line) for line in data.splitlines()], identity(info)


def store(path, fd, record):
    out = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if identity(check_file(path, out)) != identity(check_file(path, fd)):
            raise ValueError("the dispatch journal changed while open")
        append(out, record)
    finally:
        os.close(out)


def fleet(path):
    with open(path, "rb") as source:
        data = source.read()
    targets = {}
    for line in data.splitlines():
        entry = json.loads(line)
        key = entry["namespaceId"], entry["agentId"]
        if key in targets or not all(isinstance(value, str) and value for value in key):
            raise ValueError("invalid dispatch targets")
        targets[key] = {**entry, "state": "ready", "deploymentId": None, "acceptedDeploymentIds": []}
    return hashlib.sha256(data).hexdigest(), targets


def accept_deployment(target, deployment_id):
    history = target["acceptedDeploymentIds"]
    if (
        not isinstance(deployment_id, str)
        or not deployment_id
        or deployment_id == target["baselineRevisionId"]
        or deployment_id in history
    ):
        raise ValueError("invalid or previously accepted deployment ID")
    history.append(deployment_id)
    target.update(state="accepted", deploymentId=deployment_id)


def transition(targets, action, namespace, agent, *args):
    key = namespace, agent
    target = targets[key]
    state = target["state"]
    if action == "send" and state in ("ready", "refused") and not args:
        target["state"] = "pending"
    elif action == "refuse" and state == "pending" and not args:
        target["state"] = "refused"
    elif action == "accept" and state == "pending" and len(args) == 1:
        accept_deployment(target, args[0])
    elif (
        action == "replace"
        and state == "accepted"
        and len(args) == 2
        and args[0] == target["deploymentId"]
    ):
        accept_deployment(target, args[1])
    else:
        raise ValueError("invalid dispatch journal transition")


def main():
    action, path, *args = sys.argv[1:]
    if action == "create":
        create(path, *args)
        return

    if action == "check-path":
        parent = protected_parent(path)
        try:
            if not private_file(os.stat(os.path.basename(path), dir_fd=parent, follow_symlinks=False)):
                raise ValueError("the dispatch journal must be an owner-only regular file")
        finally:
            os.close(parent)
        return

    inherited_fd, expected_binding, operation, *args = args
    fd = int(inherited_fd)
    records, file_identity = lock(path, fd)
    binding = json.loads(expected_binding)
    if binding[:2] != list(file_identity) or records[0] != [JOURNAL_FORMAT, operation, binding[2]]:
        raise ValueError("the dispatch journal belongs to a different upgrade")
    if action == "lock":
        return

    targets_path, *args = args
    digest, targets = fleet(targets_path)
    prepared = ["fleet", digest]
    if action == "prepare":
        if len(records) != 1:
            raise ValueError("the dispatch journal is already prepared")
        store(path, fd, prepared)
        return
    if len(records) < 2 or records[1] != prepared:
        raise ValueError("the dispatch journal's prepared targets changed")
    for record in records[2:]:
        transition(targets, *record)
    if action in ("snapshot", "deployments"):
        if action == "snapshot":
            rows = targets.values()
        else:
            if any(target["state"] != "accepted" for target in targets.values()):
                raise ValueError("the dispatch journal contains incomplete deployments")
            fields = ("namespaceId", "agentId", "executionMode", "deploymentId")
            rows = ({field: target[field] for field in fields} for target in targets.values())
        for row in rows:
            print(json.dumps(row, separators=(",", ":")))
        return
    transition(targets, action, *args)
    store(path, fd, [action, *args])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, IndexError, KeyError, TypeError) as error:
        print(f"upgrade dispatch journal: {error}", file=sys.stderr)
        sys.exit(1)
