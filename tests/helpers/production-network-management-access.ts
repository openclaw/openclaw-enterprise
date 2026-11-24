import assert from "node:assert/strict";
import { kubernetesHash } from "./kubernetes-real.ts";

export type ManagementTenant = { namespace: string; id: string; agent: string };

type PolicyControls = {
  system: string;
  allowManagementPort: (name: string, port: number) => Promise<unknown>;
  controls: (names: readonly string[], source: string) => Promise<void>;
  kubectl: (...args: string[]) => Promise<string>;
  runNetworkHelper: (command: "delete_service_peers") => Promise<unknown>;
  recordedTenants: () => Iterable<ManagementTenant, void, unknown>;
  tenantField: (index: number, field: "id" | "namespace") => string;
};

export function createManagementPolicyControls(fixture: PolicyControls) {
  const {
    system,
    allowManagementPort,
    controls,
    kubectl,
    runNetworkHelper,
    recordedTenants,
    tenantField,
  } = fixture;
  return {
    async confirmManagementPortControls() {
      // Change only destination ingress. A successful connection from each caller
      // proves that its preceding 8081 denial was not caused by source egress.
      const name = "verify-management-listener";
      await allowManagementPort(name, 8081);
      try {
        await Promise.all(
          [
            "managementapi",
            "managementworker",
            "supervisor0",
            "gateway0",
            "supervisor1",
            "gateway1",
          ].map((source) => controls(["managementWrongPort"], source)),
        );
      } finally {
        await kubectl("delete", "networkpolicy", "-n", system, name);
      }
    },
    async removeRecordedServicePolicies() {
      await runNetworkHelper("delete_service_peers");
      for (const tenant of recordedTenants()) {
        const remaining = await kubectl(
          "get",
          "networkpolicy",
          "-n",
          system,
          "--ignore-not-found",
          "-o",
          "name",
          "oce-management-from-supervisors-" + kubernetesHash(tenant.id),
          "oce-management-from-" + kubernetesHash(tenant.agent),
        );
        assert.equal(remaining.trim(), "", "uninstall must remove earlier and later tenant grants");
      }
    },
    async withdrawSupervisorGrant(index: number) {
      const id = tenantField(index, "id");
      await kubectl(
        "delete",
        "networkpolicy",
        "-n",
        "oce-system",
        "oce-management-from-supervisors-" + kubernetesHash(id),
      );
    },
    async removeTenantOwnership(index: number) {
      await kubectl(
        "label",
        "namespace",
        tenantField(index, "namespace"),
        "openclaw.dev/namespace-",
      );
    },
  };
}
