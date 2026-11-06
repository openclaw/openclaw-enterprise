#!/usr/bin/env python3
"""Keep Helm submissions distinct and verify a same-candidate recovery."""

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077,
            "Helm evidence must be a private regular file")
    return path.read_bytes()


def load(path):
    return json.loads(read(path))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, data):
    with path.open("xb") as target:
        os.chmod(path, 0o600)
        target.write(data)
        target.flush()
        os.fsync(target.fileno())
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_json(path, value):
    write(path, (json.dumps(value, sort_keys=True) + "\n").encode())


def command(args, **kwargs):
    return subprocess.check_output(args, stderr=subprocess.PIPE, **kwargs)


def documents(data):
    converted = command(["yq", "-p=yaml", "-o=json", ".", "-"], input=data).decode()
    result = []
    decoder = json.JSONDecoder()
    while converted.strip():
        value, end = decoder.raw_decode(converted.lstrip())
        converted = converted.lstrip()[end:]
        require(isinstance(value, dict), "Helm YAML must contain mappings")
        result.append(value)
    require(result, "Helm YAML must not be empty")
    return result


def without_attempt(value):
    result = json.loads(json.dumps(value))
    result.setdefault("installation", {}).pop("upgradeAttemptId", None)
    if not result["installation"]:
        result.pop("installation")
    return result


def attempt(directory, nonce=None):
    if nonce is None:
        if (directory / "helm-started").exists():
            nonce = load(directory / "helm-started").get("attempt", {}).get("nonce")
        else:
            nonce = load(directory / "prepared-helm-attempt.json")["nonce"]
    require(isinstance(nonce, str) and str(uuid.UUID(nonce)) == nonce,
            "Helm submission intent has no valid upgrade-attempt binding")
    root = directory / "helm-attempts" / nonce
    record = load(root / "attempt.json")
    require(record == {"nonce": nonce, "valuesSha256": sha(read(root / "values.yaml")),
                       "renderedSha256": sha(read(root / "rendered.yaml"))},
            "Helm attempt evidence changed")
    if (directory / "helm-started").exists():
        require(load(directory / "helm-started")["attempt"] == record,
                "Helm submission does not match its attempt")
    else:
        require(load(directory / "prepared-helm-attempt.json") == record,
                "prepared Helm attempt changed")
    values = documents(read(root / "values.yaml"))[0]
    require(values.get("installation", {}).get("upgradeAttemptId") == nonce,
            "Helm values do not identify this attempt")
    require(without_attempt(values) == without_attempt(documents(read(directory / "candidate-values.yaml"))[0]),
            "Helm attempt changes the prepared candidate")
    return root, record


def new_attempt(directory, release, helm_args):
    nonce = str(uuid.uuid4())
    root = directory / "helm-attempts" / nonce
    root.mkdir(parents=True, mode=0o700)
    values = command(["yq", '.installation.upgradeAttemptId = strenv(OCE_UPGRADE_ATTEMPT)',
                      str(directory / "candidate-values.yaml")],
                     env={**os.environ, "OCE_UPGRADE_ATTEMPT": nonce})
    write(root / "values.yaml", values)
    chart = "deploy/helm/openclaw-enterprise"
    write(root / "rendered.yaml", command(["helm", "template", release, chart, *helm_args,
                                           "--is-upgrade", "--values", str(root / "values.yaml")]))
    write(root / "server-dry-run.txt", command(["helm", "upgrade", "--install", release, chart,
                                               *helm_args, "--values", str(root / "values.yaml"),
                                               "--dry-run=server", "--hide-secret"]))
    record = {"nonce": nonce, "valuesSha256": sha(values),
              "renderedSha256": sha(read(root / "rendered.yaml"))}
    write_json(root / "attempt.json", record)
    if not (directory / "prepared-helm-attempt.json").exists():
        write_json(directory / "prepared-helm-attempt.json", record)
    print(nonce)


def record_submission(directory, nonce):
    root = directory / "helm-attempts" / nonce
    record = load(root / "attempt.json")
    current = load(directory / "before-helm-submission.json")
    version = current["version"]
    require(type(version) is int and version > 0, "invalid prior Helm revision")
    intent = {"previousRevision": version, "expectedRevision": version + 1, "attempt": record}
    write_json(root / "intent.json", intent)
    staged = root / "helm-started.tmp"
    write_json(staged, intent)
    destination = directory / "helm-started"
    if destination.exists() or destination.is_symlink():
        read(destination)
    os.replace(staged, destination)
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


ATTEMPT_ANNOTATION = "openclaw.dev/upgrade-attempt"


def resource_key(value):
    metadata = value["metadata"]
    return value["apiVersion"], value["kind"], metadata.get("namespace", ""), metadata["name"]


def resource_map(values):
    result = {resource_key(value): value for value in values}
    require(len(result) == len(values), "duplicate Helm resources")
    return result


def contains(actual, expected):
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(key in actual and contains(actual[key], value)
                                               for key, value in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            contains(left, right) for left, right in zip(actual, expected))
    return actual == expected


def release_matches(state, rendered, values, release, namespace):
    require(state["name"] == release and state["namespace"] == namespace,
            "Helm recovery identifies another release")
    require(state.get("config", {}) == documents(read(values))[0],
            "Helm recovery values differ from the selected attempt")
    expected = documents(read(rendered))
    ordinary = [item for item in expected if not item.get("metadata", {}).get("annotations", {}).get("helm.sh/hook")]
    require(resource_map(documents(state["manifest"].encode())) == resource_map(ordinary),
            "Helm recovery manifest differs from the selected attempt")
    hooks = state.get("hooks", [])
    expected_hooks = [item for item in expected if item not in ordinary]
    actual_hooks = [documents(item["manifest"].encode())[0] for item in hooks]
    require(resource_map(actual_hooks) == resource_map(expected_hooks),
            "Helm recovery hook set differs from the selected attempt")
    require(hooks and all(set(item.get("events", [])) <= {"pre-install", "pre-upgrade"}
                          and "pre-upgrade" in item.get("events", []) for item in hooks),
            "recovery requires only completed pre-upgrade hooks; other hook events are unsupported")
    return ordinary, actual_hooks


def recover(directory, release, kubeconfig, context, namespace):
    root, record = attempt(directory)
    submission = load(directory / "helm-started")
    require(load(root / "intent.json") == submission, "original Helm submission changed")
    helm_args = ["--kubeconfig", kubeconfig, "--kube-context", context, "--namespace", namespace]
    kube = ["kubectl", "--kubeconfig", kubeconfig, "--context", context, "--namespace", namespace]

    def status():
        return json.loads(command(["helm", "status", release, *helm_args, "--output", "json"]))

    def get(manifest):
        return json.loads(command([*kube, "get", "--filename", "-", "--output", "json"],
                                  input=json.dumps(manifest).encode()))

    before = status()
    require(before["version"] == submission["expectedRevision"]
            and before["info"]["status"] in ("pending-upgrade", "failed"),
            "only the original interrupted candidate can be recovered")
    ordinary, hooks = release_matches(before, root / "rendered.yaml", root / "values.yaml", release, namespace)
    observed = []
    for desired in [*ordinary, *hooks]:
        actual = get(desired)
        metadata = actual["metadata"]
        require(metadata.get("uid") and not metadata.get("deletionTimestamp"),
                "a recovery resource is missing or being deleted")
        if desired in hooks:
            require(metadata.get("annotations", {}).get(ATTEMPT_ANNOTATION) == record["nonce"],
                    "hook does not identify the original upgrade attempt")
            require(contains(actual, desired), "live hook specification differs from its candidate")
            if desired["kind"] == "Job":
                require(any(item.get("type") == "Complete" and item.get("status") == "True"
                            for item in actual.get("status", {}).get("conditions", []))
                        and not actual.get("status", {}).get("active", 0)
                        and not actual.get("status", {}).get("failed", 0),
                        "initializer Job has not completed successfully")
                pods = json.loads(command([*kube, "get", "pods", "--selector",
                                           f"batch.kubernetes.io/controller-uid={metadata['uid']}",
                                           "--output", "json"]))["items"]
                require(len(pods) == 1, "initializer must retain exactly one successful Pod")
                pod = pods[0]
                require(not pod["metadata"].get("deletionTimestamp")
                        and pod["metadata"].get("annotations", {}).get(ATTEMPT_ANNOTATION) == record["nonce"]
                        and any(owner.get("uid") == metadata["uid"] and owner.get("controller") is True
                                and owner.get("kind") == "Job" for owner in pod["metadata"].get("ownerReferences", []))
                        and pod.get("status", {}).get("phase") == "Succeeded"
                        and contains(pod["spec"], desired["spec"]["template"]["spec"]),
                        "initializer Pod identity, specification or completion differs")
                for field, spec_field in (("initContainerStatuses", "initContainers"),
                                          ("containerStatuses", "containers")):
                    statuses = pod.get("status", {}).get(field, [])
                    require({item["name"] for item in statuses} ==
                            {item["name"] for item in pod["spec"].get(spec_field, [])}
                            and all(item.get("state", {}).get("terminated", {}).get("exitCode") == 0
                                    for item in statuses),
                            "initializer container did not exit successfully")
                observed.append((pod, pod))
        else:
            annotations = metadata.get("annotations", {})
            require(annotations.get("meta.helm.sh/release-name") == release
                    and annotations.get("meta.helm.sh/release-namespace") == namespace,
                    "a recovery target is not owned by this release")
            for component in ("api", "worker"):
                if desired["kind"] == "Deployment" and metadata["name"] == f"openclaw-enterprise-{component}":
                    previous = load(directory / f"quiescence-{component}-deployment.json")
                    require(metadata["uid"] == previous["metadata"]["uid"],
                            "an OCC Deployment was replaced after quiescence")
        observed.append((desired, actual))
    # The Installation is not owned by Helm. Keep its original identity and exact
    # selected content, including unrelated data, across recovery admission.
    secret = load(directory / "current-live-installation-secret.json")
    observed.append((secret, secret))
    target = directory / "helm-recovery"
    target.mkdir(mode=0o700)
    intent = {"submissionSha256": sha(read(root / "intent.json")), "attempt": record,
              "expectedRevision": submission["expectedRevision"] + 1,
              "release": release, "namespace": namespace,
              "beforeSha256": sha(json.dumps(before, sort_keys=True).encode()),
              "observedResources": [{"key": resource_key(actual), "uid": actual["metadata"]["uid"],
                                     "resourceVersion": actual["metadata"]["resourceVersion"]}
                                    for _, actual in observed]}
    write_json(target / "before.json", before)
    write_json(target / "intent.json", intent)
    require(status() == before, "Helm changed during recovery admission")
    for desired, actual in observed:
        current = get(desired)
        require(current["metadata"]["uid"] == actual["metadata"]["uid"]
                and current["metadata"]["resourceVersion"] == actual["metadata"]["resourceVersion"]
                and not current["metadata"].get("deletionTimestamp"),
                "a recovery resource changed during admission; reconcile without replay")
    # Stock rollback runs rollback-event hooks only. release_matches refused
    # those events, so this exact candidate has no hooks to suppress or rerun.
    with (target / "rollback.log").open("xb") as output:
        os.chmod(target / "rollback.log", 0o600)
        result = subprocess.run(["helm", "rollback", release, str(submission["expectedRevision"]),
                                 *helm_args, "--wait", "--timeout", "5m", "--history-max", "0"],
                                stdout=output, stderr=subprocess.STDOUT)
    require(result.returncode == 0,
            "Helm recovery outcome is unresolved; preserve evidence and reconcile manually, never replay")
    after = status()
    require(after["version"] == intent["expectedRevision"] and after["info"]["status"] == "deployed"
            and after["info"].get("description") == f"Rollback to {submission['expectedRevision']}"
            and all(after.get(key) == before.get(key) for key in ("manifest", "config", "hooks")),
            "acknowledged Helm recovery does not match the original candidate")
    for desired, actual in observed:
        current = get(desired)
        require(current["metadata"]["uid"] == actual["metadata"]["uid"]
                and not current["metadata"].get("deletionTimestamp"),
                "a recovery resource was replaced; reconcile manually")
    write_json(target / "acknowledged.json", {"intentSha256": sha(read(target / "intent.json")),
                                               "release": after})


def verify_recovery(directory, release, kubeconfig, context, namespace):
    root, record = attempt(directory)
    target = directory / "helm-recovery"
    intent = load(target / "intent.json")
    before = load(target / "before.json")
    acknowledged = load(target / "acknowledged.json")
    submission = load(directory / "helm-started")
    require(load(root / "intent.json") == submission
            and intent["submissionSha256"] == sha(read(root / "intent.json"))
            and intent["attempt"] == record and intent["release"] == release and intent["namespace"] == namespace
            and intent["expectedRevision"] == submission["expectedRevision"] + 1
            and intent["beforeSha256"] == sha(json.dumps(before, sort_keys=True).encode())
            and acknowledged["intentSha256"] == sha(read(target / "intent.json")),
            "Helm recovery evidence does not bind to the original submission")
    current = json.loads(command(["helm", "status", release, "--kubeconfig", kubeconfig,
                                  "--kube-context", context, "--namespace", namespace, "--output", "json"]))
    require(current == acknowledged["release"] and current["version"] == intent["expectedRevision"]
            and current["info"]["status"] == "deployed",
            "live Helm revision differs from the acknowledged recovery")
    release_matches(current, root / "rendered.yaml", root / "values.yaml", release, namespace)
    print(current["version"])


def main():
    action, location, *args = sys.argv[1:]
    directory = Path(location)
    if action == "new":
        new_attempt(directory, args[0], args[1:])
    elif action == "select":
        print(attempt(directory)[1]["nonce"])
    elif action == "record":
        record_submission(directory, args[0])
    elif action == "recover":
        recover(directory, *args)
    elif action == "verify-recovery":
        verify_recovery(directory, *args)
    else:
        raise ValueError("unsupported Helm evidence operation")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        # Native command output can contain protected values; retain the operation,
        # not its stdout/stderr or argument vector, in the public diagnostic.
        message = "Helm evidence command failed" if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f"upgrade-helm-state: {message}", file=sys.stderr)
        sys.exit(1)
