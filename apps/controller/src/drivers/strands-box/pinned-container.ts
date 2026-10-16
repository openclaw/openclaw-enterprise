import { isDeepStrictEqual } from "node:util";
import type { Resource } from "./kubernetes.ts";

/**
 * The Pod spec must name the exact immutable reference and the runtime must report that manifest digest.
 * The execution API is the trusted observer; a sender cannot attest its own image from inside a container.
 * CRI runtimes reporting only a config ID or tag cannot establish this platform-manifest binding.
 */
export function pinnedStrandsContainer(pod: Resource | undefined, name: string, image: string) {
  const digest = image.match(/@(sha256:[\da-f]{64})$/)?.[1];
  const spec = pod?.spec?.containers;
  const containers = Array.isArray(spec) ? spec.filter((c) => c.name === name) : [];
  const [status, extra] = pod?.status?.containerStatuses?.filter((c) => c.name === name) ?? [];
  if (
    !pod?.metadata.uid ||
    pod.metadata.deletionTimestamp ||
    pod.status?.phase !== "Running" ||
    !pod.status.podIP ||
    !digest ||
    containers.length !== 1 ||
    containers[0].image !== image ||
    extra ||
    !status?.ready ||
    !status.state?.running ||
    !status.containerID ||
    !status.imageID?.endsWith("@" + digest)
  ) {
    return undefined;
  }
  return {
    podUid: pod.metadata.uid,
    podIp: pod.status.podIP,
    containerId: status.containerID,
    manifestDigest: digest,
  };
}

/** Bind a successful live proof to the same Pod, container, address and manifest on both sides of it. */
export async function observePinnedStrandsContainer<T>(
  read: () => Promise<Resource | undefined>,
  name: string,
  image: string,
  prove: (
    running: NonNullable<ReturnType<typeof pinnedStrandsContainer>>,
  ) => Promise<T | undefined>,
) {
  const running = pinnedStrandsContainer(await read(), name, image);
  if (!running) {
    return undefined;
  }
  const observation = await prove(running);
  if (
    observation === undefined ||
    !isDeepStrictEqual(running, pinnedStrandsContainer(await read(), name, image))
  ) {
    return undefined;
  }
  return { observation, running };
}
