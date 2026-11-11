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
}) {
  const components = ["api", "worker"];
  const db = "openclaw_enterprise";
  let previous = [];
  const names = (c) => "deployment/openclaw-enterprise-" + c;
  const verify = (ok) => {
    if (!ok) {
      throw new Error("controller custody mismatch");
    }
  };
  async function guardedDeployment(c) {
    await localCluster.assertCluster();
    await custody.assertRelease();
    const deployment = await get(names(c));
    verify(
      deployment.metadata.labels["app.kubernetes.io/instance"] === release &&
        previous.some((p) => p.component === c && p.deploymentUID === deployment.metadata.uid),
    );
    return deployment;
  }
  async function change(c, edits) {
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
    async stopAndDrain(from) {
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
    async startClosed(to, image) {
      verify(image === controls[to]);
      await noController();
      for (const c of components) {
        await change(c, (spec) => {
          const path =
            "/spec/template/spec/containers/" +
            spec.template.spec.containers.findIndex((v) => v.name === c);
          const initImages = (spec.template.spec.initContainers ?? []).flatMap((init, index) => {
            if (!Object.values(controls).some((i) => i.reference === init.image)) {
              return [];
            }
            const field = "/spec/template/spec/initContainers/" + index + "/image";
            return [
              { op: "test", path: field, value: init.image },
              { op: "replace", path: field, value: image.reference },
            ];
          });
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
              p.status.conditions?.some((v) => v.type === "Ready" && v.status === "True"),
          )
        );
      });
    },
    async assertOnlyTarget(to, image, old) {
      verify(image === controls[to]);
      const next = await controlPlane(image, db, startupSecret);
      verify(next.length === 2 && next.every((p) => old.every((o) => o.uid !== p.uid)));
      if (old.length) {
        await assertNodeContainersStopped(old);
      }
    },
  };
}
