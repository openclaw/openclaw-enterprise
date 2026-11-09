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


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write(path, data):
    with path.open("xb") as target:
        os.chmod(path, 0o600)
        target.write(data)
        target.flush()
        os.fsync(target.fileno())
    sync_directory(path.parent)


def write_json(path, value):
    write(path, (json.dumps(value, sort_keys=True) + "\n").encode())


def stage_json(path, value):
    # A crash before publication may leave this immutable write complete.
    # Reuse only identical private evidence; never infer that Helm was sent.
    try:
        write_json(path, value)
    except FileExistsError:
        require(load(path) == value, "staged Helm submission intent changed")
        with path.open("rb") as staged:
            os.fsync(staged.fileno())
        sync_directory(path.parent)


def command(args, failure_path=None, **kwargs):
    try:
        return subprocess.check_output(args, stderr=subprocess.PIPE, **kwargs)
    except subprocess.CalledProcessError as error:
        if failure_path is not None:
            write(failure_path, (error.stdout or b"") + (error.stderr or b""))
            print(f"Helm preparation failed; inspect {failure_path}", file=sys.stderr)
            raise SystemExit(error.returncode if error.returncode > 0 else 128 - error.returncode) from error
        raise


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
            try:
                submission = load(directory / "helm-started")
            except json.JSONDecodeError as error:
                raise ValueError("Helm submission intent is missing or invalid") from error
            require(isinstance(submission, dict) and isinstance(submission.get("attempt"), dict),
                    "Helm submission intent has no upgrade-attempt binding")
            nonce = submission["attempt"].get("nonce")
        else:
            nonce = load(directory / "prepared-helm-attempt.json")["nonce"]
    try:
        valid_nonce = isinstance(nonce, str) and str(uuid.UUID(nonce)) == nonce
    except ValueError:
        valid_nonce = False
    require(valid_nonce, "Helm submission intent has no valid upgrade-attempt binding")
    root = directory / "helm-attempts" / nonce
    record = load(root / "attempt.json")
    require(record == {"nonce": nonce, "valuesSha256": sha(read(root / "values.yaml")),
                       "renderedSha256": sha(read(root / "rendered.yaml"))},
            "Helm attempt evidence changed")
    if (directory / "helm-started").exists():
        submission = load(directory / "helm-started")
        require(submission["attempt"] == record and load(root / "intent.json") == submission
                and type(submission.get("previousRevision")) is int and submission["previousRevision"] > 0
                and type(submission.get("expectedRevision")) is int
                and submission["expectedRevision"] == submission["previousRevision"] + 1
                and submission["predecessor"]["version"] == submission["previousRevision"],
                "Helm submission intent does not match its immutable attempt")
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
    # Persist both the UUID entry and a newly created helm-attempts entry before
    # any prepared/submission pointer can name this attempt.
    sync_directory(root.parent)
    sync_directory(directory)
    values = command(["yq", '.installation.upgradeAttemptId = strenv(OCE_UPGRADE_ATTEMPT)',
                      str(directory / "candidate-values.yaml")],
                     env={**os.environ, "OCE_UPGRADE_ATTEMPT": nonce})
    write(root / "values.yaml", values)
    chart = "deploy/helm/openclaw-enterprise"
    write(root / "rendered.yaml", command(["helm", "template", release, chart, *helm_args,
                                           "--is-upgrade", "--values", str(root / "values.yaml")],
                                          failure_path=root / "render-error.log"))
    write(root / "server-dry-run.txt", command(["helm", "upgrade", "--install", release, chart,
                                               *helm_args, "--values", str(root / "values.yaml"),
                                               "--dry-run=server", "--hide-secret"],
                                              failure_path=root / "server-dry-run-error.log"))
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
    intent = {"previousRevision": version, "expectedRevision": version + 1,
              "attempt": record, "predecessor": current}
    stage_json(root / "intent.json", intent)
    staged = root / "helm-started.tmp"
    stage_json(staged, intent)
    destination = directory / "helm-started"
    if destination.exists() or destination.is_symlink():
        read(destination)
    os.replace(staged, destination)
    sync_directory(directory)


def predecessor_matches(directory):
    attempt(directory)
    predecessor = load(directory / "helm-started")["predecessor"]
    require(predecessor == load(directory / "current-helm-status.json")
            and predecessor["config"] == documents(read(directory / "current-live-values.yaml"))[0],
            "live Helm values do not match the exact recorded predecessor")


ATTEMPT_ANNOTATION = "openclaw.dev/upgrade-attempt"


def resource_key(value, namespace=""):
    metadata = value["metadata"]
    return value["apiVersion"], value["kind"], metadata.get("namespace", namespace), metadata["name"]


def resource_map(values):
    result = {resource_key(value): value for value in values}
    require(len(result) == len(values), "duplicate Helm resources")
    return result


def predecessor_only(submission, candidate, namespace):
    previous = documents(submission["predecessor"]["manifest"].encode())
    current = documents(candidate["manifest"].encode())
    current_keys = {resource_key(item, namespace) for item in current}
    return [item for item in previous if resource_key(item, namespace) not in current_keys]


def get_resource(resource, kubeconfig, context, namespace):
    result = json.loads(command([
        "kubectl", "--kubeconfig", kubeconfig, "--context", context,
        "--namespace", resource["metadata"].get("namespace", namespace),
        "get", "--filename", "-", "--output", "json",
    ], input=json.dumps(resource).encode()))
    require(result.get("kind") == "List" and len(result.get("items", [])) == 1,
            "expected exactly one live recovery resource")
    return result["items"][0]


def require_absent(resources, kubeconfig, context, namespace):
    for resource in resources:
        output = command([
            "kubectl", "--kubeconfig", kubeconfig, "--context", context,
            "--namespace", resource["metadata"].get("namespace", namespace),
            "get", "--filename", "-", "--ignore-not-found", "--output", "name",
        ], input=json.dumps(resource).encode())
        require(not output.strip(),
                "a predecessor-only resource still exists; reconcile its removal before recovery")


def changed_custom_specs(submission, candidate, namespace):
    previous = {resource_key(item, namespace): item for item in
                documents(submission["predecessor"]["manifest"].encode())}
    # These are the chart's native groups. Unknown groups fail closed: Helm's
    # unstructured two-way patch cannot reconcile arbitrary live spec drift.
    native_groups = {"v1", "apps", "batch", "networking.k8s.io", "rbac.authorization.k8s.io"}
    return [item for item in documents(candidate["manifest"].encode())
            if item["apiVersion"].split("/")[0] not in native_groups
            and resource_key(item, namespace) in previous
            and item.get("spec") != previous[resource_key(item, namespace)].get("spec")]


def verify_custom_specs(resources, kubeconfig, context, namespace):
    for resource in resources:
        actual = get_resource(resource, kubeconfig, context, namespace)
        # Deliberately exact, including admission-added defaults. This recovery
        # path does not claim schema-aware custom-resource normalization.
        require(actual.get("spec") == resource.get("spec"),
                "changed custom-resource spec is not reconciled to the candidate")


def workload_changes(submission, candidate, namespace):
    previous = {resource_key(item, namespace): item for item in
                documents(submission["predecessor"]["manifest"].encode())}
    changes = []
    for resource in documents(candidate["manifest"].encode()):
        old = previous.get(resource_key(resource, namespace), {})
        for field in ("containers", "initContainers"):
            old_containers = old.get("spec", {}).get("template", {}).get("spec", {}).get(field, [])
            new_containers = resource.get("spec", {}).get("template", {}).get("spec", {}).get(field, [])
            for container in old_containers:
                if not any(item["name"] == container["name"] for item in new_containers):
                    changes.append((resource, field, container["name"], None))
            for container in new_containers:
                prior = next((item for item in old_containers if item["name"] == container["name"]), None)
                if prior is None:
                    continue
                before = {item["name"]: item for item in prior.get("env", [])}
                after = {item["name"]: item for item in container.get("env", [])}
                require(len(before) == len(prior.get("env", []))
                        and len(after) == len(container.get("env", [])), "duplicate environment selections")
                selected = {name: after.get(name) for name in before.keys() | after.keys()
                            if before.get(name) != after.get(name)}
                if selected:
                    changes.append((resource, field, container["name"], selected))
    return changes


def verify_workload_changes(changes, kubeconfig, context, namespace, retired_only=False):
    for resource, field, container_name, selections in changes:
        selected = None if selections is None else {
            name: value for name, value in selections.items() if not retired_only or value is None}
        if selected == {}:
            continue
        actual_resource = get_resource(resource, kubeconfig, context, namespace)
        containers = actual_resource.get("spec", {}).get("template", {}).get("spec", {}).get(field, [])
        matches = [item for item in containers if item["name"] == container_name]
        if selected is None:
            require(not matches, "retired container placement still exists; reconcile before recovery")
            continue
        require(len(matches) == 1, "changed environment container is missing or ambiguous")
        entries = matches[0].get("env", [])
        actual = {item["name"]: item for item in entries}
        require(len(actual) == len(entries), "duplicate live environment selections")
        require(all(actual.get(name) == value for name, value in selected.items()),
                "live environment differs from a changed candidate selection; reconcile before recovery")


def contains(actual, expected):
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(key in actual and contains(actual[key], value)
                                               for key, value in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            contains(left, right) for left, right in zip(actual, expected))
    return actual == expected


def same_security_context(actual, expected):
    # Kubernetes defaults an absent Pod context to {}; preserve every supplied
    # setting and refuse admission rewrites, even equivalent inherited settings.
    left, right = actual.get("securityContext"), expected.get("securityContext")
    return ({} if left is None else left) == ({} if right is None else right)


def pod_matches(actual, expected):
    if not same_security_context(actual, expected):
        return False
    normalized = json.loads(json.dumps(expected))
    normalized.pop("securityContext", None)
    quantities = []
    # The API defaults omitted fields, but admission must not change execution.
    for field in ("containers", "initContainers"):
        left, right = actual.get(field, []), normalized.get(field, [])
        if len(left) != len(right):
            return False
        for live, candidate in zip(left, right):
            if not same_security_context(live, candidate):
                return False
            candidate.pop("securityContext", None)
            # These fields are not harmless API defaults: additions change
            # executed code, its inputs, filesystem or execution location.
            for key in ("command", "args", "env", "envFrom", "volumeMounts", "volumeDevices",
                        "workingDir", "lifecycle", "livenessProbe", "readinessProbe", "startupProbe"):
                if live.get(key) != candidate.get(key):
                    return False
            for section in ("requests", "limits"):
                for resource, quantity in candidate.get("resources", {}).get(section, {}).items():
                    observed = live.get("resources", {}).get(section, {}).get(resource)
                    quantities.append([str(observed), str(quantity)])
                    candidate["resources"][section][resource] = observed
    if quantities:
        # Reuse Compute's fixed-point Kubernetes semantics, including native
        # precision/capping rules, rather than maintaining a second parser.
        comparator = Path(__file__).resolve().parents[1] / "apps/controller/src/drivers/compute/kubernetes/resource-quantities.ts"
        equal = command(["node", "--input-type=module", "--eval", """
import { readFileSync } from "node:fs";
const { compareResourceQuantities } = await import(process.argv[1]);
process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0, "utf8")).map(
  ([actual, expected]) => compareResourceQuantities(actual, expected) === 0
)));
""", comparator.as_uri()], input=json.dumps(quantities).encode(), timeout=15)
        compared = json.loads(equal)
        if not isinstance(compared, list) or len(compared) != len(quantities) or not all(
                value is True for value in compared):
            return False
    return contains(actual, normalized)


def candidate_release_matches(state, rendered, values, release, namespace):
    require(state["name"] == release and state["namespace"] == namespace,
            "Helm candidate identifies another release")
    require(state.get("config", {}) == documents(read(values))[0],
            "Helm candidate values differ from the selected attempt")
    expected = documents(read(rendered))
    ordinary = [item for item in expected if not item.get("metadata", {}).get("annotations", {}).get("helm.sh/hook")]
    require(resource_map(documents(state["manifest"].encode())) == resource_map(ordinary),
            "Helm candidate manifest differs from the selected attempt")
    hooks = state.get("hooks", [])
    expected_hooks = [item for item in expected if item not in ordinary]
    actual_hooks = [documents(item["manifest"].encode())[0] for item in hooks]
    require(resource_map(actual_hooks) == resource_map(expected_hooks),
            "Helm candidate hook set differs from the selected attempt")
    return ordinary, actual_hooks


def release_matches(state, rendered, values, release, namespace):
    ordinary, actual_hooks = candidate_release_matches(state, rendered, values, release, namespace)
    hooks = state.get("hooks", [])
    require(sum(item["kind"] == "Job" for item in actual_hooks) == 1
            and all(item["kind"] in ("Job", "ServiceAccount", "NetworkPolicy") for item in actual_hooks),
            "recovery requires one initializer Job and only ServiceAccount or NetworkPolicy companion hooks")
    require(hooks and all(set(item.get("events", [])) <= {"pre-install", "pre-upgrade"}
                          and "pre-upgrade" in item.get("events", []) for item in hooks),
            "recovery requires only completed pre-upgrade hooks; other hook events are unsupported")
    return ordinary, actual_hooks


def verify_hook(desired, actual, nonce, kube):
    metadata = actual["metadata"]
    require(metadata.get("uid") and not metadata.get("deletionTimestamp"),
            "an initialization hook is missing or being deleted")
    require(metadata.get("annotations", {}).get(ATTEMPT_ANNOTATION) == nonce,
            "hook does not identify the original upgrade attempt")
    expected_hook = json.loads(json.dumps(desired))
    if desired["kind"] == "Job":
        # Pod comparison below understands API quantity normalization.
        expected_hook["spec"]["template"]["spec"] = {}
    require(contains(actual, expected_hook), "live hook specification differs from its candidate")
    if desired["kind"] == "Job":
        require(pod_matches(actual["spec"]["template"]["spec"], desired["spec"]["template"]["spec"]),
                "initializer Job execution differs from its candidate")
        require(any(item.get("type") == "Complete" and item.get("status") == "True"
                    for item in actual.get("status", {}).get("conditions", []))
                and not actual.get("status", {}).get("active", 0)
                and not actual.get("status", {}).get("failed", 0),
                "initializer Job has not completed successfully")
        pods = json.loads(command([*kube, "--namespace", metadata["namespace"],
                                   "get", "pods", "--selector",
                                   f"batch.kubernetes.io/controller-uid={metadata['uid']}",
                                   "--output", "json"]))["items"]
        require(len(pods) == 1, "initializer must retain exactly one successful Pod")
        pod = pods[0]
        require(not pod["metadata"].get("deletionTimestamp")
                and pod["metadata"].get("annotations", {}).get(ATTEMPT_ANNOTATION) == nonce
                and any(owner.get("uid") == metadata["uid"] and owner.get("controller") is True
                        and owner.get("kind") == "Job" for owner in pod["metadata"].get("ownerReferences", []))
                and pod.get("status", {}).get("phase") == "Succeeded"
                and pod_matches(pod["spec"], desired["spec"]["template"]["spec"]),
                "initializer Pod identity, specification or completion differs")
        for field, spec_field in (("initContainerStatuses", "initContainers"),
                                  ("containerStatuses", "containers")):
            statuses = pod.get("status", {}).get(field, [])
            require({item["name"] for item in statuses} ==
                    {item["name"] for item in pod["spec"].get(spec_field, [])}
                    and all(item.get("state", {}).get("terminated", {}).get("exitCode") == 0
                            for item in statuses),
                    "initializer container did not exit successfully")
        return pod
    return None


def recover(directory, release, kubeconfig, context, namespace):
    root, record = attempt(directory)
    submission = load(directory / "helm-started")
    require(load(root / "intent.json") == submission
            and type(submission.get("previousRevision")) is int and submission["previousRevision"] > 0
            and type(submission.get("expectedRevision")) is int
            and submission["expectedRevision"] == submission["previousRevision"] + 1,
            "original Helm submission intent changed")
    helm_args = ["--kubeconfig", kubeconfig, "--kube-context", context, "--namespace", namespace]
    kube = ["kubectl", "--kubeconfig", kubeconfig, "--context", context]

    def status():
        return json.loads(command(["helm", "status", release, *helm_args, "--output", "json"]))

    def get(manifest):
        return get_resource(manifest, kubeconfig, context, namespace)

    before = status()
    require(before["version"] == submission["expectedRevision"]
            and before["info"]["status"] in ("pending-upgrade", "failed"),
            "only the original interrupted candidate can be recovered")
    ordinary, hooks = release_matches(before, root / "rendered.yaml", root / "values.yaml", release, namespace)
    removed = predecessor_only(submission, before, namespace)
    changed_workloads = workload_changes(submission, before, namespace)
    custom_specs = changed_custom_specs(submission, before, namespace)
    require_absent(removed, kubeconfig, context, namespace)
    verify_custom_specs(custom_specs, kubeconfig, context, namespace)
    verify_workload_changes(changed_workloads, kubeconfig, context, namespace, retired_only=True)
    observed = []
    for desired in [*ordinary, *hooks]:
        actual = get(desired)
        metadata = actual["metadata"]
        require(metadata.get("uid") and not metadata.get("deletionTimestamp"),
                "a recovery resource is missing or being deleted")
        if desired in hooks:
            pod = verify_hook(desired, actual, record["nonce"], kube)
            if pod is not None:
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
    versioned = installation_switch_secrets(directory, kubeconfig, context, namespace)
    if versioned:
        observed.extend(versioned)
    else:
        secret = load(directory / "current-live-installation-secret.json")
        observed.append((secret, secret))
    target = directory / "helm-recovery"
    target.mkdir(mode=0o700)
    # The exclusive marker's parent entry must survive a host crash too.
    sync_directory(directory)
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
    require_absent(removed, kubeconfig, context, namespace)
    verify_custom_specs(custom_specs, kubeconfig, context, namespace)
    verify_workload_changes(changed_workloads, kubeconfig, context, namespace, retired_only=True)
    installation_switch_secrets(directory, kubeconfig, context, namespace)
    # Stock rollback runs rollback-event hooks only. release_matches refused
    # those events, so this exact candidate has no hooks to suppress or rerun.
    with (target / "rollback.log").open("xb") as output:
        os.chmod(target / "rollback.log", 0o600)
        result = subprocess.run(["helm", "rollback", release, str(submission["expectedRevision"]),
                                 *helm_args, "--wait", "--timeout", "5m", "--history-max", "0"],
                                stdout=output, stderr=subprocess.STDOUT)
    write_json(target / "command-result.json", {"exitCode": result.returncode})
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
    require_absent(removed, kubeconfig, context, namespace)
    verify_custom_specs(custom_specs, kubeconfig, context, namespace)
    verify_workload_changes(changed_workloads, kubeconfig, context, namespace)
    installation_switch_secrets(directory, kubeconfig, context, namespace)
    write_json(target / "acknowledged.json", {"intentSha256": sha(read(target / "intent.json")),
                                               "release": after})


def verify_installation_mount(spec, component, secret, key):
    containers = [item for field in ("containers", "initContainers")
                  for item in spec.get(field, []) if item["name"] == component]
    require(len(containers) == 1, "Installation consumer is missing or ambiguous")
    container = containers[0]
    config = "/etc/openclaw/installation/installation.yaml"
    require([item for item in container.get("env", []) if item["name"] == "OCC_CONFIG_PATH"]
            == [{"name": "OCC_CONFIG_PATH", "value": config}],
            "Installation consumer selects another configuration path")
    # A second mount covering the file can hide the selected Secret. Refuse
    # subPath and other rewrites instead of guessing which data is mounted.
    covering = [item for item in container.get("volumeMounts", [])
                if config == os.path.normpath("/" + item["mountPath"].lstrip("/"))
                or config.startswith(os.path.normpath("/" + item["mountPath"].lstrip("/")).rstrip("/") + "/")]
    require(covering == [{"name": "installation-startup", "mountPath": "/etc/openclaw/installation",
                          "readOnly": True}], "Installation consumer mount differs")
    volumes = [item for item in spec.get("volumes", []) if item["name"] == "installation-startup"]
    require(len(volumes) == 1 and set(volumes[0]) == {"name", "secret"}
            and volumes[0]["secret"].get("secretName") == secret
            and volumes[0]["secret"].get("items") == [{"key": key, "path": "installation.yaml"}],
            "Installation consumer volume differs")


def verify_installation_consumers(directory, release, kubeconfig, context, namespace):
    root, record = attempt(directory)
    current = json.loads(command(["helm", "status", release, "--kubeconfig", kubeconfig,
                                  "--kube-context", context, "--namespace", namespace, "--output", "json"]))
    expected_revision = load(directory / "helm-started")["expectedRevision"]
    acknowledged = directory / "helm-recovery" / "acknowledged.json"
    if acknowledged.exists():
        require(current == load(acknowledged)["release"], "Helm recovery changed before Installation verification")
        expected_revision += 1
    require(current["version"] == expected_revision and current["info"]["status"] == "deployed",
            "Installation consumers require the exact deployed candidate revision")
    candidate_release_matches(current, root / "rendered.yaml", root / "values.yaml", release, namespace)
    secret = read(directory / "installation-secret-name").decode().strip()
    key = read(directory / "installation-secret-key").decode().strip()
    for component in ("api", "worker"):
        deployment = load(directory / f"after-{component}-deployment.json")
        verify_installation_mount(deployment["spec"]["template"]["spec"], component, secret, key)
        pods = [pod for pod in load(directory / f"after-{component}-installation-pods.json")["items"]
                if not pod["metadata"].get("deletionTimestamp")
                and pod.get("status", {}).get("phase") not in ("Succeeded", "Failed")]
        require(pods, "Installation consumer has no serving Pods")
        for pod in pods:
            require(any(item.get("type") == "Ready" and item.get("status") == "True"
                        for item in pod.get("status", {}).get("conditions", [])),
                    "Installation consumer Pod is not ready")
            verify_installation_mount(pod["spec"], component, secret, key)
    jobs = [item for item in documents(read(root / "rendered.yaml")) if item["kind"] == "Job"
            and "pre-upgrade" in item.get("metadata", {}).get("annotations", {}).get("helm.sh/hook", "").split(",")]
    require(len(jobs) == 1, "expected exactly one candidate initialization Job")
    job = get_resource(jobs[0], kubeconfig, context, namespace)
    kube = ["kubectl", "--kubeconfig", kubeconfig, "--context", context]
    pod = verify_hook(jobs[0], job, record["nonce"], kube)
    for spec in (job["spec"]["template"]["spec"], pod["spec"]):
        # The migration/bootstrap containers use database inputs; only this
        # init container reads the Installation in the production chart.
        verify_installation_mount(spec, "installation-check", secret, key)
    stage_json(directory / "installation-initializer.json",
               {"attempt": record["nonce"], "jobUid": job["metadata"]["uid"],
                "podUid": pod["metadata"]["uid"]})


def installation_switch_secrets(directory, kubeconfig, context, namespace):
    successor = directory / "before-candidate-installation-secret.json"
    if not successor.exists():
        return []
    observed = []
    for path in (directory / "before-live-installation-secret.json", successor):
        expected = load(path)
        actual = get_resource(expected, kubeconfig, context, namespace)
        require(actual["metadata"]["uid"] == expected["metadata"]["uid"]
                and actual["metadata"]["name"] == expected["metadata"]["name"]
                and actual["metadata"].get("namespace") == namespace
                and not actual["metadata"].get("deletionTimestamp")
                and actual.get("immutable") is True
                and actual["metadata"].get("annotations", {}).get("openclaw.dev/installation-id")
                    == expected["metadata"]["annotations"]["openclaw.dev/installation-id"]
                and actual.get("type") == expected.get("type")
                and actual.get("data") == expected.get("data"),
                "a versioned Installation Secret identity or data changed")
        observed.append((expected, actual))
    return observed


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
    installation_switch_secrets(directory, kubeconfig, context, namespace)
    require_absent(predecessor_only(submission, before, namespace), kubeconfig, context, namespace)
    verify_workload_changes(workload_changes(submission, before, namespace), kubeconfig, context, namespace)
    verify_custom_specs(changed_custom_specs(submission, before, namespace), kubeconfig, context, namespace)
    for observed in intent["observedResources"]:
        api_version, kind, resource_namespace, name = observed["key"]
        manifest = {"apiVersion": api_version, "kind": kind,
                    "metadata": {"name": name, "namespace": resource_namespace or namespace}}
        actual = get_resource(manifest, kubeconfig, context, namespace)
        require(actual["metadata"]["uid"] == observed["uid"]
                and not actual["metadata"].get("deletionTimestamp"),
                "a recovery resource identity changed after acknowledgement")
    print(current["version"])


def main():
    action, location, *args = sys.argv[1:]
    directory = Path(location)
    if action == "new":
        new_attempt(directory, args[0], args[1:])
    elif action == "select":
        print(attempt(directory)[1]["nonce"])
    elif action == "predecessor":
        predecessor_matches(directory)
    elif action == "record":
        record_submission(directory, args[0])
    elif action == "recover":
        recover(directory, *args)
    elif action == "verify-recovery":
        verify_recovery(directory, *args)
    elif action == "verify-installation":
        verify_installation_consumers(directory, *args)
    else:
        raise ValueError("unsupported Helm evidence operation")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        # Native command output can contain protected values; retain the operation,
        # not its stdout/stderr or argument vector, in the public diagnostic.
        message = "Helm evidence command failed" if isinstance(error, subprocess.SubprocessError) else str(error)
        print(f"upgrade-helm-state: {message}", file=sys.stderr)
        sys.exit(1)
