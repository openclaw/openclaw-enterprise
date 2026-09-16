#!/usr/bin/env python3
"""Validate resolved development publications and select profile startup values."""

import json
import re
import sys

config = json.load(sys.stdin)
services = config.get("services")
if not isinstance(services, dict):
    raise SystemExit("Compose configuration does not define services.")


def service(name):
    value = services.get(name)
    if not isinstance(value, dict):
        raise SystemExit(f"Compose configuration does not define the {name} service.")
    return value


def environment(service_config):
    raw = service_config.get("environment", {})
    if isinstance(raw, dict):
        return {str(key): "" if value is None else str(value) for key, value in raw.items()}
    raise SystemExit("Compose JSON environment must be a resolved object.")


def selected(value):
    if value is None:
        return ""
    return str(value).strip()


def publication(value):
    if isinstance(value, dict):
        return (
            selected(value.get("host_ip")),
            selected(value.get("published")),
            selected(value.get("target")),
            selected(value.get("protocol")) or "tcp",
        )
    if not isinstance(value, str):
        raise SystemExit("Compose ports must be resolved objects or host publications.")
    text, separator, protocol = value.partition("/")
    protocol = protocol if separator else "tcp"
    bracketed = re.fullmatch(r"\[([^]]+)]:(\d+):(\d+)", text)
    plain = re.fullmatch(r"([^:]+):(\d+):(\d+)", text) if bracketed is None else None
    matched = bracketed or plain
    if matched is None:
        raise SystemExit("Compose port publication must include an explicit host IP.")
    return matched.group(1), matched.group(2), matched.group(3), protocol


def controller_url(controller):
    controller_publications = []
    for port in controller.get("ports", []):
        host, published, target, protocol = publication(port)
        if host not in ("127.0.0.1", "::1"):
            raise SystemExit("Compose controller port must publish only on loopback.")
        if not published or published == "0":
            raise SystemExit("Compose controller port must select an explicit host port.")
        if target == "3000" and protocol == "tcp":
            controller_publications.append((host, published))
    if not controller_publications:
        raise SystemExit("Compose controller service must publish container port 3000 on loopback.")
    host, published = controller_publications[0]
    if host == "::1":
        return f"http://[::1]:{published}"
    return f"http://127.0.0.1:{published}"


def reject_public_database_ports(postgres):
    for port in postgres.get("ports", []):
        host, published, _target, _protocol = publication(port)
        if host not in ("127.0.0.1", "::1"):
            raise SystemExit("Compose PostgreSQL port must publish only on loopback.")
        if not published or published == "0":
            raise SystemExit("Compose PostgreSQL port must select an explicit host port.")


reject_public_database_ports(service("postgres"))
print(controller_url(service("controller")))

if sys.argv[1] == "docker":
    worker_environment = environment(service("worker"))
    shared = selected(worker_environment.get("OCC_DOCKER_RUNTIME_IMAGE"))
    gateway = selected(worker_environment.get("OCC_DOCKER_GATEWAY_IMAGE")) or shared
    agent = selected(worker_environment.get("OCC_DOCKER_AGENT_IMAGE")) or shared

    if gateway or agent:
        if not gateway:
            raise SystemExit("Docker gateway image must be explicitly configured.")
        if not agent:
            raise SystemExit("Docker Codex Agent image must be explicitly configured.")
        mode = "custom"
        images = [gateway]
        if agent != gateway:
            images.append(agent)
    else:
        mode = "default"
        images = []

    print(mode)
    for image in images:
        print(image)
