import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function verifyStrandsTransport({
  fixture,
  gateway,
  kube,
  objects,
  owned,
  check,
  result,
}) {
  await check("real native Harness streaming stdin cancellation and reconnect", async () => {
    const configuration = await gateway("config.get");
    const native = configuration.config.plugins.entries.codex.config.appServer;
    assert.equal(native.sandbox, "danger-full-access");
    assert.equal(native.approvalPolicy, "never");
    const snapshot = () =>
      objects("pods").then((items) =>
        owned(items)
          .map((pod) => ({
            name: pod.metadata.name,
            uid: pod.metadata.uid,
            restarts: pod.status.containerStatuses.map(({ name, restartCount }) => ({
              name,
              restartCount,
            })),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    const before = await snapshot();
    const pods = owned(await objects("pods"));
    const pod = pods.find(
      (item) => item.metadata.name.startsWith("strands-") && !item.metadata.deletionTimestamp,
    );
    assert.ok(pod);
    const probe = pod.spec.containers.find((item) => item.name === "agent").readinessProbe.exec
      .command;
    const source = await readFile(
      new URL("./strands-transport-probe.mjs", import.meta.url),
      "utf8",
    );
    const output = await kube(
      "-n",
      fixture.namespaceName,
      "exec",
      pod.metadata.name,
      "-c",
      "agent",
      "--",
      "node",
      "--input-type=module",
      "-e",
      source,
      ...probe.slice(-2),
      JSON.stringify({ type: "dangerFullAccess" }),
    );
    const receipt = JSON.parse(output);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.cases.length, 6);
    assert.deepEqual(await snapshot(), before, "no replacement or restart during transport tests");
    result.nativeTransport = { ...receipt, unchangedPods: true };
  });
}
