import assert from "node:assert/strict";
import test from "node:test";

import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import type {
  OpenShellSandboxExecRequest,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { requireConfiguration } from "../../packages/contracts/src/index.ts";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { SandboxWorkspaceSetupRefusedError } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createOpenShellInstallationConfiguration } from "../helpers/openshell-kubernetes-real.mjs";
import { verifyDedicatedCodexProviderFiles } from "./sandbox-driver-dedicated-codex-provider-cases.ts";
import { callCount, storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { verifyDedicatedCodexStartup } from "./sandbox-driver-native-harness-assertions.ts";
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

function openShellRuntimePolicy(): OpenShellSandboxDriverOptions["policy"] {
  const installation = createOpenShellInstallationConfiguration({
    authentication: {},
    platformNamespace: "openclaw-system",
    gatewayImage: "gateway-fixture",
    codexImage: "codex-fixture",
    cluster: { name: "fixture" },
  });
  // The live fixture augments the base Installation after constructing it.
  const sandbox = asRecord(asRecord(installation.drivers)?.sandbox);
  return requireConfiguration(OpenShellSandboxDriver, sandbox?.configuration).policy;
}

export function registerDedicatedCodexProviderCase(): void {
  test("OpenShell provisions dedicated Codex with bearer passthrough and provider files", async (t) => {
    const {
      driver,
      gatewayClient,
      credentialGateway,
      sourceContext,
      relay,
      context,
      revision,
      runtimeManifest,
      codexConfig,
      nodeSetup,
      routeHost,
      spec,
      environment,
    } = await verifyDedicatedCodexStartup({
      t,
      // The live fixture's incomplete filesystem policy makes OpenShell enrich it during startup.
      sandboxPolicy: openShellRuntimePolicy(),
      runtimeSandboxFixture,
    });
    const providers = spec.providers;
    assert.ok(Array.isArray(providers));
    const providerNames: readonly unknown[] = providers;
    assert.ok(providerNames.every((name): name is string => typeof name === "string"));
    assert.ok(providerNames.includes(openShellProviderName(sourceContext.source.id)));
    const runtimeProvider = providerNames.find((name) => name.startsWith("oce-runtime-"));
    assert.ok(runtimeProvider);
    verifyDedicatedCodexProviderFiles({
      gatewayClient,
      runtimeProvider,
      runtimeManifest,
      codexConfig,
      nodeSetup,
    });
    // A wss setup URL keeps TLS end to end to the Gateway route the node's CA pins;
    // OpenShell must not terminate it, so the rule binds only binary, host, and port.
    const networkPolicies = asRecord(asRecord(spec.policy)?.network_policies);
    const nodePolicy = asRecord(networkPolicies?.["workspace-node-enrollment"]);
    assert.ok(nodePolicy);
    assert.deepEqual(nodePolicy, {
      name: "workspace-node-enrollment",
      binaries: [{ path: "/usr/local/bin/node" }],
      endpoints: [
        {
          host: routeHost,
          ports: [443],
          tls: "NETWORK_TLS_MODE_SKIP",
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        },
      ],
    });

    // Each turn the Gateway writes a native hook credential through Codex into the directory
    // Compute renders, which the Harness entrypoint creates under its HOME. Hook commands
    // then call the Gateway route on the host and port the node rule above admits.
    assert.equal(relay.credentialDirectory, `${environment.HOME}/.oce-native-hooks`);
    const callback = new URL(relay.url);
    assert.ok(Array.isArray(nodePolicy.endpoints));
    const nodeEndpoint = asRecord(nodePolicy.endpoints[0]);
    assert.ok(nodeEndpoint);
    assert.equal(callback.protocol, "https:");
    assert.equal(callback.hostname, nodeEndpoint.host);
    assert.equal(
      callback.pathname,
      `/namespaces/${revision.namespaceId}/agents/${revision.agentId}/node/__openclaw__/native-hook`,
    );
    assert.deepEqual([Number(callback.port || 443)], nodeEndpoint.ports);

    await driver.cleanup({ ...context, revision });
    assert.equal(gatewayClient.providers.has(runtimeProvider), false);
    assert.equal(gatewayClient.profiles.has("oce-codex-runtime"), true);

    await credentialGateway.removeSource(sourceContext);
    await driver.cleanup(context);
    assert.equal(gatewayClient.profiles.has("oce-codex-runtime"), false);
  });
}

export function registerInitialWorkspaceCases(): void {
  for (const harnessId of ["codex", "openclaw"]) {
    test(`OpenShell delivers ${harnessId} initial workspace files privately after supervisor readiness`, async (t) => {
      const gatewayClient = workspaceGatewayClient();
      const driver = openShellDriver(gatewayClient);
      const {
        context,
        revision: fixtureRevision,
        requirements,
        prepared,
      } = runtimeSandboxFixture(driver, { harnessId });
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
      assert.equal(prepared.length, harnessId === "openclaw" ? 1 : 0);
      assert.ok(sandbox, "provisioning created the Sandbox before readiness");
      sandbox = { ...sandbox, phase: "SANDBOX_PHASE_READY" };
      await provision();
      const execution = executions[0];
      assert.ok(execution, "the ready Sandbox receives its initializer request");
      assert.deepEqual(JSON.parse(execution.stdin), setup);
      assert.equal(execution.environment.OPENCLAW_WORKSPACE_DIR, "/sandbox/enterprise");
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
