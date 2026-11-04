"""Select the public IPv4 networks for GitHub API and Git HTTPS traffic."""

import ipaddress
import json
import sys


# Reject a range that spans non-public space even when one end is public.
NON_PUBLIC = tuple(map(ipaddress.ip_network, (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
    "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
    "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
)))


def repository_ranges(metadata):
    selected = set()
    for service in ("api", "git"):
        entries = metadata[service]
        if not isinstance(entries, list) or not entries:
            raise ValueError(f"GitHub Meta must include {service} networks")
        ipv4 = set()
        for entry in entries:
            if not isinstance(entry, str) or "/" not in entry:
                raise ValueError(f"Invalid CIDR in GitHub Meta {service}")
            network = ipaddress.ip_network(entry, strict=True)
            if network.version == 6:
                continue
            if str(network) != entry or any(network.overlaps(block) for block in NON_PUBLIC):
                raise ValueError(f"Expected a canonical public IPv4 CIDR in GitHub Meta {service}")
            ipv4.add(entry)
        if not ipv4:
            raise ValueError(f"GitHub Meta must include IPv4 networks for {service}")
        selected.update(ipv4)
    return {"githubApiAndGit": sorted(selected)}


if __name__ == "__main__":
    json.dump(repository_ranges(json.load(sys.stdin)), sys.stdout)
