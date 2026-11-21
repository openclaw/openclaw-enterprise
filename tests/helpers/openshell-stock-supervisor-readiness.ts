import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

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
