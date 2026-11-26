import assert from "node:assert/strict";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { LocalRehearsalCluster, RehearsalCustody } from "../production-rehearsal-custody.ts";

const operatorIdentity = Type.Object({
  metadata: Type.Object({ uid: Type.String() }),
  status: Type.Object({
    containerStatuses: Type.Array(
      Type.Object({
        name: Type.String(),
        containerID: Type.Optional(Type.String()),
      }),
    ),
  }),
});
const operatorControl = Type.Object({
  metadata: Type.Object({
    uid: Type.String(),
    deletionTimestamp: Type.Optional(Type.String()),
  }),
  spec: Type.Object({
    nodeName: Type.String(),
    volumes: Type.Array(
      Type.Object({
        name: Type.String(),
        emptyDir: Type.Optional(Type.Object({})),
      }),
    ),
    containers: Type.Array(
      Type.Object({
        name: Type.String(),
        volumeMounts: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String(),
              mountPath: Type.String(),
              subPath: Type.Optional(Type.String()),
              readOnly: Type.Optional(Type.Boolean()),
            }),
          ),
        ),
      }),
    ),
  }),
  status: Type.Object({
    containerStatuses: Type.Array(
      Type.Object({
        name: Type.String(),
        ready: Type.Boolean(),
        restartCount: Type.Integer(),
        containerID: Type.Optional(Type.String()),
      }),
    ),
  }),
});

export async function operatorExecutor({
  get,
  custody,
  localCluster,
  exec,
}: {
  get: (resource: string) => Promise<unknown>;
  custody: Pick<RehearsalCustody, "assertUID">;
  localCluster: Pick<LocalRehearsalCluster, "assertCluster" | "node">;
  exec: (...args: string[]) => Promise<string>;
}) {
  const expected = await get("pod/operator");
  assert(Check(operatorIdentity, expected), "invalid operator identity");
  custody.assertUID("pod/operator", expected.metadata.uid);
  const uid = expected.metadata.uid;
  const generation = expected.status.containerStatuses.find(
    (c) => c.name === "operator",
  )?.containerID;
  assert(generation);
  assert.match(generation, /^containerd:\/\/[a-f0-9]{64}$/);
  const guard = `test "$OCE_TEST_POD_UID" = "$1" && test "$(cat /operator/signin-gate.generation)" = "$2" || exit 42; shift 2; exec "$@"`;
  async function check() {
    await localCluster.assertCluster();
    const pod = await get("pod/operator");
    assert(Check(operatorControl, pod), "invalid operator Pod");
    custody.assertUID("pod/operator", pod.metadata.uid);
    assert.equal(pod.spec.nodeName, localCluster.node);
    assert(!pod.metadata.deletionTimestamp);
    const status = pod.status.containerStatuses.find((c) => c.name === "operator");
    assert(status?.ready && status.restartCount === 0 && status.containerID === generation);
    assert(pod.spec.volumes.some((v) => v.name === "operator-private" && v.emptyDir));
    assert(
      pod.spec.containers
        .find((c) => c.name === "operator")
        ?.volumeMounts?.some(
          (m) =>
            m.name === "operator-private" &&
            m.mountPath === "/operator" &&
            !m.subPath &&
            !m.readOnly,
        ),
    );
  }
  await check();
  const token = (await exec("cat", "/operator/signin-gate.generation")).trim();
  assert.match(token, /^[a-f0-9-]{36}$/);
  return async (...args: string[]) => {
    await check();
    return exec("sh", "-ec", guard, "operator-custody", uid, token, ...args);
  };
}
