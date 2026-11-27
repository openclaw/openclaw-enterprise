# Run the local Kubernetes profile on Podman-only Linux hosts

Run the local Kubernetes profile and the `./scripts/k3d` lanes on a Linux host
that has Podman and no Docker, such as a RHEL or Fedora workstation.
[Local Kubernetes development](local-kubernetes-development.md) states that
native rootless Podman cannot start the profile. This page names the
session-level causes of that limit, documents a working rootful route, and
lists the rootless prerequisites the helper checks.

## Select the engine

| Setting                                   | Effect                                                                |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `OCC_K3D_CONTAINER_ENGINE=podman-rootful` | Use the system Podman socket. Recommended.                            |
| `OCC_K3D_CONTAINER_ENGINE=podman`         | Use the rootless user socket. Needs the rootless prerequisites below. |
| `OCC_K3D_PODMAN_SOCKET=<path>`            | Use one exact socket, overriding discovery.                           |
| `DOCKER_HOST=unix://<path>`               | Honored when it selects a `unix://` socket.                           |

On Linux, the helper exports `DOCKER_HOST`, `DOCKER_SOCK` and `CONTAINER_HOST`
from the selected socket. `DOCKER_SOCK` names the socket that k3d mounts into
its tools node, and `CONTAINER_HOST` routes the Podman CLI to the same socket,
so image pulls and builds reach the storage that k3d reads.

## Rootful setup (recommended)

The system Podman socket behaves closest to the Docker daemon that the profile
expects: containers run with root cgroups, which provide every controller, and
with the privileges the OCI runtime needs. This route needs no rootful Podman
machine.

Access to a rootful Podman socket is root-equivalent without a sudo password
for anything that already runs as your user, the same property as Docker group
membership. The socket and the access grants stay active after the profile
stops, until you remove them or reboot the host. Remove them when you are done,
including after a failed run:

```bash
sudo systemctl start podman.socket
sudo setfacl -m u:"$(id -un)":x /run/podman
sudo setfacl -m u:"$(id -un)":rw /run/podman/podman.sock
OCC_K3D_CONTAINER_ENGINE=podman-rootful ./scripts/k3d test --harness openclaw
# Teardown after a finished or failed run:
sudo setfacl -x u:"$(id -un)" /run/podman/podman.sock
sudo setfacl -x u:"$(id -un)" /run/podman
sudo systemctl stop podman.socket
```

Both the grants and a stopped socket revert at reboot. Use
`sudo systemctl enable --now podman.socket` only when you accept a socket that
survives reboots; without the access grant an enabled socket stays root-only.

## Rootless prerequisites

The rootless user socket needs everything k3s and the OCI runtime require.
The helper checks each requirement before any cluster work and prints the
exact remediation. Completing the checks does not guarantee a rootless
start: the reproduction behind
[#918](https://github.com/openclaw/openclaw-enterprise/pull/918) still
failed on `/dev/kmsg` after the socket and `cpuset` fixes. Treat rootless
as best effort and prefer the rootful socket.

1. **Socket mount.** k3d mounts the socket named by `DOCKER_SOCK` into its
   tools node. Without it, k3d mounts `/var/run/docker.sock`, which a rootless
   session never provides, and cluster creation fails. The helper exports
   `DOCKER_SOCK` for you.
2. **cpuset controller.** k3s requires the `cpuset` cgroup controller, which
   systemd does not delegate to user sessions by default. Follow
   [local cgroup troubleshooting](../operate/troubleshooting.md#local-k3s-cannot-find-the-cpuset-controller).
3. **oom_score_adj.** An unprivileged session cannot lower `oom_score_adj` for
   containers. When the session inherits a non-zero value, every rootless
   container that requests a lower score fails to start. The value comes from
   the user systemd manager; check it with
   `systemctl show "user@$(id -u).service" -p OOMScoreAdjust`. Either clear
   that value and sign in again, or use the rootful socket.

## What the preflight validates

`preflight_podman_engine` runs when the helper selects Podman on Linux. It
checks, in order: socket accessibility, socket presence, the Podman API
answer, the `cpuset` chain for rootless sockets, and the session
`oom_score_adj`. Each failure stops the helper before any cluster, database or
image work and prints the host command that fixes it.

macOS hosts skip the preflight: podman-machine runs a rootful virtual machine.
