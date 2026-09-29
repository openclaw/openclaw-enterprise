#!/usr/bin/env python3
"""Select a conservative, single-platform set of eligible control-plane nodes."""

import json
import sys


def main():
    if len(sys.argv) != 3:
        raise ValueError("expected node inventory and candidate values")
    with open(sys.argv[1], encoding="utf-8") as source:
        nodes = json.load(source)
    with open(sys.argv[2], encoding="utf-8") as source:
        values = json.load(source)
    selector = values.get("controlPlane", {}).get("nodeSelector") or {}
    if not isinstance(selector, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in selector.items()
    ):
        raise ValueError("invalid node selector")
    if not isinstance(nodes.get("items"), list):
        raise ValueError("invalid node inventory")
    eligible = []
    for node in nodes["items"]:
        metadata = node["metadata"]
        labels = metadata.get("labels", {})
        if not isinstance(labels, dict):
            raise ValueError("invalid node labels")
        if any(labels.get(key) != value for key, value in selector.items()):
            continue
        info = node["status"]["nodeInfo"]
        os_name = labels.get("kubernetes.io/os")
        architecture = labels.get("kubernetes.io/arch")
        if (
            os_name != "linux"
            or architecture not in ("amd64", "arm64")
            or info.get("operatingSystem") != os_name
            or info.get("architecture") != architecture
            or not isinstance(metadata.get("name"), str)
            or not metadata["name"]
            or not isinstance(metadata.get("uid"), str)
            or not metadata["uid"]
        ):
            raise ValueError("eligible node identity or platform is invalid")
        eligible.append({"name": metadata["name"], "uid": metadata["uid"],
                         "platform": f"{os_name}/{architecture}"})
    eligible.sort(key=lambda node: (node["name"], node["uid"]))
    if (not eligible or len({node["uid"] for node in eligible}) != len(eligible)
            or len({node["name"] for node in eligible}) != len(eligible)):
        raise ValueError("eligible node inventory is empty or ambiguous")
    platforms = {node["platform"] for node in eligible}
    if len(platforms) != 1:
        raise ValueError("all eligible nodes must use the qualified platform")
    print(json.dumps({"platform": platforms.pop(), "nodes": eligible}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        print("eligible control-plane node verification failed", file=sys.stderr)
        sys.exit(1)
