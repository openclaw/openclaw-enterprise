import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import test from "node:test";
import pg from "pg";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import type {
  AgentRevision,
  ConfigurationValidationError,
  OpenShellBackendConfiguration,
} from "../../packages/contracts/src/index.ts";
import { ConfigurationHarnessError } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { reservedPortArgs } from "../helpers/available-port.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { createSandboxCodexHarnessChecks } from "./sandbox-driver-codex-harness-cases.ts";
import { createCredentialWithdrawalChecks } from "./sandbox-driver-credential-withdrawal-cases.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { createSandboxHarnessLifecycleChecks } from "./sandbox-driver-harness-lifecycle-cases.ts";
import { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import {
  verifyDedicatedHarnessSelection,
  verifyRejectedCredentialGatewayExecutable,
  verifySharedBackendComposition,
} from "./sandbox-driver-startup-composition-cases.ts";
import { createSandboxStartupGuardChecks } from "./sandbox-driver-startup-guard-cases.ts";
import {
  buildSandboxInstallation as sandboxInstallation,
  rejectsAtStartup,
} from "./sandbox-driver-startup-installation-fixture.ts";
import {
  codexRequirements,
  dedicatedRevision,
  harnessRuntimeCommand,
  harnessService,
  kubernetesObjectClient,
  namespaceContext,
  ownedWorkspace,
  runtimeSandboxFixture,
  sandboxRecord,
  structuralRefusal,
} from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Installation = ReturnType<typeof sandboxInstallation>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type HarnessOptions = {
  gateway: Mutable<OpenShellSandboxDriverOptions["gateway"]>;
  kubernetes: Mutable<OpenShellSandboxDriverOptions["kubernetes"]>;
};
type RefusalDetail = ConfigurationValidationError["error"]["details"][number];
type Harness = AgentRevision["harness"];
type CredentialGatewayFactory = Parameters<
  typeof createCredentialWithdrawalChecks
>[0]["credentialGatewayOverProviders"];

function dedicatedHarness(id: string, mode: Harness["mode"] = "dedicated"): Harness {
  return { id, version: "1.0.0", mode, overrides: {}, configuration: {} };
}

function firstBackend(configuration: Installation) {
  const [backend] = configuration.backend;
  assert.ok(backend);
  return backend;
}

export function sandboxOf(configuration: Installation) {
  return configuration.drivers.sandbox.configuration;
}

export const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);

// The gateway refuses these in CreateSandbox, which runs only after a dedicated deploy has
// stopped its predecessors, so startup applies the same rules (findings 2331-2333).
function invalidValue(path: string, message: string): RefusalDetail[] {
  return [{ path, code: "INVALID_VALUE", message }];
}

export function credentialWithdrawalChecks(
  credentialGatewayOverProviders: CredentialGatewayFactory,
) {
  return createCredentialWithdrawalChecks({
    OpenShellCredentialRefreshDriver,
    conformanceKubernetesOptions,
    credentialGatewayOverProviders,
    kubernetesObjectClient,
    openShellDriver,
    rejectsAtStartup,
    runtimeSandboxFixture,
    sandboxInstallation,
    structuralRefusal,
  });
}
export function sandboxStartupGuardChecks() {
  return createSandboxStartupGuardChecks({
    conformanceKubernetesOptions,
    controllerRequire,
    invalidValue,
    kubernetesObjectClient,
    namespaceContext,
    openShellDriver,
    ownedWorkspace,
    rejectsAtStartup,
    runtimeSandboxFixture,
    sandboxOf,
    sandboxRecord,
  });
}

export const harnessLifecycleChecks = createSandboxHarnessLifecycleChecks({
  chmod,
  mkdtemp,
  nativeWorkerEntrypoint: NATIVE_WORKER_ENTRYPOINT,
  reservedPortArgs,
  rm,
  stat,
  tmpdir,
  codexRequirements,
  dedicatedRevision,
  harnessRuntimeCommand,
  harnessService,
  namespaceContext,
  openShellDriver,
  runtimeSandboxFixture,
  storedSandbox,
});
export const codexHarnessChecks = createSandboxCodexHarnessChecks({
  agentRuntimeEntrypoint: AGENT_RUNTIME_ENTRYPOINT,
  codexRequirements,
  conformanceKubernetesOptions,
  dedicatedRevision,
  harnessRuntimeCommand,
  namespaceContext,
  runtimeSandboxFixture,
  workspaceGatewayClient,
});

export function registerSandboxDriverStartupWiringCases(
  credentialGatewayOverProviders: CredentialGatewayFactory,
) {
  test("startup constructs the bundled OpenShell SandboxDriver before constructing Kubernetes Compute", async (t) => {
    const createdDriver = await loadInstallationFile(t, sandboxInstallation());

    assert.ok(createdDriver?.installation.drivers.sandbox);
    assert.equal(createdDriver.installation.drivers.sandbox.id, "openshell-sandbox");
    assert.equal(createdDriver.installation.drivers.sandbox.implementation, "openshell");
    assert.ok(createdDriver.sandboxDriver instanceof OpenShellSandboxDriver);
    assert.equal(createdDriver.sandboxDriver.id, "openshell-sandbox");
    assert.deepEqual(createdDriver.sandboxDriver.facets, ["networking", "filesystem", "process"]);

    const pool = new pg.Pool({ connectionString: "postgresql://127.0.0.1:1/occ" });
    t.after(async () => pool.end());
    assert.doesNotThrow(() =>
      createControllerWorker({ pool, mode: "production", drivers: createdDriver, emit: () => {} }),
    );
  });

  test("startup composes both OpenShell members from one Backend", async (t) => {
    await verifySharedBackendComposition(t);
  });

  test("startup pairs the Credential Refresh Driver with its gateway on one OpenShell Backend", async (t) => {
    await credentialWithdrawalChecks(
      credentialGatewayOverProviders,
    ).pairsCredentialRefreshWithGateway(t);
  });

  test("startup identifies the rejected Credential Gateway executable", (t) =>
    verifyRejectedCredentialGatewayExecutable(t));

  test("startup rejects an OpenShell Backend whose members are not both selected", async (t) => {
    await rejectsAtStartup(
      t,
      (c) => Reflect.deleteProperty(c.drivers, "credential_gateway"),
      /drivers\.credential_gateway must match the selected drivers\.credential_gateway\.id/,
    );
    await rejectsAtStartup(
      t,
      (c) => (firstBackend(c).drivers.sandbox = "another-sandbox"),
      /drivers\.sandbox must match the selected bundled OpenShell drivers\.sandbox\.id/,
    );
    // Connection settings belong to the Backend; the Sandbox rejects them instead of ignoring them.
    await rejectsAtStartup(
      t,
      (c) => Object.assign(sandboxOf(c).gateway, { endpoint: "http://127.0.0.1:1" }),
      structuralRefusal("/gateway", "additionalProperties", "UNKNOWN_FIELD"),
    );
  });

  test("startup requires protected OpenShell transport or an explicit NetworkPolicy boundary", async (t) => {
    const installation = sandboxInstallation();
    const backend = firstBackend(installation);
    const load = (configuration: unknown) =>
      loadInstallationFile(t, { ...installation, backend: [{ ...backend, configuration }] });
    const serviceTransport: Mutable<OpenShellBackendConfiguration> = { ...backend.configuration };
    // Credential registration sends resolved values, so plain or unauthenticated transport
    // must be declared rather than accepted by default.
    const undeclared = { ...serviceTransport };
    delete undeclared.insecureTransport;
    await assert.rejects(
      load(undeclared),
      /requires TLS with bearerTokenFile or mtls authentication, or insecureTransport: network-policy/,
    );
    // TLS alone is not enough; the gateway must also authenticate OCC.
    const tlsOnly = { endpoint: "https://openshell-gateway.openshell.svc:8080" };
    await assert.rejects(load(tlsOnly), /requires TLS with bearerTokenFile or mtls authentication/);

    const protectedTransport: Mutable<OpenShellBackendConfiguration> = {
      ...tlsOnly,
      auth: { mode: "bearerTokenFile", path: "/etc/openclaw/openshell/token" },
    };
    await load(protectedTransport);

    // Export credentials use a separate operator identity; they cannot make an
    // otherwise unauthenticated ordinary RPC connection count as protected.
    const operatorTls = {
      certificatePath: "/etc/openclaw/openshell/operator.crt",
      privateKeyPath: "/etc/openclaw/openshell/operator.key",
    };
    // URI schemes are case-insensitive; both gateway transports parse the protocol before
    // choosing TLS. Startup must admit the same protected connection, including operator TLS.
    for (const scheme of ["https", "HTTPS", "hTtPs"]) {
      protectedTransport.endpoint = `${scheme}://openshell-gateway.openshell.svc:8080`;
      await load(protectedTransport);
      await load({ ...protectedTransport, operatorTls });
    }
    await assert.rejects(
      load({ ...tlsOnly, operatorTls }),
      /requires TLS with bearerTokenFile or mtls authentication/,
    );

    for (const invalid of [
      { certificatePath: operatorTls.certificatePath },
      { ...operatorTls, privateKeyPath: "operator.key" },
    ]) {
      await assert.rejects(
        load({ ...protectedTransport, operatorTls: invalid }),
        /operatorTls requires absolute/,
      );
    }
    await assert.rejects(
      load({ ...serviceTransport, operatorTls }),
      /operatorTls requires a direct HTTPS/,
    );

    // The declaration is only for unprotected transport, so it cannot mask a protected setup.
    await assert.rejects(
      load({ ...protectedTransport, operatorTls, insecureTransport: "network-policy" }),
      /insecureTransport is only for unprotected/,
    );

    const mtls = {
      ...tlsOnly,
      auth: {
        mode: "mtls",
        certificatePath: "/etc/openclaw/openshell/tls.crt",
        privateKeyPath: "/etc/openclaw/openshell/tls.key",
      },
    } satisfies OpenShellBackendConfiguration;
    await load(mtls);
    for (const change of [
      { privateKeyPath: undefined },
      { certificatePath: "relative.crt" },
      { path: "/unexpected" },
    ]) {
      await assert.rejects(
        load({ ...mtls, auth: { ...mtls.auth, ...change } }),
        /configuration.auth/,
      );
    }
    await assert.rejects(
      load({
        ...mtls,
        endpoint: "http://openshell-gateway.openshell.svc:8080",
        insecureTransport: "network-policy",
      }),
      /mtls requires HTTPS/,
    );

    // Every gateway call's deadline stays within the registration fence.
    await assert.rejects(
      load({ ...serviceTransport, requestTimeoutMs: 60_000 }),
      /requestTimeoutMs must be between 1000 and 30000 ms/,
    );
  });

  test("OpenShell configures only the selected dedicated Harness runtime", () => {
    const driver = openShellDriver(workspaceGatewayClient());
    verifyDedicatedHarnessSelection({
      configureAgent: (configuration, id, mode) =>
        driver.configureAgent(configuration, dedicatedHarness(id, mode)),
    });
  });

  // Native OpenClaw's private workspace preparation needs userNamespaces: false and at most one
  // operator-mode ServiceAccount, and it runs only after a dedicated deploy has stopped its
  // predecessors. Agent save and deploy admission call configureAgent, so they refuse those
  // settings first (findings 2334, 2346).
  test("OpenShell refuses dedicated OpenClaw on settings its workspace preparation refuses", () => {
    const configuration = { agents: { defaults: { model: "openai/gpt-5" } } };
    const userNamespaces =
      "Dedicated OpenClaw needs kubernetes.userNamespaces: false in the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to set it.";
    const accounts =
      "Dedicated OpenClaw needs at most one ServiceAccount in gateway.operatorWorkspaceResources of the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to remove the others.";
    const serviceAccount = (name: string) => ({
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name },
    });
    const role = {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: "r" },
    };
    for (const [settings, message] of [
      [(options) => delete options.kubernetes.userNamespaces, userNamespaces],
      [(options) => (options.kubernetes.userNamespaces = true), userNamespaces],
      [
        (options) =>
          (options.gateway.operatorWorkspaceResources = [serviceAccount("a"), serviceAccount("b")]),
        accounts,
      ],
      // Control: one ServiceAccount beside other resources still prepares.
      [(options) => (options.gateway.operatorWorkspaceResources = [serviceAccount("a"), role])],
    ] satisfies [settings: (options: HarnessOptions) => void, message?: string][]) {
      const options = sandboxOf(sandboxInstallation());
      settings(options);
      const driver = openShellDriver(workspaceGatewayClient(), options);
      assert.deepEqual(driver.supportsHarnessExecutionMode.openclaw, {
        embedded: { supported: false },
        dedicated:
          message === undefined ? { supported: true } : { supported: false, reason: message },
      });
      assert.throws(() => {
        Object.assign(driver.supportsHarnessExecutionMode.openclaw.dedicated, { supported: false });
      }, TypeError);
      // A caller's later mutation cannot change the constructed Driver's support decision.
      options.kubernetes.userNamespaces = !options.kubernetes.userNamespaces;
      if (message === undefined) {
        assert.ok(driver.configureAgent(configuration, dedicatedHarness("openclaw")));
      } else {
        assert.throws(
          () => driver.configureAgent(configuration, dedicatedHarness("openclaw")),
          (error) => {
            // workspace-setup-api.test.mjs proves the API's 400 with these messages.
            assert.ok(error instanceof ConfigurationHarnessError);
            assert.equal(error.message, message);
            return true;
          },
        );
      }
      // Codex never runs the preparation, so it is still admitted.
      const configured = driver.configureAgent(configuration, dedicatedHarness("codex"));
      assert.ok(asRecord(asRecord(configured.plugins)?.entries)?.codex);
    }
  });
}
