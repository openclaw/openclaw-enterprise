import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { protectedJSON, type RehearsalCustody } from "../production-rehearsal-custody.ts";
import type { TransitionFixture } from "./transition.ts";

const pod = Type.Object({
  kind: Type.Optional(Type.Literal("Pod")),
  metadata: Type.Object({
    name: Type.String(),
    namespace: Type.String(),
    uid: Type.String(),
    resourceVersion: Type.String(),
    annotations: Type.Optional(Type.Record(Type.String(), Type.String())),
  }),
  spec: Type.Object({
    containers: Type.Array(Type.Object({ name: Type.String(), image: Type.String() })),
  }),
});
const historyEvent = Type.Union([
  Type.Object({ type: Type.Literal("BOOKMARK") }),
  Type.Object({
    type: Type.Union([Type.Literal("ADDED"), Type.Literal("MODIFIED"), Type.Literal("DELETED")]),
    object: Type.Object({ ...pod.properties, kind: Type.Literal("Pod") }),
  }),
]);
const podList = Type.Object({
  kind: Type.Literal("PodList"),
  metadata: Type.Object({ continue: Type.Optional(Type.String()), resourceVersion: Type.String() }),
  items: Type.Array(pod),
});
type Pod = Static<typeof pod>;
type Target = Parameters<TransitionFixture<never, never>["openTarget"]>[0];

const annotation = "openclaw.dev/signin-writer-fence";

function version(value: unknown) {
  // This pinned k3s fixture emits positive decimal cursors. Keep them as strings; never compare their order.
  assert(typeof value === "string" && /^[1-9]\d*$/.test(value), "missing exact Pod version");
  return value;
}

export function writerFence({
  system,
  controlName,
  controlUID,
  get,
  read,
  custody,
  clock,
  checkTopology,
  usesV2,
}: {
  system: string;
  controlName: string;
  controlUID: string;
  get: (resource: string) => Promise<unknown>;
  read: (...args: string[]) => Promise<string>;
  custody: Pick<RehearsalCustody, "assertUID">;
  clock: Pick<
    TransitionFixture<never, never>,
    "verifiedSkewMs" | "readerUpperMs" | "waitUntilReaderPast"
  >;
  checkTopology: () => Promise<void>;
  usesV2: boolean;
}) {
  const collection = "/api/v1/namespaces/" + encodeURIComponent(system) + "/pods";
  const resource = "pod/" + controlName;
  let cursor: string | undefined;
  let permitted: string | undefined;
  let permittedUIDs: Set<string> | undefined;
  let fenceWall: number | undefined;
  let present = new Set<string>();

  function writers(pod: Pod) {
    assert.equal(pod.metadata.namespace, system);
    assert(typeof pod.metadata.uid === "string" && pod.metadata.uid);
    return pod.spec.containers.filter((c) => ["api", "worker"].includes(c.name));
  }

  function controlIdentity(pod: Pod) {
    assert.equal(pod.kind, "Pod");
    assert.equal(pod.metadata.namespace, system);
    assert.equal(pod.metadata.name, controlName);
    assert.equal(pod.metadata.uid, controlUID);
    custody.assertUID(resource, controlUID);
    return version(pod.metadata.resourceVersion);
  }

  async function check(expectedUIDs?: readonly string[], allowedUIDs = permittedUIDs) {
    assert(cursor);
    await checkTopology();
    const control = await get(resource);
    assert(Check(pod, control), "invalid control Pod");
    const rv = controlIdentity(control);
    const nonce = randomUUID();
    const patch = [
      { op: "test", path: "/metadata/uid", value: controlUID },
      { op: "test", path: "/metadata/resourceVersion", value: rv },
      control.metadata.annotations
        ? {
            op: "add",
            path: "/metadata/annotations/openclaw.dev~1signin-writer-fence",
            value: nonce,
          }
        : { op: "add", path: "/metadata/annotations", value: { [annotation]: nonce } },
    ];
    const updated = protectedJSON<unknown>(
      await read("patch", resource, "--type=json", "-p", JSON.stringify(patch), "-o", "json"),
    );
    assert(Check(pod, updated), "invalid patched control Pod");
    const witness = controlIdentity(updated);
    assert.notEqual(witness, rv);
    assert.equal(updated.metadata.annotations?.[annotation], nonce);
    const events = await read(
      "get",
      "--raw",
      collection +
        "?watch=1&allowWatchBookmarks=true&timeoutSeconds=1&resourceVersion=" +
        encodeURIComponent(cursor),
    );
    const next = new Set(present);
    for (const line of events.trim().split("\n").filter(Boolean)) {
      const event = protectedJSON<unknown>(line);
      assert(Check(historyEvent, event), "invalid Pod history");
      if (event.type === "BOOKMARK") {
        continue;
      }
      const { type, object } = event;
      const eventRV = version(object.metadata.resourceVersion);
      const containers = writers(object);
      if (containers.length) {
        assert(
          permitted && containers.every((c) => c.image === permitted),
          "unexpected writer entered the fenced interval",
        );
        if (allowedUIDs) {
          assert(allowedUIDs.has(object.metadata.uid), "unexpected writer UID in Pod history");
        }
        if (type === "DELETED") {
          next.delete(object.metadata.uid);
        } else {
          next.add(object.metadata.uid);
        }
      }
      if (type !== "MODIFIED" || object.metadata.uid !== controlUID || eventRV !== witness) {
        continue;
      }
      controlIdentity(object);
      assert.equal(object.metadata.annotations?.[annotation], nonce);
      if (expectedUIDs) {
        assert.deepEqual(next, new Set(expectedUIDs), "unexpected live writer UIDs");
      }
      await clock.verifiedSkewMs();
      // Re-watch from this exact event. Its unread suffix belongs to the next phase.
      cursor = witness;
      present = next;
      return;
    }
    throw new Error("Pod history did not reach the exact control witness");
  }

  return {
    check,
    active: () => Boolean(cursor),
    async admit(uids: readonly string[], image: { reference: string }) {
      if (!cursor) {
        const list = protectedJSON<unknown>(await read("get", "--raw", collection));
        assert(Check(podList, list), "invalid Pod list");
        assert(!list.metadata.continue);
        for (const pod of list.items) {
          const containers = writers(pod);
          if (!containers.length) {
            continue;
          }
          assert(
            containers.every((c) => c.image === image.reference),
            "unexpected initial writer",
          );
          present.add(pod.metadata.uid);
        }
        assert.deepEqual(present, new Set(uids), "unexpected initial writer UIDs");
        cursor = version(list.metadata.resourceVersion);
        permitted = image.reference;
      }
      assert.equal(permitted, image.reference);
      const approved = new Set(uids);
      if (permittedUIDs) {
        assert.deepEqual(approved, permittedUIDs, "verified writer UIDs changed");
      }
      await check(uids, approved);
      permittedUIDs = approved;
    },
    async drained(from: Target) {
      await check([]);
      permitted = undefined;
      permittedUIDs = undefined;
      if (usesV2 && from === "P") {
        fenceWall = await clock.readerUpperMs();
      }
    },
    async starting(to: Target, image: { reference: string }) {
      await check([]);
      if (usesV2 && to === "P") {
        assert(fenceWall !== undefined && Number.isFinite(fenceWall));
        const skew = await clock.verifiedSkewMs();
        await clock.waitUntilReaderPast(fenceWall + 120000 + skew);
        await check([]);
      }
      permitted = image.reference;
    },
  };
}
