import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import type { OpenShellServiceResponse } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { backendFor } from "./sandbox-driver-openshell-fixture.ts";
import { buildSandboxInstallation as sandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import { harnessService, runtimeSandboxFixture } from "./sandbox-driver-startup-orchestration.ts";
import { completeWorkspaceRevision } from "./sandbox-driver-revision-fixture.ts";
import {
  assertManagedSandboxRequest,
  type ManagedSandboxRequest,
  type ManagedSandboxPhase,
} from "./sandbox-driver-managed-startup-rendering-cases.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export function registerManagedStartupNativeReplacementCases(): void {
  test("managed native replacement restores its startup exposure and withdraws it after enrollment", async (t) => {
    const client = workspaceGatewayClient();
    const configuration = sandboxInstallation().drivers.sandbox.configuration;
    configuration.integrationMode = "service";
    configuration.gateway = {};
    configuration.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
    const driver = new ManagedOpenShellSandbox(configuration, {
      id: "openshell-sandbox",
      backend: backendFor(client),
    });
    const {
      context,
      revision: fixtureRevision,
      requirements,
    } = runtimeSandboxFixture(driver, {
      harnessId: "openclaw",
    });
    const revision = completeWorkspaceRevision(fixtureRevision, requirements);
    requirements.workspaceMounts = [];
    requirements.environment.push(
      { name: "APP_SERVER_PORT", value: "8080" },
      { name: "APP_TOKEN_SHA", value: "a".repeat(64) },
      { name: "NODE_COMPILE_CACHE", value: "/home/node/.openclaw-node/.cache/node-compile" },
    );
    const root = await mkdtemp(join(tmpdir(), "oce-native-bootstrap-cache-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // Run the rendered bootstrap with Node's real startup cache enabled. Only
    // container paths are relocated; Gateway responses remain fixture transport.
    const bootstrap = fileURLToPath(
      new URL("../../deploy/runtime/openshell-bootstrap.cjs", import.meta.url),
    );
    const runtimeRoot = await mkdtemp(join(tmpdir(), "oce-native-bootstrap-runtime-"));
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
    let request: ManagedSandboxRequest | undefined;
    const currentRequest = (): ManagedSandboxRequest => {
      assert.ok(request, "The Gateway must have received a Sandbox workload");
      return request;
    };
    const bootstrapLine = (): string => {
      const command = currentRequest().spec.command[RUNTIME_WRAPPER_COMMAND.length];
      assert.ok(command);
      const line = command.split("\n")[0];
      assert.ok(line);
      return line;
    };
    const launchBootstrap = () => {
      // Insert the checkout's bootstrap path last: the checkout can live under /sandbox.
      const program = bootstrapLine()
        .replaceAll("/sandbox", root)
        .replaceAll("/opt/oce/managed/private", runtimeRoot)
        .replaceAll("/opt/oce/runtime/openshell-bootstrap.cjs", bootstrap);
      const cache = currentRequest().spec.environment.NODE_COMPILE_CACHE;
      assert.ok(cache);
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_COMPILE_CACHE: cache.replaceAll("/opt/oce/managed/private", runtimeRoot),
      };
      delete environment.NODE_DISABLE_COMPILE_CACHE;
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          program +
            '\nrequire("node:assert/strict").ok(require("node:module").getCompileCacheDir());',
        ],
        {
          encoding: "utf8",
          env: environment,
        },
      );
      assert.equal(result.status, 0, result.stderr);
    };
    let phase: ManagedSandboxPhase = "SANDBOX_PHASE_READY";
    let service: OpenShellServiceResponse | undefined;
    let exposures = 0;
    let starts = 0;
    let exposureMode:
      "SERVICE_AUTHORIZATION_MODE_STRIP" | "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH" =
      "SERVICE_AUTHORIZATION_MODE_STRIP";
    let loseExposureResponse = false;
    client.createSandbox = async (value) => {
      assertManagedSandboxRequest(value);
      request = value;
      service = harnessService(value.name, "", "http://native.example.test:8080/");
      return storedSandbox(request, { phase });
    };
    client.getSandbox = async () =>
      request === undefined ? undefined : storedSandbox(request, { phase, resourceVersion: "7" });
    client.getService = async () => service;
    client.deleteService = async () => {
      service = undefined;
    };
    client.stopSandbox = async () => {
      phase = "SANDBOX_PHASE_STOPPED";
      return storedSandbox(currentRequest(), { phase });
    };
    client.updateSandbox = async (value) => {
      assertManagedSandboxRequest(value);
      request = value;
      return storedSandbox(value, { phase });
    };
    client.startSandbox = async () => {
      assert.equal(service?.authorizationMode, "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH");
      starts += 1;
      phase = "SANDBOX_PHASE_READY";
      return storedSandbox(currentRequest(), { phase });
    };
    client.exposeService = async (value) => {
      exposures += 1;
      const exposed = harnessService(
        value.sandbox,
        value.service,
        "http://native.example.test:8080/",
      );
      assert.ok(exposed);
      service = {
        ...exposed,
        targetPort: value.targetPort,
        authorizationMode: exposureMode,
      };
      if (loseExposureResponse) {
        throw new Error("Lost exposure acknowledgement");
      }
    };
    await driver.ensureNamespace(context);
    await driver.provisionHarness({
      ...context,
      revision,
      requirements,
      workspaceNodeEnrolled: false,
    });
    // The stock supervisor uses a different UID from the image's node user.
    // Exercise the image permissions without mounting over the runtime home.
    const image = process.env.OCC_TEST_RUNTIME_IMAGE;
    if (image) {
      const { HOME: home, NODE_COMPILE_CACHE: cache } = currentRequest().spec.environment;
      assert.ok(home && cache);
      const line = bootstrapLine();
      await runDocker(
        [
          "run",
          "--rm",
          "--pull=never",
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--user",
          "10001:10001",
          "--tmpfs",
          "/sandbox:mode=1777",
          "--env",
          `NODE_COMPILE_CACHE=${cache}`,
          "--entrypoint",
          "node",
          image,
          "-e",
          line +
            '\nconst home = require("node:fs").statSync(process.argv[1]);' +
            "if (home.uid !== process.getuid() || (home.mode & 0o777) !== 0o700) process.exit(1);",
          home,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
    }
    launchBootstrap();
    await writeFile(join(runtimeRoot, "home/workspace/USER.md"), "retained native workspace");
    // Enrollment removes the first revision's diagnostic route while it runs.
    await driver.withdrawHarnessExposure({ ...context, revision, workspaceNodeEnrolled: true });
    assert.equal(service, undefined);
    await driver.cleanup({ ...context, revision });
    const successor = { ...revision, id: "rev_00000000-0000-4000-8000-000000000004" };
    const next = {
      ...context,
      revision: successor,
      requirements: { ...requirements, labels: { "openclaw.dev/revision": successor.id } },
      workspaceNodeEnrolled: false,
    };
    // An acknowledgement alone is insufficient: refuse a route that strips the
    // bearer token and keep the replacement stopped. Do not overwrite that route.
    await assert.rejects(driver.provisionHarness(next), /no exact authenticated Harness service/);
    await assert.rejects(driver.provisionHarness(next), /no exact authenticated Harness service/);
    assert.equal(starts, 0);
    assert.equal(exposures, 1);
    service = undefined;
    exposureMode = "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH";
    loseExposureResponse = true;
    await assert.rejects(driver.provisionHarness(next), /Lost exposure acknowledgement/);
    assert.equal(starts, 0);
    // The server persisted the route before the response was lost. Adoption must
    // recover without issuing another exposure mutation.
    loseExposureResponse = false;
    await driver.provisionHarness(next);
    assert.equal(starts, 1);
    await rm(runtimeRoot, { recursive: true });
    launchBootstrap();
    assert.equal(
      await readFile(join(runtimeRoot, "home/workspace/USER.md"), "utf8"),
      "retained native workspace",
    );
    assert.equal(exposures, 2);
    const restoredService = (): OpenShellServiceResponse => {
      assert.ok(service);
      return service;
    };
    assert.equal(restoredService().targetPort, 8080);
    // Reconciliation must adopt the restored route, then leave it absent once
    // this revision enrolls. Agent code must not inherit an unused inbound route.
    await driver.provisionHarness(next);
    assert.equal(exposures, 2);
    await driver.provisionHarness({ ...next, workspaceNodeEnrolled: true });
    await driver.provisionHarness({ ...next, workspaceNodeEnrolled: true });
    assert.equal(service, undefined);
    assert.equal(exposures, 2);
  });
}
