import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import { backendFor } from "./sandbox-driver-openshell-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type {
  OpenShellSandboxExecRequest,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { WORKSPACE_DEFAULTS, WORKSPACE_DEFAULTS_ID } from "../../packages/contracts/src/index.ts";
import { SandboxWorkspaceSetupRefusedError } from "../../packages/occ/src/index.ts";
import { callCount, storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import { completeWorkspaceRevision } from "./sandbox-driver-revision-fixture.ts";
import {
  verifyForeignSandboxAnnotations,
  verifyRevisionProviderRetention,
} from "./sandbox-driver-revision-observation-cases.ts";
import { verifyWorkspaceWrapperDiagnostics } from "./sandbox-driver-startup-composition-cases.ts";
import { harnessService, runtimeSandboxFixture } from "./sandbox-driver-startup-orchestration.ts";
import { workspaceNodeSetupSecret } from "./sandbox-driver-workspace-node-setup-fixture.ts";
import { runNativeWorkspaceSetupCase } from "./sandbox-driver-workspace-setup-cases.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export function registerInitialWorkspaceCases(): void {
  for (const [harnessId, integrationMode] of [
    ["codex", "legacy"],
    ["openclaw", "legacy"],
    ["codex", "service"],
    ["openclaw", "service"],
  ] as const) {
    test(`OpenShell ${integrationMode} delivers ${harnessId} initial workspace files privately after supervisor readiness`, async (t) => {
      const gatewayClient = workspaceGatewayClient();
      const base = buildSandboxInstallation().drivers.sandbox.configuration;
      const managed = integrationMode === "service";
      const { userNamespaces: _userNamespaces, ...kubernetes } = base.kubernetes;
      const configuration: OpenShellSandboxDriverOptions = managed
        ? {
            ...base,
            integrationMode,
            gateway: {},
            kubernetes: {
              ...kubernetes,
              sandboxDataMount: {
                ...kubernetes.sandboxDataMount,
                mountPath: "/sandbox/oce/workspace",
              },
            },
          }
        : base;
      const driver = managed
        ? new ManagedOpenShellSandbox(configuration, {
            id: "openshell-sandbox",
            implementation: "openshell",
            backend: backendFor(gatewayClient),
          })
        : openShellDriver(gatewayClient, configuration);
      const {
        context,
        revision: fixtureRevision,
        requirements,
        prepared,
      } = runtimeSandboxFixture(driver, { harnessId });
      if (managed) {
        requirements.workspaceMounts = [];
      }
      const revision = completeWorkspaceRevision(fixtureRevision, requirements);
      const setup = {
        id: "initial-workspace",
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        defaultsId: WORKSPACE_DEFAULTS_ID,
        completed: false,
        files: { ...WORKSPACE_DEFAULTS, "AGENTS.md": "Private initial Agent instructions\n" },
      };
      requirements.workspaceSetup = {
        id: setup.id,
        defaultsId: setup.defaultsId,
        secretKeyRef: { name: "workspace-setup", key: "setup.json" },
      };
      const readNodeSecret = context.kubernetes.read;
      const setupData = { "setup.json": Buffer.from(JSON.stringify(setup)).toString("base64") };
      let foreign = false;
      context.kubernetes.read = async (request) =>
        request.metadata.name !== "workspace-setup"
          ? readNodeSecret(request)
          : workspaceNodeSetupSecret(
              request.metadata,
              revision.namespaceId,
              foreign ? "another-agent" : revision.agentId,
              setupData,
            );
      let sandbox: OpenShellSandboxResponse | undefined;
      gatewayClient.createSandbox = async (request) => {
        sandbox = storedSandbox(structuredClone(request), {
          phase: "SANDBOX_PHASE_PROVISIONING",
          serviceUrls: harnessId === "codex" ? { "": "http://codex.example.test" } : {},
        });
        return sandbox;
      };
      gatewayClient.getSandbox = async () => sandbox;
      gatewayClient.getService = async (_workspace, name, service) =>
        harnessService(name, service, "http://codex.example.test");
      const executions: OpenShellSandboxExecRequest[] = [];
      let exitCode = 0;
      let executionError: (Error & { grpcStatus: number | string }) | undefined;
      gatewayClient.execSandbox = async (request) => {
        executions.push(request);
        if (executionError !== undefined) {
          throw executionError;
        }
        return exitCode;
      };
      const provision = () => driver.provisionHarness({ ...context, revision, requirements });

      await provision();
      assert.equal(executions.length, 0, "private initialization waits for supervisor readiness");
      assert.equal(prepared.length, harnessId === "openclaw" && !managed ? 1 : 0);
      assert.ok(sandbox, "provisioning created the Sandbox before readiness");
      sandbox = { ...sandbox, phase: "SANDBOX_PHASE_READY" };
      await provision();
      const execution = executions[0];
      assert.ok(execution, "the ready Sandbox receives its initializer request");
      assert.deepEqual(JSON.parse(execution.stdin), setup);
      assert.equal(
        execution.environment.OPENCLAW_WORKSPACE_DIR,
        managed ? "/sandbox/oce/workspace" : "/sandbox/enterprise",
      );
      const home = managed ? "/opt/oce/managed/private/home" : "/sandbox/.openclaw-runtime/home";
      assert.equal(execution.environment.HOME, home);
      assert.equal(execution.environment.OPENCLAW_STATE_DIR, `${home}/.openclaw`);
      assert.equal(execution.environment.OPENCLAW_GATEWAY_REQUIRE_NAMESPACE_PROOF, "1");
      setup.completed = true;
      setupData["setup.json"] = Buffer.from(JSON.stringify(setup)).toString("base64");
      await provision();
      assert.equal(JSON.parse(executions.at(-1)!.stdin).completed, true);
      setup.completed = false;
      setupData["setup.json"] = Buffer.from(JSON.stringify(setup)).toString("base64");
      assert.equal(JSON.stringify(execution.command).includes(setup.files["AGENTS.md"]), false);
      assert.equal(JSON.stringify(sandbox).includes(setup.files["AGENTS.md"]), false);
      assert.equal(
        JSON.stringify([...gatewayClient.providers.values()]).includes(setup.files["AGENTS.md"]),
        false,
      );

      // Failed initialization and foreign Secret ownership must never report successful delivery.
      exitCode = 1;
      await assert.rejects(provision(), {
        message: "OpenShell workspace initialization failed (initializer exit 1).",
      });
      for (const { status, stage } of [
        { status: 3, stage: "native setup failed" },
        { status: 4, stage: "native setup timed out" },
      ]) {
        exitCode = status;
        await assert.rejects(provision(), {
          message: `OpenShell workspace initialization failed (${stage}; initializer exit ${status}).`,
        });
      }
      // Only the protocol's numeric status is public; error text can contain private files.
      executionError = Object.assign(new Error("private native output"), { grpcStatus: 14 });
      await assert.rejects(provision(), {
        message: "OpenShell workspace initialization failed (gRPC status 14).",
      });
      executionError.grpcStatus = "private native output";
      await assert.rejects(provision(), {
        message: "OpenShell workspace initialization failed.",
      });
      executionError = undefined;
      // A refusal (the runner's exit status 2) repeats on every retry, so Compute fails the
      // deployment at once with WORKSPACE_SETUP_REFUSED (finding 1708).
      exitCode = 2;
      await assert.rejects(provision(), (error) => {
        assert.ok(error instanceof SandboxWorkspaceSetupRefusedError, String(error));
        assert.equal(error.code, "WORKSPACE_SETUP_REFUSED");
        assert.equal(error.message, "OpenShell workspace initialization refused.");
        return true;
      });
      foreign = true;
      const before = executions.length;
      await assert.rejects(provision(), /workspace initialization failed/);
      assert.equal(executions.length, before);

      await t.test("setup wrapper preserves initializer diagnostics", async (t) => {
        await verifyWorkspaceWrapperDiagnostics({ t, execution, setup });
      });

      if (harnessId === "codex") {
        await runNativeWorkspaceSetupCase(t, execution, setup);
      }
    });
  }
}
function prepareRevisionObservationProvision(driver: OpenShellSandboxDriver) {
  const { context, revision: fixtureRevision, requirements } = runtimeSandboxFixture(driver);
  const revision = completeWorkspaceRevision(fixtureRevision, requirements);
  return () => driver.provisionHarness({ ...context, revision, requirements });
}

export function registerRevisionProviderRetentionCase(): void {
  test("OpenShell retains the revision provider when Sandbox creation has an unknown outcome", async () => {
    await verifyRevisionProviderRetention({
      openShellDriver,
      prepareProvision: prepareRevisionObservationProvision,
      storedSandbox,
      callCount,
    });
  });
}

export function registerForeignSandboxAnnotationsCase(): void {
  test("OpenShell rejects unexpected annotations on an existing Sandbox", async () => {
    await verifyForeignSandboxAnnotations({
      openShellDriver,
      prepareProvision: prepareRevisionObservationProvision,
    });
  });
}
