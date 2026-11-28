import assert from "node:assert/strict";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  migrationEntry,
  selectedImageMigrationEntry,
} from "../../../scripts/lib/selected-image-migration.ts";
import type {
  FixtureRun,
  LocalRehearsalCluster,
  RehearsalCustody,
} from "../production-rehearsal-custody.ts";
import { verifyCompletedMigrationHistory, type rehearsalPlane } from "../staging-upgrade-return.ts";

type Plane = ReturnType<typeof rehearsalPlane>;
type Image = Parameters<Plane["verifyPodImage"]>[0];
type Source = { uid: string; containerID: string };

const readyNode = Type.Object({
  metadata: Type.Object({ uid: Type.String() }),
  status: Type.Object({
    conditions: Type.Array(Type.Object({ type: Type.String(), status: Type.String() })),
  }),
});
const criContainers = Type.Array(
  Type.Object({
    id: Type.String(),
    labels: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()])),
    metadata: Type.Optional(Type.Object({ name: Type.String() })),
    state: Type.Optional(Type.String()),
  }),
);
const livePodList = Type.Object({
  items: Type.Array(
    Type.Object({
      metadata: Type.Object({
        uid: Type.String(),
        deletionTimestamp: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      status: Type.Object({
        phase: Type.Optional(Type.String()),
        containerStatuses: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String(),
              containerID: Type.Optional(Type.String()),
              state: Type.Object({ running: Type.Optional(Type.Unknown()) }),
            }),
          ),
        ),
      }),
    }),
  ),
});
const named = Type.Object({ name: Type.String() });
const initializationJob = Type.Object({
  spec: Type.Object({
    template: Type.Object({
      spec: Type.Object({
        initContainers: Type.Array(named),
        securityContext: Type.Optional(Type.Unknown()),
        volumes: Type.Array(named),
      }),
    }),
  }),
});
const migrationContainer = Type.Object({
  ...named.properties,
  args: Type.Array(Type.String()),
  env: Type.Array(
    Type.Object({
      ...named.properties,
      valueFrom: Type.Optional(Type.Object({ secretKeyRef: Type.Optional(Type.Unknown()) })),
    }),
  ),
  volumeMounts: Type.Array(
    Type.Object({ ...named.properties, readOnly: Type.Optional(Type.Boolean()) }),
  ),
});
const migrationProgress = Type.Object({
  metadata: Type.Object({ uid: Type.String() }),
  status: Type.Object({ phase: Type.Optional(Type.String()) }),
});
const migrationImage = Type.Object({
  metadata: migrationProgress.properties.metadata,
  spec: Type.Object({ nodeName: Type.Optional(Type.String()) }),
  status: Type.Object({
    containerStatuses: Type.Array(
      Type.Object({
        ...named.properties,
        imageID: Type.String(),
        containerID: Type.Optional(Type.String()),
      }),
    ),
  }),
});

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
}: {
  localCluster: Pick<LocalRehearsalCluster, "node" | "nodeUID" | "runtimeInventory">;
  custody: Pick<RehearsalCustody, "assertRelease" | "assertPostgres" | "create" | "metadata">;
  namespace: string;
  release: string;
  run: FixtureRun;
  kubeArgs: string[];
  get: (resource: string) => Promise<unknown>;
  waitFor: <T>(description: string, observe: () => Promise<T | false | undefined>) => Promise<T>;
  verifyPodImage: Plane["verifyPodImage"];
}) {
  async function read<S extends TSchema>(resource: string, schema: S): Promise<Static<S>> {
    const value = await get(resource);
    assert(Check(schema, value), "invalid runtime witness " + resource);
    return value;
  }
  let count = 0;
  return {
    async assertNodeContainersStopped(previous: readonly Source[]) {
      const node = await read("node/" + localCluster.node, readyNode);
      assert.equal(node.metadata.uid, localCluster.nodeUID);
      assert(node.status.conditions.some((c) => c.type === "Ready" && c.status === "True"));
      // The inventory validates live task IDs; its public container type only exposes `id`.
      const { containers: inventory, tasks } = await localCluster.runtimeInventory();
      assert(Check(criContainers, inventory), "invalid CRI container witness");
      const containers = inventory;
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
      const live = (await read("pods", livePodList)).items.filter(
        (p) => !p.metadata.deletionTimestamp && p.status.phase === "Running",
      );
      for (const c of containers) {
        const labels = c.labels;
        if (labels?.["io.kubernetes.pod.namespace"] !== namespace) {
          continue;
        }
        assert(c.metadata, "missing CRI container metadata");
        const { name } = c.metadata;
        if (!["api", "worker"].includes(name)) {
          continue;
        }
        if (c.state === "CONTAINER_RUNNING" || tasks.includes(c.id)) {
          const pod = live.find((p) => p.metadata.uid === labels["io.kubernetes.pod.uid"]);
          assert(
            pod?.status.containerStatuses?.some(
              (status) =>
                status.name === name &&
                status.containerID === "containerd://" + c.id &&
                status.state.running,
            ),
          );
        }
      }
    },
    async completedHistory(image: Image) {
      await custody.assertRelease();
      await custody.assertPostgres();
      const template = (await read("job/" + release + "-initialization", initializationJob)).spec
        .template;
      const migration = template.spec.initContainers.find((c) => c.name === "migration");
      assert(Check(migrationContainer, migration), "invalid initialization migration container");
      assert(migrationEntry(migration.args));
      const databaseEnv = migration.env.find((e) => e.name === "OCC_MIGRATION_DATABASE_URL");
      assert(databaseEnv?.valueFrom, "missing migration database reference");
      const db = databaseEnv.valueFrom.secretKeyRef;
      assert.deepEqual(db, { name: "occ-database", key: "migration-url" });
      assert(migration.volumeMounts.some((m) => m.name === "database-ca" && m.readOnly));
      const name = "signin-migration-" + ++count;
      const migrationPod = {
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
            {
              ...migration,
              image: image.reference,
              // The target image may be older than the retained initializer.
              args: [...selectedImageMigrationEntry, "--check"],
            },
          ],
        },
      };
      const uid = await custody.create(migrationPod);
      const pod = await waitFor("target migration check", async () => {
        const p = await read("pod/" + name, migrationProgress);
        assert.equal(p.metadata.uid, uid);
        assert(p.status.phase !== "Failed");
        return p.status.phase === "Succeeded" && p;
      });
      assert(Check(migrationImage, pod), "invalid completed migration Pod");
      await verifyPodImage(
        image,
        pod,
        pod.status.containerStatuses.find((s) => s.name === "migration"),
      );
      await verifyCompletedMigrationHistory(run, kubeArgs, name);
    },
  };
}
