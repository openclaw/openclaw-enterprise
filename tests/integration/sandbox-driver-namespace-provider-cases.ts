import assert from "node:assert/strict";
import test from "node:test";
import type { OpenShellSandboxDriverOptions } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { callCount } from "./sandbox-driver-gateway-response-fixture.ts";
import { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import { verifyOperatorWorkspaceChart } from "./sandbox-driver-operator-chart-case.ts";
import { verifyManagedNamespaceRejectsMutation } from "./sandbox-driver-startup-composition-cases.ts";
import type { createSandboxStartupGuardChecks } from "./sandbox-driver-startup-guard-cases.ts";
import { buildSandboxInstallation as sandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import {
  kubernetesObjectClient,
  namespaceContext,
  ownedWorkspace,
  type ResourceReference,
} from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type StartupGuards = Pick<
  ReturnType<typeof createSandboxStartupGuardChecks>,
  "refusesControllerIdentity" | "refusesNonObjectNetworkPolicyIngress"
>;

export function registerSandboxDriverNamespaceProviderCases({
  sandboxStartupGuardChecks,
}: {
  sandboxStartupGuardChecks: () => StartupGuards;
}): void {
  test("OpenShell Namespace lifecycle creates, adopts, and deletes its exact operator Workspace", async () => {
    const gatewayClient = workspaceGatewayClient();
    const driver = openShellDriver(gatewayClient);
    const context = namespaceContext();

    // A retry must adopt the same owned Workspace instead of creating a second boundary.
    await driver.ensureNamespace(context);
    await driver.ensureNamespace(context);
    assert.deepEqual(
      gatewayClient.workspaces.get(context.namespace.name),
      ownedWorkspace(context.namespace.name, context.namespace.id),
    );
    assert.equal(callCount(gatewayClient, "createWorkspace"), 1);

    // A lost delete response can leave an owned Workspace terminating; retry must converge.
    const workspace = gatewayClient.workspaces.get(context.namespace.name);
    assert.ok(workspace);
    workspace.phase = "WORKSPACE_PHASE_TERMINATING";
    await driver.cleanup(context);
    assert.equal(gatewayClient.workspaces.has(context.namespace.name), false);
  });

  test("OpenShell operator mode owns workspace chart resources around the Workspace lifecycle", () =>
    verifyOperatorWorkspaceChart({ openShellDriver, namespaceContext, kubernetesObjectClient }));

  test("OpenShell managed mode fails before mutating Kubernetes or the Gateway", async () => {
    await verifyManagedNamespaceRejectsMutation({
      sandboxInstallation,
      openShellDriver,
      namespaceContext,
      kubernetesObjectClient,
    });
  });

  // The wait slept a whole poll interval past its deadline: timeoutMs 30000 with pollIntervalMs
  // 600000 checked again only after ten minutes (finding 2324).
  test("OpenShell gateway readiness checks once more at its deadline, not a poll interval later", async () => {
    const base = sandboxInstallation().drivers.sandbox.configuration;
    const configuration = {
      ...base,
      gateway: {
        ...base.gateway,
        readiness: {
          serviceName: "openshell-gateway",
          podSelector: { "app.kubernetes.io/name": "openshell" },
          // The first check must finish before the deadline, or the wait throws after one check.
          // A 1 s budget gives CPU-starved runners room within the 10 s abort.
          timeoutMs: 1_000,
          pollIntervalMs: 600_000,
        },
      },
    } satisfies OpenShellSandboxDriverOptions;
    const gatewayClient = workspaceGatewayClient();
    const driver = openShellDriver(gatewayClient, configuration);
    const context = namespaceContext();
    let podLists = 0;
    context.kubernetes = Object.assign(kubernetesObjectClient([]), {
      async read(resource: ResourceReference) {
        return resource;
      },
      async list() {
        podLists += 1;
        return { items: [{ status: { conditions: [{ type: "Ready", status: "False" }] } }] };
      },
    });
    // A wait that sleeps the whole poll interval is aborted here instead of after ten minutes.
    context.signal = AbortSignal.timeout(10_000);

    await assert.rejects(driver.ensureNamespace(context), /OpenShell gateway Pod is not ready\./);
    // A timer can wake a millisecond before Date.now() reaches the deadline, adding a check.
    assert.ok(podLists >= 2, "one check at the start and another at the deadline");
    assert.deepEqual(gatewayClient.calls, []);
  });

  test("OpenShell Namespace cleanup refuses a same-name foreign Workspace", async () => {
    const context = namespaceContext();
    const gatewayClient = workspaceGatewayClient([
      ownedWorkspace(context.namespace.name, "ns_foreign"),
    ]);

    await assert.rejects(
      openShellDriver(gatewayClient).cleanup(context),
      /without exact OCC Namespace ownership/,
    );
    assert.equal(gatewayClient.workspaces.has(context.namespace.name), true);
    assert.equal(callCount(gatewayClient, "deleteWorkspace"), 0);
  });

  // OpenShell answers a controller identity it cannot authenticate (UNAUTHENTICATED) or that lacks
  // a permission (PERMISSION_DENIED) with a gRPC status the gateway client passes through raw. Read
  // as an HTTP status, it was retryable and logged "HTTP status 7" (finding 1390): the Namespace
  // work spent its attempts on a refusal only an operator can fix. The OpenShell Sandbox Driver now
  // names the refusal, and Compute fails the Namespace step at once with that reason.
  test("OpenShell Namespace steps fail at once when OpenShell refuses the controller identity", async () => {
    await sandboxStartupGuardChecks().refusesControllerIdentity();
  });

  // A non-object ingress rule cannot be mapped for the client; startup names the field instead of
  // the apply failing later.
  test("startup refuses NetworkPolicy ingress rules that are not objects", async (t) => {
    await sandboxStartupGuardChecks().refusesNonObjectNetworkPolicyIngress(t);
  });
}
