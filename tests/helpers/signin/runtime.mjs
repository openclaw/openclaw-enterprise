import assert from "node:assert/strict";
import { verifyCompletedMigrationHistory } from "../staging-upgrade-return.ts";

export function runtimeProof({
  localCluster,
  custody,
  namespace,
  release,
  run,
  kubeArgs,
  get,
  waitFor,
  verifyPodImage,
}) {
  let count = 0;
  return {
    async assertNodeContainersStopped(previous) {
      const node = await get("node/" + localCluster.node);
      assert.equal(node.metadata.uid, localCluster.nodeUID);
      assert(node.status.conditions.some((c) => c.type === "Ready" && c.status === "True"));
      const { containers, tasks } = await localCluster.runtimeInventory();
      for (const source of previous) {
        const retired = containers.filter(
          (c) => c.labels?.["io.kubernetes.pod.uid"] === source.uid,
        );
        // A missing CRI history row is acceptable only for the acknowledged container if
        // the node's live task table independently excludes that exact container ID.
        assert.match(source.containerID, /^containerd:\/\/[a-f0-9]{64}$/);
        assert(!tasks.includes(source.containerID.slice("containerd://".length)));
        assert(retired.every((c) => c.state === "CONTAINER_EXITED" && !tasks.includes(c.id)));
      }
      // Include earlier restarts and the initial bootstrap deployment generation.
      const live = (await get("pods")).items.filter(
        (p) => !p.metadata.deletionTimestamp && p.status.phase === "Running",
      );
      for (const c of containers) {
        if (
          c.labels?.["io.kubernetes.pod.namespace"] !== namespace ||
          !["api", "worker"].includes(c.metadata.name)
        ) {
          continue;
        }
        if (c.state === "CONTAINER_RUNNING" || tasks.includes(c.id)) {
          const pod = live.find((p) => p.metadata.uid === c.labels["io.kubernetes.pod.uid"]);
          assert(
            pod?.status.containerStatuses.some(
              (status) =>
                status.name === c.metadata.name &&
                status.containerID === "containerd://" + c.id &&
                status.state.running,
            ),
          );
        }
      }
    },
    async completedHistory(image) {
      await custody.assertRelease();
      await custody.assertPostgres();
      const template = (await get("job/" + release + "-initialization")).spec.template;
      const migration = template.spec.initContainers.find((c) => c.name === "migration");
      assert(migration.args[0] === "scripts/migrate-production.mjs");
      const db = migration.env.find((e) => e.name === "OCC_MIGRATION_DATABASE_URL")?.valueFrom
        .secretKeyRef;
      assert.deepEqual(db, { name: "occ-database", key: "migration-url" });
      assert(migration.volumeMounts.some((m) => m.name === "database-ca" && m.readOnly));
      const name = "signin-migration-" + ++count;
      const uid = await custody.create({
        apiVersion: "v1",
        kind: "Pod",
        metadata: custody.metadata(name, {
          "app.kubernetes.io/name": "openclaw-enterprise",
          "app.kubernetes.io/instance": release,
          "app.kubernetes.io/component": "initialization",
        }),
        spec: {
          restartPolicy: "Never",
          activeDeadlineSeconds: 90,
          automountServiceAccountToken: false,
          securityContext: template.spec.securityContext,
          volumes: template.spec.volumes.filter((v) =>
            migration.volumeMounts.some((m) => m.name === v.name),
          ),
          containers: [
            { ...migration, image: image.reference, args: [migration.args[0], "--check"] },
          ],
        },
      });
      const pod = await waitFor("target migration check", async () => {
        const p = await get("pod/" + name);
        assert.equal(p.metadata.uid, uid);
        assert(p.status.phase !== "Failed");
        return p.status.phase === "Succeeded" && p;
      });
      await verifyPodImage(
        image,
        pod,
        pod.status.containerStatuses.find((s) => s.name === "migration"),
      );
      await verifyCompletedMigrationHistory(run, kubeArgs, name);
    },
  };
}
