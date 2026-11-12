import assert from "node:assert/strict";

export async function operatorExecutor({ get, custody, localCluster, exec }) {
  const expected = await get("pod/operator");
  custody.assertUID("pod/operator", expected.metadata.uid);
  const uid = expected.metadata.uid;
  const generation = expected.status.containerStatuses.find(
    (c) => c.name === "operator",
  )?.containerID;
  assert.match(generation, /^containerd:\/\/[a-f0-9]{64}$/);
  const guard = `test "$OCE_TEST_POD_UID" = "$1" && test "$(cat /operator/signin-gate.generation)" = "$2" || exit 42; shift 2; exec "$@"`;
  async function check() {
    await localCluster.assertCluster();
    const pod = await get("pod/operator");
    custody.assertUID("pod/operator", pod.metadata.uid);
    assert.equal(pod.spec.nodeName, localCluster.node);
    assert(!pod.metadata.deletionTimestamp);
    const status = pod.status.containerStatuses.find((c) => c.name === "operator");
    assert(status.ready && status.restartCount === 0 && status.containerID === generation);
    assert(pod.spec.volumes.some((v) => v.name === "operator-private" && v.emptyDir));
    assert(
      pod.spec.containers
        .find((c) => c.name === "operator")
        .volumeMounts.some(
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
  return async (...args) => {
    await check();
    return exec("sh", "-ec", guard, "operator-custody", uid, token, ...args);
  };
}
