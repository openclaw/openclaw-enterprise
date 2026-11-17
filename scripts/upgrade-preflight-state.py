#!/usr/bin/env python3
"""Record preflight create boundaries and inspect identities for cleanup only."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


FORMAT = "upgrade-preflight-v1"
MIGRATION_ATTEMPT = re.compile(r"migration-preflight-resume\.[A-Za-z0-9]+")
RESUME_ATTEMPT = re.compile(r"upgrade-preflight-resume\.[A-Za-z0-9]+")
JOURNAL = "preflight-journal.json"
PLAN = "preflight-plan.json"
JOBS = ("api", "worker", "migration")
KINDS = {"networkpolicy": "networkpolicy.networking.k8s.io", "secret": "secret",
         **{slot: "job.batch" for slot in JOBS}}
HASHES = {
    "scriptSha256": "upgrade-production-images",
    "startupPreflightSha256": "upgrade-startup-preflight.ts",
    "preflightStateSha256": "upgrade-preflight-state.py",
    "preflightCleanupSha256": "lib/upgrade-preflight-cleanup.sh",
}


class InvalidEvidence(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidEvidence(message)


def identity(info):
    return {"st_dev": info.st_dev, "st_ino": info.st_ino}


def directory(path):
    path = Path(os.path.abspath(path))
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) == 0o700,
            "evidence directories must be owned by this user with mode 0700")
    # Existing operator paths may traverse a parent alias (including /var on
    # macOS). Refuse a symlink at the evidence leaf, then bind its real inode.
    path = Path(os.path.realpath(path))
    require(identity(path.stat()) == identity(info), "evidence directory changed while resolving")
    return path, identity(info)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate field in preflight evidence")
        result[key] = value
    return result


def read(path, acknowledgement=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 1048576,
                "preflight evidence must be a bounded owner-only regular file")
        if acknowledgement and os.path.lexists(path.with_name("." + path.name + ".tmp")):
            # Publication can stop between linking the final receipt and removing
            # its fixed staging name. Only that exact additional link is accepted.
            staging = path.with_name("." + path.name + ".tmp").lstat()
            require(info.st_nlink == 2 and identity(staging) == identity(info),
                    "unexpected acknowledgement hardlink")
        else:
            require(info.st_nlink == 1, "unexpected evidence hardlink")
        with os.fdopen(os.dup(fd), "r", encoding="utf-8") as source:
            value = json.load(source, object_pairs_hook=unique_keys)
        require(identity(path.lstat()) == identity(info), "evidence changed while reading")
        # A valid final receipt observed after an interrupted publisher becomes
        # durable before cleanup is authorized. Missing receipts remain unknown.
        os.fsync(fd)
        return value
    finally:
        os.close(fd)


def write(path, value, replace=False):
    fd, staging = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(encoded(value))
            output.flush()
            os.fsync(output.fileno())
        if replace:
            os.replace(staging, path)
        else:
            os.link(staging, path)
            os.unlink(staging)
        sync_directory(path.parent)
    finally:
        if os.path.lexists(staging):
            os.unlink(staging)


def parameters(root):
    value = read(root / "parameters.json")
    require(isinstance(value, dict), "invalid upgrade parameters")
    value = {key: item for key, item in value.items()
             if key not in ("pairEvidence", "preparedEvidence", "dispatchJournal")}
    require(value.get("evidenceDirectory") == {"path": str(root), **identity(root.stat())},
            "evidence directory does not match the original run")
    arguments = value.get("arguments")
    require(isinstance(arguments, list) and len(arguments) == 15
            and all(isinstance(item, str) for item in arguments), "invalid upgrade arguments")
    return value


def journal(root):
    value = read(root / JOURNAL)
    require(isinstance(value, dict) and set(value) == {"format", "parametersSha256", "attempts"}
            and value["format"] == FORMAT and isinstance(value["attempts"], dict),
            "unsupported or invalid preflight journal")
    require(value["parametersSha256"] == digest(parameters(root)), "original upgrade parameters changed")
    return value


def attempt_directory(root, name):
    require(name == "." or MIGRATION_ATTEMPT.fullmatch(name) or RESUME_ATTEMPT.fullmatch(name),
            "invalid preflight attempt name")
    return directory(root if name == "." else root / name)


def plan_slots(parameters_value, name, suffix, network_policy):
    require(re.fullmatch(r"[0-9a-f]{8}", suffix) is not None, "invalid preflight suffix")
    release = parameters_value["arguments"][3]
    namespace = parameters_value["arguments"][2]
    require(is_name(release) and is_name(namespace), "invalid preflight target name")
    prefix = release[:26].rstrip(".")
    jobs = JOBS if name == "." or RESUME_ATTEMPT.fullmatch(name) else ("migration",)
    slots = {slot: {"kind": KINDS[slot], "name": prefix + "-upgrade-preflight-" + slot + "-" + suffix}
             for slot in jobs}
    if name == "." or RESUME_ATTEMPT.fullmatch(name):
        slots["secret"] = {"kind": KINDS["secret"], "name": release + "-upgrade-preflight-" + suffix}
        slots["networkpolicy"] = ({"kind": KINDS["networkpolicy"], "name": slots["secret"]["name"]}
                                  if network_policy else None)
    else:
        require(not network_policy, "migration-only attempts cannot plan a network policy")
    require(all(value is None or is_name(value["name"]) for value in slots.values()),
            "invalid planned resource name")
    return slots


def is_name(value):
    return isinstance(value, str) and len(value) <= 253 and re.fullmatch(
        r"[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?", value) is not None


def load_plan(root, name, entry):
    path, physical = attempt_directory(root, name)
    require(isinstance(entry, dict) and set(entry) == {"directory", "planSha256"}
            and entry["directory"] == physical, "registered attempt directory changed")
    plan = read(path / PLAN)
    require(isinstance(plan, dict) and set(plan) == {"format", "attempt", "suffix", "networkPolicy", "slots"}
            and plan["format"] == FORMAT and plan["attempt"] == name
            and isinstance(plan["networkPolicy"], bool), "invalid preflight plan")
    require(entry["planSha256"] == digest(plan), "registered preflight plan changed")
    require(plan["slots"] == plan_slots(parameters(root), name, plan["suffix"], plan["networkPolicy"]),
            "preflight plan does not match its original target")
    return path, plan


def check_attempt_index(root, attempts):
    names = ["."] + [entry.name for entry in root.iterdir() if MIGRATION_ATTEMPT.fullmatch(entry.name) or RESUME_ATTEMPT.fullmatch(entry.name)]
    facts = ["preflight-" + slot + suffix for slot in KINDS
             for suffix in ("-started.json", "-identity.json")]
    facts += ["preflight-" + slot + "-pod-identity.json" for slot in JOBS]
    # A staged ACK also follows a create; an unregistered plan alone does not.
    facts += ["." + name + ".tmp" for name in facts if name.endswith("-identity.json")]
    for name in names:
        if name in attempts:
            continue
        path, _ = attempt_directory(root, name)
        require(not any(os.path.lexists(path / fact) for fact in facts),
                "create evidence exists for an unregistered preflight attempt")


def inspect(root, kubeconfig, context, namespace, release):
    params = parameters(root)
    require(params["arguments"][:4] == [kubeconfig, context, namespace, release],
            "cleanup target differs from the original upgrade")
    require(hashlib.sha256(Path(kubeconfig).read_bytes()).hexdigest() == params["kubeconfigSha256"],
            "original kubeconfig changed")
    for field, relative in HASHES.items():
        require(hashlib.sha256((Path(__file__).resolve().parent / relative).read_bytes()).hexdigest()
                == params.get(field), "cleanup requires the original helper source")
    state = journal(root)
    check_attempt_index(root, state["attempts"])
    result = {"resources": [], "children": [], "consumerUnknown": False, "unknown": []}
    for name, entry in state["attempts"].items():
        path, plan = load_plan(root, name, entry)
        acknowledgements = {}
        for slot in KINDS.keys() - plan["slots"].keys():
            for suffix in ("-started.json", "-identity.json"):
                require(not os.path.lexists(path / ("preflight-" + slot + suffix)),
                        "evidence exists for a slot outside the registered plan")
            require(not os.path.lexists(path / (".preflight-" + slot + "-identity.json.tmp")),
                    "staged acknowledgement exists for a slot outside the registered plan")
        for slot, planned in plan["slots"].items():
            started_path = path / ("preflight-" + slot + "-started.json")
            ack_path = path / ("preflight-" + slot + "-identity.json")
            started = os.path.lexists(started_path)
            ack = os.path.lexists(ack_path)
            staged = os.path.lexists(path / (".preflight-" + slot + "-identity.json.tmp"))
            require(planned is not None or not (started or ack or staged), "unplanned preflight resource evidence")
            if not started:
                require(not (ack or staged), "acknowledgement has no recorded create boundary")
                continue
            require(read(started_path) == {"planSha256": entry["planSha256"], "slot": slot},
                    "invalid preflight create boundary")
            if not ack:
                result["unknown"].append(name + ":" + slot)
                result["consumerUnknown"] |= slot in JOBS
                continue
            record = read(ack_path, acknowledgement=True)
            require(isinstance(record, dict) and set(record) == {"kind", "name", "uid"}
                    and {key: record[key] for key in ("kind", "name")} == planned
                    and valid_uid(record["uid"]), "acknowledgement does not match its plan")
            acknowledgements[slot] = record
            options = {"apiVersion": "v1", "kind": "DeleteOptions", "propagationPolicy": "Background",
                       "preconditions": {"uid": record["uid"]}}
            result["resources"].append(record["kind"] + "/" + record["name"] + " "
                                       + json.dumps(options, separators=(",", ":")))
        for slot in JOBS:
            child = path / ("preflight-" + slot + "-pod-identity.json")
            if os.path.lexists(child) or os.path.lexists(child.with_name("." + child.name + ".tmp")):
                require(slot in acknowledgements, "child acknowledgement has no acknowledged Job")
                if not os.path.lexists(child):
                    continue
                record = read(child, acknowledgement=True)
                require(isinstance(record, dict) and set(record) == {"kind", "name", "uid"}
                        and record["kind"] == "pod" and is_name(record["name"])
                        and valid_uid(record["uid"]), "invalid child acknowledgement")
                result["children"].append(acknowledgements[slot]["uid"] + " "
                                          + record["name"] + " " + record["uid"])
        sync_directory(path)
    sync_directory(root)
    return result


def valid_uid(value):
    return isinstance(value, str) and bool(value) and value.isprintable() and not any(
        character.isspace() for character in value)


def main():
    action, root_name, *args = sys.argv[1:]
    root, physical = directory(root_name)
    if action == "lock" and len(args) == 1:
        fd = int(args[0])
        require(identity(os.fstat(fd)) == physical and stat.S_ISDIR(os.fstat(fd).st_mode),
                "lock descriptor differs from the evidence directory")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    elif action == "init" and not args:
        write(root / JOURNAL, {"format": FORMAT, "parametersSha256": digest(parameters(root)), "attempts": {}})
    elif action == "register" and len(args) == 3:
        name, suffix, policy = args
        require(policy in ("true", "false"), "invalid network-policy selection")
        state = journal(root)
        require(name not in state["attempts"], "preflight attempt already registered")
        path, physical = attempt_directory(root, name)
        plan = {"format": FORMAT, "attempt": name, "suffix": suffix, "networkPolicy": policy == "true",
                "slots": plan_slots(parameters(root), name, suffix, policy == "true")}
        write(path / PLAN, plan)
        state["attempts"][name] = {"directory": physical, "planSha256": digest(plan)}
        write(root / JOURNAL, state, replace=True)
    elif action == "started" and len(args) == 2:
        name, slot = args
        state = journal(root)
        require(name in state["attempts"], "preflight attempt is not registered")
        path, plan = load_plan(root, name, state["attempts"][name])
        require(slot in plan["slots"] and plan["slots"][slot] is not None, "preflight slot is not planned")
        write(path / ("preflight-" + slot + "-started.json"),
              {"planSha256": state["attempts"][name]["planSha256"], "slot": slot})
    elif action == "inspect" and len(args) == 4:
        print(json.dumps(inspect(root, *args), separators=(",", ":")))
    else:
        raise InvalidEvidence("invalid preflight state command")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        # Paths and JSON parser messages can contain operator input; emit only
        # our bounded contract errors, never retained credential-bearing content.
        message = str(error) if isinstance(error, InvalidEvidence) else "invalid or unavailable preflight evidence"
        print("preflight state: " + message, file=sys.stderr)
        sys.exit(1)
