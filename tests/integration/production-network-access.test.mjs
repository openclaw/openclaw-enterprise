import test from "node:test";
import { explicitK3dSelection } from "../helpers/kubernetes-real.mjs";
import { createProductionNetworkAccess } from "../helpers/production-network-access.mjs";

const selection = explicitK3dSelection();
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

    // Exercise the actual Compute-generated revision policy against the CNI.
    await access.installPublicReaderRevisions();
    await t.test("only the selected revision reaches the exact public reader peer", async () => {
      await access.verify({
        source: "selectedreader",
        allow: ["publicReader"],
        deny: ["publicReaderWrongPort", "unexpected"],
      });
      await access.verify({ source: "oldreader", deny: ["publicReader", "publicReaderWrongPort"] });
    });

    await t.test(
      "the public OpenShell quickstart preserves scoped management access across tenants",
      async (t) => {
        // Real listeners, Services, renderer output and CNI enforce this boundary. These
        // probes do not run OpenShell, an Agent lifecycle, or a model turn.
        await access.installOpenShellManagement(0);
        const ports = {
          allow: ["management"],
          deny: ["managementWrongPort"],
          controlSource: "management",
        };
        // Observe isolation before checking grants so policy propagation cannot make
        // an unrestricted connection look like a successful renderer allowance. The
        // same-release initialization Pod must not inherit the API/worker grant.
        for (const source of [
          "ordinary",
          "foreignsupervisor",
          "supervisor1",
          "managementinitialization",
        ]) {
          await access.verify({
            source,
            deny: ["management", "managementWrongPort"],
            controlSource: "management",
          });
        }
        for (const source of ["supervisor0", "gateway0", "managementapi", "managementworker"]) {
          await access.verify({ source, ...ports });
        }

        // Wait for the second tenant's grant before rechecking the first. An overwritten
        // policy must not pass while the CNI still serves the previous policy.
        await access.installOpenShellManagement(1);
        for (const source of ["supervisor1", "gateway1", "supervisor0", "gateway0"]) {
          await access.verify({ source, ...ports });
        }
        await access.verify({
          source: "foreignsupervisor",
          deny: ["management"],
          controlSource: "management",
        });

        await access.confirmManagementPortControls();

        await t.test(
          "Git-enabled management egress preserves DNS and current API endpoints",
          async () => {
            await access.installManagementRepositoryAccess();
            const allowed = [
              "dns",
              "dnsTcp",
              "kubernetesApi",
              "managementApi",
              "withdrawnManagementApi",
              "managementGit",
              "managementGitService",
            ];
            const denied = [
              "managementApiWrongPort",
              "withdrawnManagementApiWrongPort",
              "managementGitWrongPort",
              "unexpected",
            ];
            await access.verify({ source: "management", allow: allowed, deny: denied });
            // The Agent's tenant gateway must not inherit management-only API or Git
            // grants even though repository_network also emits supervisor policies.
            await access.verify({
              source: "gateway0",
              deny: [
                "managementApi",
                "withdrawnManagementApi",
                "managementGit",
                "managementGitService",
              ],
            });
            await access.withdrawManagementApiEndpoint();
            await access.verify({
              source: "management",
              allow: allowed.filter((name) => name !== "withdrawnManagementApi"),
              deny: [...denied, "withdrawnManagementApi"],
            });
            // A controlled discovery snapshot contains only the acknowledged
            // proxy slice; the native cluster API endpoints remain unchanged.
            await access.useOwnedManagementApiDiscovery();
            await access.verify({
              source: "management",
              allow: allowed.filter((name) => name !== "kubernetesApi"),
              deny: denied,
            });
            await access.withdrawAllManagementApiEndpoints();
            await access.verify({
              source: "management",
              allow: ["dns", "dnsTcp", "managementGit", "managementGitService"],
              deny: [...denied, "managementApi", "withdrawnManagementApi"],
            });
          },
        );

        // Withdrawing one supervisor policy must preserve both the other tenant and
        // the independent per-Agent gateway grant.
        await access.withdrawSupervisorGrant(1);
        await access.verify({
          source: "supervisor1",
          deny: ["management"],
          controlSource: "management",
        });
        for (const source of ["supervisor0", "gateway1"]) {
          await access.verify({ source, ...ports });
        }

        // A namespace that loses its tenant label must lose access even while its
        // named policies and Pods still exist and source egress still permits 8080.
        await access.removeTenantOwnership(0);
        for (const source of ["supervisor0", "gateway0"]) {
          await access.verify({ source, deny: ["management"], controlSource: "management" });
        }
        // Uninstall consumes the policy sets recorded by both deployments.
        await access.removeRecordedServicePolicies();
      },
    );
  },
);
