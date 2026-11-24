import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxCreateRequest,
  OpenShellSandboxResponse,
  OpenShellServiceResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { reservePort } from "../helpers/available-port.ts";
import {
  completeSandboxRevision,
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type HarnessContext = Parameters<OpenShellSandboxDriver["provisionHarness"]>[0];
type NamespaceContext = Parameters<OpenShellSandboxDriver["ensureNamespace"]>[0];
type Requirements = HarnessContext["requirements"];
type SandboxGatewayMethods = Pick<
  OpenShellGatewayClient,
  "createSandbox" | "getSandbox" | "getService"
>;
type GatewayFixture = Omit<ReturnType<typeof workspaceGatewayClient>, keyof SandboxGatewayMethods> &
  SandboxGatewayMethods;
type StoredSandbox = OpenShellSandboxResponse & { spec: OpenShellSandboxCreateRequest["spec"] };
type Fixtures = {
  chmod: typeof import("node:fs/promises").chmod;
  mkdtemp: typeof import("node:fs/promises").mkdtemp;
  nativeWorkerEntrypoint: string;
  reservedPortArgs: typeof import("../helpers/available-port.ts").reservedPortArgs;
  rm: typeof import("node:fs/promises").rm;
  stat: typeof import("node:fs/promises").stat;
  tmpdir: typeof import("node:os").tmpdir;
  codexRequirements: (revision: Pick<SandboxFixtureRevision, "id">) => Requirements;
  dedicatedRevision: (
    driver: OpenShellSandboxDriver,
    context: NamespaceContext,
    suffix: string,
  ) => SandboxFixtureRevision;
  harnessRuntimeCommand: (program: string) => string[];
  harnessService: (
    sandbox: string,
    name: string,
    url: string | undefined,
  ) => OpenShellServiceResponse | undefined;
  namespaceContext: () => NamespaceContext;
  openShellDriver: (gateway: GatewayFixture) => OpenShellSandboxDriver;
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options: { harnessId: string },
  ) => {
    context: NamespaceContext;
    revision: SandboxFixtureRevision;
    requirements: Requirements & { command: string[] };
  };
  storedSandbox: (
    request: OpenShellSandboxCreateRequest,
    fields?: Partial<OpenShellSandboxResponse>,
  ) => StoredSandbox;
};

export function createSandboxHarnessLifecycleChecks({
  chmod,
  mkdtemp,
  nativeWorkerEntrypoint,
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
}: Fixtures) {
  return {
    async createsPrivateNativeTemporaryState(): Promise<void> {
      const directory = await mkdtemp(join(tmpdir(), "oce-native-temporary-"));
      let statusPort: Awaited<ReturnType<typeof reservePort>> | undefined;
      try {
        const supervisorTemporary = join(directory, "supervisor");
        await mkdir(supervisorTemporary);
        await chmod(supervisorTemporary, 0o777);
        const gateway: GatewayFixture = workspaceGatewayClient();
        let request: OpenShellSandboxCreateRequest | undefined;
        gateway.createSandbox = async (value) => {
          request = value;
          return storedSandbox(value, { serviceUrls: {} });
        };
        const driver = openShellDriver(gateway);
        const fixture = runtimeSandboxFixture(driver, { harnessId: "openclaw" });
        // Execute the actual native startup through its filesystem-initialization phase.
        // Image assets and model execution belong to the separate real-runtime proof.
        const assetBoundary = nativeWorkerEntrypoint.indexOf("initializeRuntimeAssets();");
        assert.ok(assetBoundary > 0);
        fixture.requirements.command = harnessRuntimeCommand(
          `${nativeWorkerEntrypoint.slice(0, assetBoundary)}\nprocess.exit(0);`,
        );
        await driver.provisionHarness({
          ...fixture.context,
          revision: completeWorkspaceRevision(fixture.revision, fixture.requirements),
          requirements: fixture.requirements,
        });
        assert.ok(request);
        const command = request.spec.command;
        assert.ok(
          Array.isArray(command) &&
            command.every((argument: unknown): argument is string => typeof argument === "string"),
        );
        // The startup binds its status port: hold it until then, so no parallel test takes it.
        statusPort = await reservePort({ host: "0.0.0.0" });
        const result = spawnSync(
          process.execPath,
          [...reservedPortArgs(statusPort), ...command.slice(RUNTIME_WRAPPER_COMMAND.length - 1)],
          {
            encoding: "utf8",
            timeout: 5_000,
            env: {
              PATH: process.env.PATH,
              HOME: directory,
              TMPDIR: supervisorTemporary,
              OPENCLAW_NATIVE_INFERENCE_CONFIG: "{}",
              OPENCLAW_NODE_STATE_DIR: join(directory, "state"),
              OPENCLAW_NODE_SETUP_CODE: "controlled-filesystem-phase",
              OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
              OPENCLAW_NATIVE_WORKER_CAPACITY: "1",
              OPENCLAW_RUNTIME_STATUS_PORT: String(statusPort.port),
            },
          },
        );
        assert.equal(result.status, 0, result.stderr);
        const temporary = await stat(join(directory, "tmp"));
        assert.ok(process.getuid);
        assert.equal(temporary.uid, process.getuid());
        assert.equal(temporary.mode & 0o7777, 0o700);
        assert.equal((await stat(supervisorTemporary)).mode & 0o7777, 0o777);
      } finally {
        await statusPort?.release();
        await rm(directory, { recursive: true, force: true });
      }
    },
    async restartsExitedHarnessAndAdoptsLegacySandboxes(): Promise<void> {
      // Finding 1029: with no policy OpenShell persists NEVER, and an exited Harness stays down until
      // the Agent is deployed again. A signalled Harness exits 0, so only ALWAYS restarts it.
      const gatewayClient: GatewayFixture = workspaceGatewayClient();
      const sandboxes = new Map<string, StoredSandbox>();
      const creates: OpenShellSandboxCreateRequest[] = [];
      gatewayClient.getSandbox = async ({ name }) => sandboxes.get(name);
      gatewayClient.getService = async (_workspace, sandbox, service) =>
        harnessService(sandbox, service, sandboxes.get(sandbox)?.serviceUrls[""]);
      gatewayClient.createSandbox = async (request) => {
        creates.push(request);
        const sandbox = storedSandbox(request, { annotations: { ...request.annotations } });
        sandboxes.set(request.name, sandbox);
        return sandbox;
      };
      const driver = openShellDriver(gatewayClient);
      const context = namespaceContext();
      const revision = completeSandboxRevision(dedicatedRevision(driver, context, "000000001029"));
      const provision = () =>
        driver.provisionHarness({
          ...context,
          revision,
          requirements: codexRequirements(revision),
        });

      const first = await provision();
      assert.equal(creates.length, 1);
      assert.equal(creates[0]?.spec.restart_policy, "SANDBOX_RESTART_POLICY_ALWAYS");

      // The gateway reports the stored policy by enum name, or by number from an older decoder.
      // A Sandbox stored before the policy existed (NEVER, or unset) is still this revision's own.
      const stored = sandboxes.get(first.resourceName);
      assert.ok(stored);
      for (const policy of [
        "SANDBOX_RESTART_POLICY_ALWAYS",
        3,
        "SANDBOX_RESTART_POLICY_NEVER",
        1,
        "SANDBOX_RESTART_POLICY_UNSPECIFIED",
        0,
        undefined,
      ]) {
        const { restart_policy: _omitted, ...spec } = stored.spec;
        sandboxes.set(first.resourceName, {
          ...stored,
          spec: policy === undefined ? spec : { ...spec, restart_policy: policy },
        });
        assert.deepEqual(
          await provision(),
          first,
          `adopts a Sandbox stored with ${String(policy)}`,
        );
      }
      // OCC never asks for ON_FAILURE, so a Sandbox stored with it is not this revision's.
      for (const policy of ["SANDBOX_RESTART_POLICY_ON_FAILURE", 2]) {
        sandboxes.set(first.resourceName, {
          ...stored,
          spec: { ...stored.spec, restart_policy: policy },
        });
        await assert.rejects(provision(), /without exact AgentRevision ownership and content/);
      }
      assert.equal(creates.length, 1);
    },
  };
}
