import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { LocalRehearsalCluster, RehearsalCustody } from "../production-rehearsal-custody.ts";
import type { rehearsalPlane } from "../staging-upgrade-return.ts";
import type { TransitionFixture } from "./transition.ts";

type Plane = ReturnType<typeof rehearsalPlane>;
type ControllerPod = Awaited<ReturnType<Plane["controlPlane"]>>[number];
type Image = Parameters<Plane["controlPlane"]>[0];
type Fixture = TransitionFixture<Image, ControllerPod>;
type Target = Parameters<Fixture["openTarget"]>[0];
type Patch = { op: "test" | "replace"; path: string; value: string | number };

const containers = Type.Array(Type.Object({ name: Type.String(), image: Type.String() }));
const deployment = Type.Object({
  metadata: Type.Object({
    uid: Type.String(),
    resourceVersion: Type.String(),
    labels: Type.Record(Type.String(), Type.String()),
  }),
  spec: Type.Object({
    replicas: Type.Integer(),
    template: Type.Object({
      spec: Type.Object({
        containers,
        initContainers: Type.Optional(containers),
      }),
    }),
  }),
});
type Deployment = Static<typeof deployment>;

const readyStatus = Type.Object({
  conditions: Type.Optional(
    Type.Array(Type.Object({ type: Type.String(), status: Type.String() })),
  ),
});

// Runs only under the existing single-node disposable rehearsal. get, pods, controlPlane,
// localCluster, custody, kube and waitFor are the populated-return fixture's closures.
export function controllerCut({
  controls,
  get,
  pods,
  controlPlane,
  localCluster,
  custody,
  kube,
  waitFor,
  release,
  assertClosedRoutes,
  assertNodeContainersStopped,
  startupSecret,
}: {
  controls: Fixture["images"];
  get: (resource: string) => Promise<unknown>;
  pods: Plane["pods"];
  controlPlane: Plane["controlPlane"];
  localCluster: Pick<LocalRehearsalCluster, "assertCluster">;
  custody: Pick<RehearsalCustody, "assertRelease" | "postgres">;
  kube: (...args: string[]) => Promise<string>;
  waitFor: (description: string, observe: () => Promise<boolean>) => Promise<true>;
  release: string;
  assertClosedRoutes: Fixture["assertClosedRoutes"];
  assertNodeContainersStopped: (previous: readonly ControllerPod[]) => Promise<void>;
  startupSecret: string;
}) {
  const components = ["api", "worker"] as const;
  type Component = (typeof components)[number];
  const db = "openclaw_enterprise";
  let previous: ControllerPod[] = [];
  const names = (c: Component) => "deployment/openclaw-enterprise-" + c;
  function verify(ok: unknown): asserts ok {
    if (!ok) {
      throw new Error("controller custody mismatch");
    }
  }
  async function guardedDeployment(c: Component) {
    await localCluster.assertCluster();
    await custody.assertRelease();
    const observed = await get(names(c));
    verify(Check(deployment, observed));
    verify(
      observed.metadata.labels["app.kubernetes.io/instance"] === release &&
        previous.some((p) => p.component === c && p.deploymentUID === observed.metadata.uid),
    );
    return observed;
  }
  async function change(c: Component, edits: (spec: Deployment["spec"]) => Patch[]) {
    await assertClosedRoutes();
    const deployment = await guardedDeployment(c);
    const patch = [
      { op: "test", path: "/metadata/uid", value: deployment.metadata.uid },
      { op: "test", path: "/metadata/resourceVersion", value: deployment.metadata.resourceVersion },
      ...edits(deployment.spec),
    ];
    await kube("patch", names(c), "--type=json", "-p", JSON.stringify(patch));
  }
  async function noController() {
    verify((await pods()).length === 0);
    for (const c of components) {
      verify((await guardedDeployment(c)).spec.replicas === 0);
    }
    await assertNodeContainersStopped(previous);
    const count = await custody.postgres(
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "--dbname=postgres",
      "-c",
      "SELECT count(*) FROM pg_stat_activity WHERE datname='openclaw_enterprise' AND usename IN ('occ_app','occ_migrator')",
    );
    verify(count.trim() === "0");
  }
  return {
    async stopAndDrain(from: Target) {
      await assertClosedRoutes();
      previous = await controlPlane(controls[from], db, startupSecret);
      for (const c of components) {
        await change(c, () => [
          { op: "test", path: "/spec/replicas", value: 1 },
          { op: "replace", path: "/spec/replicas", value: 0 },
        ]);
      }
      await waitFor("all source pods gone", async () => (await pods()).length === 0);
      await noController();
      return previous;
    },
    assertNoController: noController,
    async startClosed(to: Target, image: Image) {
      verify(image === controls[to]);
      await noController();
      for (const c of components) {
        await change(c, (spec) => {
          const path =
            "/spec/template/spec/containers/" +
            spec.template.spec.containers.findIndex((v) => v.name === c);
          const initImages = (spec.template.spec.initContainers ?? []).flatMap<Patch>(
            (init, index) => {
              if (!Object.values(controls).some((i) => i.reference === init.image)) {
                return [];
              }
              const field = "/spec/template/spec/initContainers/" + index + "/image";
              return [
                { op: "test", path: field, value: init.image },
                { op: "replace", path: field, value: image.reference },
              ];
            },
          );
          return [
            ...initImages,
            { op: "test", path: "/spec/replicas", value: 0 },
            { op: "test", path: path + "/name", value: c },
            { op: "replace", path: path + "/image", value: image.reference },
            { op: "replace", path: "/spec/replicas", value: 1 },
          ];
        });
      }
      await waitFor("two ready target pods", async () => {
        const list = await pods();
        return (
          list.length === 2 &&
          list.every(
            (p) =>
              !p.metadata.deletionTimestamp &&
              Check(readyStatus, p.status) &&
              p.status.conditions?.some((v) => v.type === "Ready" && v.status === "True"),
          )
        );
      });
    },
    async assertOnlyTarget(to: Target, image: Image, old: readonly ControllerPod[]) {
      verify(image === controls[to]);
      const next = await controlPlane(image, db, startupSecret);
      verify(next.length === 2 && next.every((p) => old.every((o) => o.uid !== p.uid)));
      if (old.length) {
        await assertNodeContainersStopped(old);
      }
    },
  };
}
