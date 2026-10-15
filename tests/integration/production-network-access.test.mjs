import test from "node:test";
import { createProductionNetworkAccess } from "../helpers/production-network-access.mjs";

const selection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};
const image = process.env.OCC_TEST_KUBERNETES_IMAGE;
const requested = [...Object.values(selection), image].some(Boolean);

// These are CNI access checks against chart policies, not database, provider, or controller startup.
test(
  "production Helm policies enforce workload network access levels",
  {
    skip: requested
      ? false
      : "Select OCC_TEST_KUBERNETES_KUBECONFIG, CONTEXT, and IMAGE to verify access on disposable k3d.",
    timeout: 600_000,
  },
  async (t) => {
    const access = await createProductionNetworkAccess(t, { selection, image });
    const dependencies = ["dns", "database", "cluster"];
    const discovery = ["authentication", "catalog"];
    const optional = ["provider", "envoy", ...discovery];
    const discoveryWrongPorts = ["authenticationWrongPort", "catalogWrongPort"];
    const unrelated = [
      "unexpected",
      "databaseWrongPort",
      "clusterWrongPort",
      "exporterWrongPort",
      ...discoveryWrongPorts,
    ];
    const all = [...dependencies, "exporter", ...optional, ...unrelated];

    // Pre-install hooks run before the ordinary release policies exist.
    await access.install("bootstrap");
    await t.test("bootstrap reaches only DNS and its database", async () => {
      await access.verify({
        source: "initialization",
        allow: ["dns", "database"],
        deny: all.filter((target) => !["dns", "database"].includes(target)),
      });
    });

    // Apply every release policy, including the retained bootstrap hook: grants are additive.
    await access.install("installed");
    for (const scenario of [
      ...["api", "worker", "initialization"].map((source) => ({
        source,
        allow: dependencies,
        deny: ["exporter", ...optional, ...unrelated, ...(source === "worker" ? ["api"] : [])],
      })),
      {
        source: "collector",
        allow: ["dns", "cluster", "exporter"],
        deny: ["database", ...optional, ...unrelated],
      },
      ...["unknown", "missing"].map((source) => ({ source, deny: all })),
      // An unrelated release is outside this release's selector, not implicitly default-denied.
      { source: "otherRelease", allow: all, deny: ["api"] },
      { source: "operator", allow: ["api"] },
      { source: "foreign", deny: ["api"] },
    ]) {
      await t.test(`installed access for ${scenario.source}`, () => access.verify(scenario));
    }

    // Model and hosted catalog discovery reach only the configured hosts on API HTTPS;
    // the private Envoy route also serves the worker.
    await access.install("optional");
    for (const scenario of [
      {
        source: "api",
        allow: [...dependencies, ...optional],
        deny: ["exporter", "unexpected", "providerWrongPort", ...discoveryWrongPorts],
      },
      {
        source: "worker",
        allow: ["envoy"],
        deny: ["provider", "providerWrongPort", ...discovery, ...discoveryWrongPorts],
      },
      ...["initialization", "collector", "unknown", "missing", "otherRelease"].map((source) => ({
        source,
        deny: optional,
      })),
    ]) {
      await t.test(`optional routes for ${scenario.source}`, () => access.verify(scenario));
    }
  },
);
