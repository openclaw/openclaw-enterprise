import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { imageConfigDigest } from "../../scripts/ci/image-config-digest.ts";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const manifestTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const indexTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

function verifiedJson(raw: string, digest: string) {
  // buildx can add a display newline; accept it only if removing it restores the pinned bytes.
  const candidates = [raw, ...(raw.endsWith("\n") ? [raw.slice(0, -1)] : [])];
  const bytes = candidates.find(
    (candidate) => `sha256:${createHash("sha256").update(candidate).digest("hex")}` === digest,
  );
  if (!digestPattern.test(digest) || bytes === undefined) {
    throw new Error("stock image metadata does not match its digest");
  }
  const value: unknown = JSON.parse(bytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stock image metadata is not an object");
  }
  return { bytes, value: value as Record<string, unknown> };
}

export function stockSupervisorManifest(indexRaw: string, indexDigest: string, platform: string) {
  if (!["linux/amd64", "linux/arm64"].includes(platform)) {
    throw new Error("unsupported stock Supervisor platform");
  }
  const { value: index } = verifiedJson(indexRaw, indexDigest);
  if (!indexTypes.has(String(index.mediaType)) || !Array.isArray(index.manifests)) {
    throw new Error("stock Supervisor pin does not identify an image index");
  }
  const matches = index.manifests.filter((entry: unknown) => {
    if (entry === null || typeof entry !== "object") {
      return false;
    }
    const descriptor = entry as Record<string, unknown>;
    const selected = descriptor.platform as Record<string, unknown> | undefined;
    return selected && `${selected.os}/${selected.architecture}` === platform;
  }) as Record<string, unknown>[];
  if (
    matches.length !== 1 ||
    !manifestTypes.has(String(matches[0]?.mediaType)) ||
    typeof matches[0]?.digest !== "string" ||
    !digestPattern.test(matches[0].digest)
  ) {
    throw new Error("stock Supervisor index has no unique platform manifest");
  }
  return { mediaType: String(matches[0].mediaType), digest: matches[0].digest };
}

export async function stockSupervisorConfig(
  descriptor: { mediaType: string; digest: string },
  manifestRaw: string,
  inspectLocal: (
    flags: string[],
  ) => Promise<Parameters<typeof imageConfigDigest>[0] & { Os?: string; Architecture?: string }>,
  platform: string,
): Promise<string> {
  const { value: manifest, bytes } = verifiedJson(manifestRaw, descriptor.digest);
  if (manifest.mediaType !== descriptor.mediaType) {
    throw new Error("stock Supervisor manifest media type differs from its descriptor");
  }
  const config = manifest.config as Record<string, unknown> | undefined;
  let inspected = await inspectLocal([]);
  if (indexTypes.has(inspected.Descriptor?.mediaType ?? "")) {
    inspected = await inspectLocal(["--platform", platform]);
  }
  if (typeof config?.digest !== "string" || !digestPattern.test(config.digest)) {
    throw new Error("stock Supervisor manifest has no config digest");
  }
  if (`${inspected.Os}/${inspected.Architecture}` !== platform) {
    throw new Error("stock Supervisor inspection differs from the selected platform");
  }
  if (
    inspected.Descriptor &&
    (inspected.Descriptor.digest !== descriptor.digest ||
      inspected.Descriptor.mediaType !== descriptor.mediaType)
  ) {
    throw new Error("stock Supervisor inspection differs from the pinned platform manifest");
  }
  const resolved = await imageConfigDigest(inspected, async (digest) => {
    if (digest !== descriptor.digest) {
      throw new Error("stock Supervisor inspection requested an unexpected manifest");
    }
    return bytes;
  });
  if (resolved !== config.digest) {
    throw new Error("stock Supervisor inspection differs from the pinned config");
  }
  return config.digest;
}

export function assertStockSupervisorImport(
  manifestRaw: string,
  manifestDigest: string,
  configDigest: string,
): void {
  const { value: manifest } = verifiedJson(manifestRaw, manifestDigest);
  const config = manifest.config as Record<string, unknown> | undefined;
  if (config?.digest !== configDigest) {
    throw new Error("imported Supervisor manifest must use the pinned stock config");
  }
}

interface SupervisorStatus {
  readonly name: string;
  readonly ready?: boolean;
  readonly imageID?: string;
  readonly containerID?: string;
  readonly restartCount?: number;
  readonly state?: {
    readonly running?: object;
    readonly waiting?: { readonly reason?: string };
    readonly terminated?: { readonly reason?: string };
  };
}

interface SupervisorPod {
  readonly metadata: {
    readonly uid: string;
    readonly name: string;
    readonly deletionTimestamp?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
    readonly ownerReferences?: readonly { readonly kind: string; readonly uid: string }[];
  };
  readonly spec: {
    readonly containers: readonly { readonly name: string; readonly image: string }[];
  };
  readonly status?: {
    readonly phase?: string;
    readonly containerStatuses?: readonly SupervisorStatus[];
  };
}

/** Observe only the selected Pod. Image and identity mismatches are never retried. */
export async function waitForStockSupervisor(
  initial: SupervisorPod,
  readPod: (signal: AbortSignal) => Promise<SupervisorPod>,
  expected: {
    readonly sandboxId: string;
    readonly sandboxUid: string;
    readonly image: string;
    readonly digests: readonly string[];
  },
  signal: AbortSignal,
  timeoutMs = 60_000,
) {
  const { uid, name } = initial.metadata;
  const pair = initial.metadata.labels?.["openshell.ai/boundary-pair"];
  assert.ok(uid && name && pair, "the selected supervisor must have a Pod identity and pair");
  const deadline = AbortSignal.timeout(timeoutMs);
  const bounded = AbortSignal.any([signal, deadline]);
  let pod = initial;
  let status: SupervisorStatus | undefined;
  let containerId: string | undefined;
  try {
    for (;;) {
      bounded.throwIfAborted();
      const metadata = pod.metadata;
      assert.equal(metadata.uid, uid, "the supervisor Pod UID changed");
      assert.equal(metadata.name, name, "the supervisor Pod name changed");
      assert.ok(!metadata.deletionTimestamp, "the selected supervisor Pod is terminating");
      assert.equal(metadata.labels?.["openshell.ai/boundary-role"], "supervisor");
      assert.equal(metadata.labels?.["openshell.ai/boundary-pair"], pair);
      assert.equal(metadata.annotations?.["openshell.ai/sandbox-id"], expected.sandboxId);
      assert.ok(
        metadata.ownerReferences?.some(
          (owner) => owner.kind === "Sandbox" && owner.uid === expected.sandboxUid,
        ),
        "the supervisor must belong to the selected Sandbox resource",
      );
      assert.ok(
        pod.status?.phase !== "Failed" && pod.status?.phase !== "Succeeded",
        "the selected supervisor Pod ended before becoming ready",
      );
      const container = pod.spec.containers.find((item) => item.name === "supervisor");
      assert.equal(
        container?.image,
        expected.image,
        "the supervisor must select the verified stock image",
      );
      status = pod.status?.containerStatuses?.find((item) => item.name === "supervisor");
      if (status?.imageID) {
        const digest = status.imageID.match(/sha256:[a-f0-9]{64}$/u)?.[0];
        assert.ok(
          digest && expected.digests.includes(digest),
          "the running supervisor image must match the verified stock image",
        );
      }
      if (status?.containerID) {
        containerId ??= status.containerID;
        assert.equal(status.containerID, containerId, "the supervisor container identity changed");
      }
      if (status?.ready && status.state?.running && status.imageID && status.containerID) {
        return status;
      }
      await sleep(250, undefined, { signal: bounded });
      pod = await readPod(bounded);
    }
  } catch (error) {
    signal.throwIfAborted();
    if (!deadline.aborted) {
      throw error;
    }
  }
  // Status reason tokens are sufficient for diagnosis; omit arbitrary Kubernetes messages.
  const token = (value: string | undefined) =>
    value && /^[A-Za-z0-9_]{1,64}$/u.test(value) ? value : "Unknown";
  const phase = token(pod.status?.phase);
  const reason = token(status?.state?.waiting?.reason ?? status?.state?.terminated?.reason);
  throw new Error(
    `the supervisor did not become ready within ${timeoutMs} ms (phase=${phase}, reason=${reason}, restarts=${status?.restartCount ?? "unknown"})`,
    { cause: deadline.reason },
  );
}
