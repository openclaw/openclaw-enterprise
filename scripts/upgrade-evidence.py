#!/usr/bin/env python3
"""Bind frozen upgrade inputs and recovery markers to the preparation record."""

import hashlib
import json
import os
import re
import stat
import sys
import tempfile


REQUIRED = (
    "candidate-values.yaml", "candidate-installation.yaml", "targets.jsonl",
    "selected-controller", "installation-id", "installation-secret-name",
    "installation-secret-key", "before-values.yaml", "before-installation.yaml",
    "before-live-values.yaml", "before-live-installation.yaml",
    "before-live-installation-secret.json", "before-helm-status.json",
    "prepared-helm-attempt.json",
)
OPTIONAL = ("before-candidate-installation-secret.json", "installation-changed", "installation-checksum", "agent-continuity.json", "controller-compatibility-results.json")


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


def validate_compatibility(path, released, candidate):
    with open(path, encoding="utf-8") as source:
        receipt = json.load(source)
    file_path = "tests/integration/postgres-migration-compatibility.test.mjs"
    required_cases = (
        "Released controller remains usable across candidate database writes",
        "Released controller remains usable after configured IAM activation",
    )
    if (not isinstance(receipt, dict) or type(receipt.get("version")) is not int or
            receipt["version"] != 1 or receipt.get("command") != "run" or
            receipt.get("lane") != "postgres" or receipt.get("scope") not in ("full", "focused") or
            not re.fullmatch(r"[a-f0-9]{40}", receipt.get("sourceSha", "")) or
            receipt.get("status") != "passed" or type(receipt.get("exitCode")) is not int or
            receipt["exitCode"] != 0 or receipt.get("issues") != []):
        raise ValueError("invalid PostgreSQL run receipt")
    files = receipt.get("files")
    if not isinstance(files, list) or not all(isinstance(item, dict) for item in files):
        raise ValueError("invalid file results")
    if receipt["scope"] == "focused" and len(files) != 1:
        raise ValueError("focused run must contain one file")
    # The producer counts test rows, then sums each file into the run summary.
    totals = dict.fromkeys(("passed", "failed", "skipped", "todo", "total"), 0)
    for item in files:
        tests = item.get("tests")
        if (not isinstance(tests, list) or not tests or
                not all(isinstance(test, dict) and "skip" not in test and "todo" not in test and
                        test.get("status") in
                        ("passed", "failed", "skipped", "todo") for test in tests)):
            raise ValueError("invalid test results")
        counts = {key: sum(test["status"] == key for test in tests)
                  for key in ("passed", "failed", "skipped", "todo")}
        counts["total"] = len(tests)
        recorded = item.get("counts", {})
        if (recorded != counts or not all(type(value) is int for value in recorded.values()) or
                item.get("status") != "passed" or type(item.get("nodeExitCode")) is not int or
                item["nodeExitCode"] != 0 or item.get("signal", "missing") is not None or
                item.get("issues") != [] or "fileFailure" in item or
                any(counts[key] != 0 for key in ("failed", "skipped", "todo")) or
                (item.get("cleanup") is not None and item["cleanup"].get("status") != "passed")):
            raise ValueError("inconsistent file result")
        for key in totals:
            totals[key] += counts[key]
    if (receipt.get("counts") != totals or
            not all(type(value) is int for value in receipt["counts"].values())):
        raise ValueError("inconsistent run counts")
    matches = [item for item in files if item.get("path") == file_path]
    if len(matches) != 1:
        raise ValueError("expected one compatibility file result")
    result = matches[0]
    counts = result["counts"]
    if (result.get("cleanup", {}).get("status") != "passed" or counts["passed"] == 0 or
            counts["passed"] != counts["total"]):
        raise ValueError("compatibility file or cleanup did not pass")
    tests = result["tests"]
    for name in required_cases:
        selected = [item for item in tests if item.get("name") == name]
        if (len(selected) != 1 or selected[0].get("status") != "passed" or
                selected[0].get("file") != file_path):
            raise ValueError("selected compatibility case did not pass")
    # The runner records the reference suffix, not a platform manifest or config ID.
    for role, reference in (("releasedController", released), ("candidateController", candidate)):
        expected = reference.rsplit("@", 1)[-1]
        if (not re.fullmatch(r"sha256:[a-f0-9]{64}", expected) or
                result.get("imageDigests", {}).get(role) != expected):
            raise ValueError("compatibility image selection does not match")


def main():
    if len(sys.argv) == 5 and sys.argv[1] == "compatibility":
        validate_compatibility(*sys.argv[2:])
        return
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
    except (OSError, AttributeError, TypeError, ValueError, json.JSONDecodeError):
        print("controller compatibility receipt verification failed" if sys.argv[1:2] == ["compatibility"]
              else "prepared upgrade evidence verification failed", file=sys.stderr)
        sys.exit(1)
