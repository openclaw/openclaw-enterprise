#!/usr/bin/env python3
"""Verify one deployed component and return its stable runtime identity."""

import json
import re
import sys


def load(path):
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def require(condition):
    if not condition:
        raise ValueError("deployed identity mismatch")


def controller_owner(value, kind):
    owners = [owner for owner in value.get("metadata", {}).get("ownerReferences", [])
              if owner.get("controller") is True]
    require(len(owners) == 1 and owners[0].get("kind") == kind)
    return owners[0]


def container(pod, name):
    specifications = [(entry, "containerStatuses") for entry in pod["spec"].get("containers", [])
                      if entry.get("name") == name]
    specifications += [(entry, "initContainerStatuses") for entry in pod["spec"].get("initContainers", [])
                       if entry.get("name") == name]
    require(len(specifications) == 1)
    specification, status_field = specifications[0]
    if status_field == "initContainerStatuses":
        require(name == "worker" and specification.get("restartPolicy") == "Always")
    statuses = [entry for entry in pod["status"].get(status_field, []) if entry.get("name") == name]
    require(len(statuses) == 1)
    status = statuses[0]
    require(status.get("ready") is True and isinstance(status.get("state", {}).get("running"), dict))
    require(isinstance(status.get("restartCount"), int) and status["restartCount"] >= 0)
    require(isinstance(status.get("containerID"), str) and bool(status["containerID"]))
    return specification, status


def check_image(pod, name, image):
    specification, status = container(pod, name)
    require(specification.get("image") == image["image"])
    match = re.search(r"sha256:[a-f0-9]{64}$", status.get("imageID", ""))
    require(match is not None and match.group(0) in {
        image["rootDigest"], image["manifestDigest"], image["configDigest"]
    })
    return {"containerId": status["containerID"], "imageId": status["imageID"],
            "restartCount": status["restartCount"]}


def main():
    if len(sys.argv) != 8:
        raise ValueError("expected component and deployment evidence")
    component, deployment_path, replicasets_path, pods_path, nodes_path, proof_path, release = sys.argv[1:]
    require(component in ("api", "worker"))
    deployment = load(deployment_path)
    replicasets = load(replicasets_path)["items"]
    pods = load(pods_path)["items"]
    nodes = load(nodes_path)["nodes"]
    proof = load(proof_path)
    metadata = deployment["metadata"]
    labels = metadata.get("labels", {})
    require(labels.get("app.kubernetes.io/instance") == release)
    require(labels.get("app.kubernetes.io/component") == component)
    require(isinstance(metadata.get("uid"), str) and bool(metadata["uid"]))
    generation = metadata.get("generation")
    require(isinstance(generation, int) and generation > 0)
    status = deployment["status"]
    require(status.get("observedGeneration", 0) >= generation)
    require(deployment["spec"].get("replicas") == 1)
    require(status.get("replicas") == 1 and status.get("updatedReplicas") == 1 and status.get("availableReplicas") == 1)
    require(len(pods) == 1)
    pod = pods[0]
    pod_metadata = pod["metadata"]
    require(not pod_metadata.get("deletionTimestamp"))
    require(isinstance(pod_metadata.get("uid"), str) and bool(pod_metadata["uid"]))
    require(isinstance(pod_metadata.get("name"), str) and bool(pod_metadata["name"]))
    require(pod["status"].get("phase") == "Running")
    require(any(condition.get("type") == "Ready" and condition.get("status") == "True"
                for condition in pod["status"].get("conditions", [])))
    owner = controller_owner(pod, "ReplicaSet")
    matches = [item for item in replicasets if item["metadata"].get("uid") == owner.get("uid")
               and item["metadata"].get("name") == owner.get("name")]
    require(len(matches) == 1)
    parent = controller_owner(matches[0], "Deployment")
    require(parent.get("uid") == metadata["uid"] and parent.get("name") == metadata.get("name"))
    node_name = pod["spec"].get("nodeName")
    require(sum(node.get("name") == node_name and node.get("platform") == proof["controller"]["platform"]
                for node in nodes) == 1)
    controller = check_image(pod, component, proof["controller"])
    broker = check_image(pod, "repository-credentials", proof["broker"]) if component == "worker" else None
    print(json.dumps({"component": component, "deploymentUid": metadata["uid"],
                      "deploymentGeneration": generation, "replicaSetUid": owner["uid"],
                      "podUid": pod_metadata["uid"], "podName": pod_metadata["name"],
                      "nodeName": node_name, "controller": controller, "broker": broker}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        print("deployed controller or broker identity verification failed", file=sys.stderr)
        sys.exit(1)
