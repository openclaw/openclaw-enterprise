#!/usr/bin/env python3
"""Inspect the locally staged immutable image and its selected OCI platform."""

import hashlib
import json
import re
import subprocess
import sys
import tarfile
import threading


DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
MAX_JSON = 2 * 1024 * 1024
MAX_METADATA = 32 * 1024 * 1024


def inspect(image, platform=None):
    args = ["docker", "image", "inspect"]
    if platform:
        args += ["--platform", platform]
    args += [image]
    data = subprocess.run(args, check=True, capture_output=True, timeout=30).stdout
    if len(data) > MAX_JSON:
        raise ValueError("image inspection exceeded the metadata limit")
    value = json.loads(data)
    if not isinstance(value, list) or len(value) != 1:
        raise ValueError("image inspection returned an ambiguous result")
    return value[0]


def read_platform(image, platform, selected):
    process = subprocess.Popen(
        ["docker", "image", "save", "--platform", platform, image],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    timer = threading.Timer(120, process.kill)
    timer.start()
    blobs = {}
    total = 0
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for member in archive:
                if not member.isfile() or not member.name.startswith("blobs/sha256/"):
                    continue
                digest = "sha256:" + member.name.removeprefix("blobs/sha256/")
                if not DIGEST.fullmatch(digest) or member.size > MAX_JSON:
                    continue
                data = archive.extractfile(member).read()
                total += len(data)
                if total > MAX_METADATA:
                    raise ValueError("image metadata exceeded the limit")
                if digest in blobs:
                    raise ValueError("duplicate image metadata blob")
                if "sha256:" + hashlib.sha256(data).hexdigest() != digest:
                    raise ValueError("image metadata digest mismatch")
                blobs[digest] = data
        if process.wait(timeout=10) != 0:
            raise ValueError("image export failed")
    finally:
        timer.cancel()
        if process.poll() is None:
            process.kill()
            process.wait()
        if process.stdout:
            process.stdout.close()

    manifest = json.loads(blobs[selected])
    if manifest.get("schemaVersion") != 2 or manifest.get("mediaType") not in (
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ):
        raise ValueError("unsupported platform manifest")
    config_digest = manifest.get("config", {}).get("digest")
    if not isinstance(config_digest, str) or not DIGEST.fullmatch(config_digest):
        raise ValueError("invalid image configuration digest")
    config = json.loads(blobs[config_digest])
    if f'{config.get("os")}/{config.get("architecture")}' != platform:
        raise ValueError("image configuration platform mismatch")
    return config_digest


def validate_descriptor_platform(descriptor, platform):
    value = descriptor.get("platform")
    if value is None:
        return
    expected_os, expected_architecture = platform.split("/")
    if (not isinstance(value, dict) or value.get("os") != expected_os or
            value.get("architecture") != expected_architecture):
        raise ValueError("platform descriptor mismatch")


def main():
    if len(sys.argv) != 3:
        raise ValueError("expected image and platform")
    image, platform = sys.argv[1:]
    if "@" not in image or not DIGEST.fullmatch(image.rsplit("@", 1)[1]):
        raise ValueError("image reference must use a lowercase immutable SHA-256 digest")
    if platform not in ("linux/amd64", "linux/arm64"):
        raise ValueError("unsupported native platform")
    root = inspect(image)
    selected = inspect(image, platform)
    root_digest = image.rsplit("@", 1)[1]
    descriptor = selected.get("Descriptor") or {}
    manifest_digest = descriptor.get("digest")
    if (root.get("Descriptor") or {}).get("digest") != root_digest:
        raise ValueError("staged image does not match the selected digest")
    if not isinstance(manifest_digest, str) or not DIGEST.fullmatch(manifest_digest):
        raise ValueError("platform manifest digest is unavailable")
    if f'{selected.get("Os")}/{selected.get("Architecture")}' != platform:
        raise ValueError("staged image platform mismatch")
    validate_descriptor_platform(descriptor, platform)
    config_digest = read_platform(image, platform, manifest_digest)
    print(json.dumps({"image": image, "platform": platform, "rootDigest": root_digest,
                      "manifestDigest": manifest_digest, "configDigest": config_digest}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError,
            subprocess.SubprocessError, tarfile.TarError):
        print("image identity verification failed", file=sys.stderr)
        sys.exit(1)
