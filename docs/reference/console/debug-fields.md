# Debug sidebar fields

Append `?debug=true` to a [console](../console.md) URL, or `&debug=true` if it
already has a query. The sidebar shows the control-plane build and image
observations grouped by Agent name. Expand an Agent to inspect its containers.
Navigation preserves the flag; remove it to hide diagnostics and stop these reads.
Use **Refresh** to update the snapshot or retry a failed read. The panel does not
continuously poll.

## Field meanings

| Field                 | Meaning                                                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OCE commit**        | Full source Git commit baked into the OpenClaw Control Plane (OCC) build serving the console. For published OCE images, this is the Enterprise repository revision.                                                                                      |
| Hash beside **OCE**   | First eight characters of **OCE commit**. Hover to see the full commit. `dev` means valid build metadata is unavailable.                                                                                                                                 |
| Agent heading         | Name of an Agent you can read in the selected Namespace. Its containers come from its active revision, even when the detail page displays another revision.                                                                                              |
| **Container**         | Docker: the runtime role, `gateway` or `agent`. Kubernetes: the container name from the Pod specification, including init containers and sidecars.                                                                                                       |
| **Workload**          | Docker: the container name. Kubernetes: `<namespace>/<pod-name>`, using the Kubernetes namespace, which can differ from the selected OCE Namespace.                                                                                                      |
| **Docker image**      | Image reference configured on that container, such as `ghcr.io/openclaw/openclaw-enterprise-runtime:main` or a digest-pinned reference. This field is also used for Kubernetes containers.                                                               |
| **Image ID / digest** | Identity observed for the container's image. Docker supplies its immutable image configuration ID. Kubernetes supplies the container runtime's `imageID`. These values are not necessarily the registry's multi-platform manifest digest.                |
| **Source commit**     | Full source Git commit recorded when the observed image was built, when available. For OCE runtime images, this identifies the Enterprise source revision used to build the runtime. It does not identify the bundled OpenClaw or Codex package version. |
| **OpenClaw commit**   | Upstream `openclaw/openclaw` Git commit packaged inside the image. Expand the Agent and find **Container: gateway** to see the OpenClaw gateway image, digest, Enterprise source commit, and this upstream commit together.                              |

A tag such as `:main` can move after deployment while a container keeps using
its original image. Read **Docker image** as the configured reference and
**Image ID / digest** as the observed identity. **Source commit** describes the
source used to build that image. Publishing a new image does not update these
containers automatically.

**OCE commit** and a runtime's **Source commit** can differ when the controller
and runtime were built or deployed separately.

## Where the source commit comes from

Docker reads the image's `org.opencontainers.image.revision` (Enterprise) and
`org.openclaw.image.revision` (OpenClaw) labels using the
immutable image ID attached to the container. For an external image, the OCI revision
label may describe a different source repository.

Kubernetes reads the OCE runtime's baked build metadata and matches it to the
observed Pod and container before reporting a commit. A sidecar with a different
image does not inherit the runtime's commit. Older images or custom images may
lack this metadata. Neither Driver guesses a commit from an image tag.
The upstream commit identifies the starting source; OCE may apply build-time
patches, including its Codex dependency pin. It does not claim an unmodified
upstream build. **OpenClaw commit** is unavailable for images without validated
OpenClaw provenance; unrelated sidecars normally show this state.

## Unavailable and empty states

| Display                                                             | Meaning and next step                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OCE commit: Unavailable (development build)** / **dev**           | The controller build lacks a valid full source commit. This can also occur in a custom build with missing or invalid metadata.                                                                                   |
| **Image ID / digest: Unavailable**                                  | The runtime has not supplied an image identity, for example before a Kubernetes container starts. Refresh after startup.                                                                                         |
| **Source commit: Unavailable (image has no provenance)**            | Build metadata is absent or could not be read or matched to the observed container. A timed-out read or restart can also cause this state. Refresh to retry; an older image may need rebuilding with provenance. |
| **OpenClaw commit: Unavailable (image has no OpenClaw provenance)** | The image lacks validated OpenClaw provenance, or the runtime could not return it. Refresh to retry; rebuild older OCE images to add the Docker label.                                                           |
| **Loading runtime images…** / **Loading…**                          | The Namespace's Agent list or an Agent's image observation is still loading.                                                                                                                                     |
| **Select a readable Namespace to inspect runtime images.**          | Select a Namespace you can access.                                                                                                                                                                               |
| **No accessible Agents in this Namespace.**                         | No Agents were returned within your read permissions.                                                                                                                                                            |
| **Image inspection is unavailable for this Compute Driver.**        | The selected Driver does not support image inspection; SSH is one example.                                                                                                                                       |
| **No deployed runtime images observed.**                            | The Agent has no active revision, or inspection found no matching containers. This is not a runtime health result.                                                                                               |
| **Runtime image metadata unavailable. Refresh to retry.**           | An Agent-list or runtime-image request failed. Refresh to retry; persistent failures require checking API and Compute Driver availability.                                                                       |

## Inspection scope

Inspection uses existing Agent read permissions and the active revision's Compute
Driver. Docker inspects the revision-owned gateway and Agent containers.
Kubernetes inspects its non-terminating gateway and Agent Pods, including regular,
init, and ephemeral containers.

The panel excludes other Namespaces and separate Sandbox Driver workloads. Image
observations do not prove runtime health or successful model execution. See the
[Compute Driver reference](../drivers/compute.md) for the inspection contract and
the [deployment guide](../../guides/deploy.md) for runtime verification.
