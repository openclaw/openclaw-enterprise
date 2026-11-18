import assert from "node:assert/strict";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxCreateRequest,
  OpenShellSandboxResponse,
  OpenShellServiceResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { HarnessWorkloadRequirements } from "../../packages/contracts/src/index.ts";
import {
  DependencyUnavailableError,
  SandboxGatewayUnauthorizedError,
  SandboxRevisionUnsupportedError,
} from "../../packages/occ/src/index.ts";
import {
  completeWorkspaceRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type ExposureGatewayMethods = Pick<
  OpenShellGatewayClient,
  "createSandbox" | "getSandbox" | "getService"
>;
type ExposureGateway = Omit<
  ReturnType<typeof workspaceGatewayClient>,
  keyof ExposureGatewayMethods
> &
  ExposureGatewayMethods & { deleteService?: OpenShellGatewayClient["deleteService"] };
type NamespaceContext = Parameters<OpenShellSandboxDriver["ensureNamespace"]>[0];
type ExposureDependencies = {
  openShellDriver: (gatewayClient: ExposureGateway) => OpenShellSandboxDriver;
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options: { harnessId: "openclaw" },
  ) => {
    context: NamespaceContext;
    revision: SandboxFixtureRevision;
    requirements: HarnessWorkloadRequirements;
  };
  getStoredSandbox: () => OpenShellSandboxResponse | undefined;
  setStoredSandbox: (sandbox: OpenShellSandboxResponse) => void;
  getCreatedServiceUrl: () => string;
  getExposedService: () => OpenShellServiceResponse | undefined;
};

export async function prepareNativeHeldFailure({
  openShellDriver,
  runtimeSandboxFixture,
  getStoredSandbox,
  setStoredSandbox,
  getCreatedServiceUrl,
  getExposedService,
}: ExposureDependencies) {
  const requests: OpenShellSandboxCreateRequest[] = [];
  const gatewayMethods: ExposureGatewayMethods = {
    createSandbox: async (request) => {
      requests.push(request);
      const storedSandbox: OpenShellSandboxResponse = {
        name: request.name,
        workspace: request.workspace,
        labels: structuredClone(request.labels),
        annotations: structuredClone(request.annotations),
        spec: structuredClone(request.spec),
        // Like the real client: an exposure always comes back with its URL.
        serviceUrls: request.serviceExposures.length === 0 ? {} : { "": getCreatedServiceUrl() },
      };
      setStoredSandbox(storedSandbox);
      return storedSandbox;
    },
    getSandbox: async () => getStoredSandbox(),
    getService: async (_workspace, sandbox, name) => {
      const exposedService = getExposedService();
      return exposedService === undefined ? undefined : { ...exposedService, sandbox, name };
    },
  };
  const gatewayClient: ExposureGateway = Object.assign(workspaceGatewayClient(), gatewayMethods);
  const service: OpenShellServiceResponse = {
    sandbox: "",
    name: "",
    targetPort: 18790,
    authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
    advertisedUrl: "http://native.example.test:18790/",
    url: "http://native.example.test:9443/",
  };
  const driver = openShellDriver(gatewayClient);
  const {
    context,
    revision: fixtureRevision,
    requirements,
  } = runtimeSandboxFixture(driver, {
    harnessId: "openclaw",
  });
  const revision = completeWorkspaceRevision(fixtureRevision, requirements);
  const exposing = (environment: HarnessWorkloadRequirements["environment"]) => ({
    ...requirements,
    environment: [...requirements.environment, ...environment],
  });
  await driver.ensureNamespace(context);
  return { requests, gatewayClient, service, driver, context, revision, exposing };
}

type WithdrawalDependencies = Awaited<ReturnType<typeof prepareNativeHeldFailure>> & {
  exposed: HarnessWorkloadRequirements;
  getExposedService: () => OpenShellServiceResponse | undefined;
  setExposedService: (service: OpenShellServiceResponse | undefined) => void;
  resetStoredSandbox: () => void;
};

export async function verifyNativeHeldFailureWithdrawal({
  requests,
  gatewayClient,
  service,
  driver,
  context,
  revision,
  exposing,
  exposed,
  getExposedService,
  setExposedService,
  resetStoredSandbox,
}: WithdrawalDependencies): Promise<void> {
  for (const lost of [undefined, { ...service, targetPort: 8081 }]) {
    setExposedService(lost);
    await assert.rejects(
      driver.provisionHarness({ ...context, revision, requirements: exposed }),
      /exists without its exact bearer-passthrough Harness service/,
    );
  }
  setExposedService(service);
  await driver.provisionHarness({ ...context, revision, requirements: exposed });
  assert.equal(requests.length, 1);
  // The exposure is for Compute's status read only: no inbound Harness endpoint.
  await assert.rejects(
    driver.harnessEndpoint({ ...context, revision, requirements: exposed }),
    /only for dedicated Codex revisions/,
  );
  // A projected APP_SERVER_PORT asks for no exposure (finding 1661): it is refused as a
  // secretKeyRef variable, not for a missing verifier, before any gateway call.
  await assert.rejects(
    driver.provisionHarness({
      ...context,
      revision,
      requirements: exposing([
        { name: "APP_SERVER_PORT", valueFrom: { secretKeyRef: { name: "ports", key: "port" } } },
      ]),
    }),
    (error) => {
      assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
      assert.match(error.message, /cannot receive secretKeyRef environment APP_SERVER_PORT/);
      return true;
    },
  );
  assert.equal(requests.length, 1);

  // Finding 1657: the exposure serves Compute's read only until the worker's node enrolls.
  // OpenShell routes it without authenticating the caller, so once nothing of Compute's
  // listens there it goes, and a Sandbox adopted after enrollment is without it.
  const deletions: Array<[string, string, string]> = [];
  let deletion = async () => {
    setExposedService(undefined);
  };
  gatewayClient.deleteService = async (workspace, sandboxName, name) => {
    deletions.push([workspace, sandboxName, name]);
    await deletion();
  };
  const enrolled = { ...context, revision, requirements: exposed, workspaceNodeEnrolled: true };
  // The gateway does not confirm the delete: adoption fails closed, the service stays.
  deletion = async () => {
    throw new Error("OpenShell DeleteService did not confirm deletion.");
  };
  await assert.rejects(driver.provisionHarness(enrolled), /did not confirm deletion/);
  const firstRequest = requests[0];
  assert.ok(firstRequest);
  assert.deepEqual(deletions, [[firstRequest.workspace, firstRequest.name, ""]]);
  assert.notEqual(getExposedService(), undefined);
  deletion = async () => {
    setExposedService(undefined);
  };
  await driver.provisionHarness(enrolled);
  assert.equal(deletions.length, 2);
  assert.equal(getExposedService(), undefined);
  // Absent after enrollment is the steady state: no delete, no complaint, no create.
  await driver.provisionHarness(enrolled);
  assert.equal(deletions.length, 2);
  assert.equal(requests.length, 1);
  // Before enrollment the same absence stays an anomaly.
  await assert.rejects(
    driver.provisionHarness({ ...context, revision, requirements: exposed }),
    /exists without its exact bearer-passthrough Harness service/,
  );
  assert.equal(requests.length, 1);
  assert.equal(deletions.length, 2);
  // A Sandbox created again after enrollment (the stale one was removed) carries the
  // exposure its immutable request names and loses it in the same pass.
  resetStoredSandbox();
  setExposedService(service);
  await driver.provisionHarness(enrolled);
  assert.equal(requests.length, 2);
  const secondRequest = requests[1];
  assert.ok(secondRequest);
  assert.deepEqual(secondRequest.serviceExposures, firstRequest.serviceExposures);
  assert.equal(deletions.length, 3);
  assert.equal(getExposedService(), undefined);
  // The enrolling pass withdraws it directly, once; a Codex Harness keeps its transport.
  setExposedService(service);
  await driver.withdrawHarnessExposure(enrolled);
  assert.equal(deletions.length, 4);
  assert.equal(getExposedService(), undefined);
  await driver.withdrawHarnessExposure(enrolled);
  assert.equal(deletions.length, 4);
  setExposedService(service);
  deletion = async () => {
    throw new Error("OpenShell DeleteService did not confirm deletion.");
  };
  await assert.rejects(driver.withdrawHarnessExposure(enrolled), /did not confirm deletion/);
  assert.notEqual(getExposedService(), undefined);
  assert.equal(deletions.length, 5);
  await assert.rejects(
    driver.withdrawHarnessExposure({
      ...enrolled,
      revision: {
        ...revision,
        harness: { ...revision.harness, id: "codex", version: "1.0.0", mode: "dedicated" },
      },
    }),
    (error) => {
      assert.ok(error instanceof SandboxRevisionUnsupportedError, String(error));
      assert.equal(error.code, "SANDBOX_HARNESS_UNSUPPORTED");
      assert.match(error.message, /keeps its exposure as the Gateway transport/);
      return true;
    },
  );
  await assert.rejects(
    driver.withdrawHarnessExposure({
      ...enrolled,
      revision: { ...revision, sandboxDriverId: "other" },
    }),
    /another Sandbox Driver/,
  );
  assert.equal(deletions.length, 5);
  // Finding 1670: OpenShell answers NOT_FOUND for a Sandbox this identity may not see exactly
  // as for one that is gone, so an absent service is "withdrawn" only once a Workspace read the
  // identity still passes confirms it (GetWorkspace keeps PERMISSION_DENIED). A refusal there
  // fails closed with its own code, a missing Workspace fails closed too, a gateway that does
  // not answer keeps its class, and no deletion is attempted on any of them.
  setExposedService(undefined);
  const getWorkspace = gatewayClient.getWorkspace;
  const workspaceReads: string[] = [];
  gatewayClient.getWorkspace = async (name) => {
    workspaceReads.push(name);
    return getWorkspace(name);
  };
  await driver.withdrawHarnessExposure(enrolled);
  await driver.provisionHarness(enrolled);
  assert.deepEqual(workspaceReads, [firstRequest.workspace, firstRequest.workspace]);
  assert.equal(deletions.length, 5);
  // grpc-js ServiceError shape: PERMISSION_DENIED (7) and UNAUTHENTICATED (16).
  for (const [code, name] of [
    [7, "PERMISSION_DENIED"],
    [16, "UNAUTHENTICATED"],
  ]) {
    gatewayClient.getWorkspace = async () => {
      throw Object.assign(new Error(`${code} ${name}: workspace`), { code, details: "workspace" });
    };
    for (const withdraw of [
      () => driver.withdrawHarnessExposure(enrolled),
      () => driver.provisionHarness(enrolled),
    ]) {
      await assert.rejects(withdraw(), (error) => {
        assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
        assert.equal(error.code, "SANDBOX_GATEWAY_UNAUTHORIZED");
        assert.equal(error.transient, code === 16);
        assert.match(error.message, /cannot be confirmed withdrawn/);
        return true;
      });
    }
  }
  gatewayClient.getWorkspace = async () => undefined;
  await assert.rejects(
    driver.withdrawHarnessExposure(enrolled),
    /reports no Workspace .* cannot be confirmed withdrawn/,
  );
  const unansweredWorkspace = new DependencyUnavailableError(
    "OpenShell GetWorkspace failed with gRPC status 14.",
  );
  gatewayClient.getWorkspace = async () => {
    throw unansweredWorkspace;
  };
  await assert.rejects(
    driver.withdrawHarnessExposure(enrolled),
    (error) => error === unansweredWorkspace,
  );
  assert.equal(deletions.length, 5);
  gatewayClient.getWorkspace = getWorkspace;
  // The same lost or expired identity answers on the first read (an expired token fails every
  // call as UNAUTHENTICATED) or on the delete itself: those fail with the code too, instead of
  // spending attempts as a generic failure, and nothing is confirmed.
  const serviceRead = gatewayClient.getService;
  gatewayClient.getService = async () => {
    throw Object.assign(new Error("16 UNAUTHENTICATED: token expired"), {
      code: 16,
      details: "token expired",
    });
  };
  for (const withdraw of [
    () => driver.withdrawHarnessExposure(enrolled),
    () => driver.provisionHarness(enrolled),
  ]) {
    await assert.rejects(withdraw(), (error) => {
      assert.ok(error instanceof SandboxGatewayUnauthorizedError, String(error));
      assert.equal(error.code, "SANDBOX_GATEWAY_UNAUTHORIZED");
      assert.equal(error.transient, true);
      return true;
    });
  }
  gatewayClient.getService = serviceRead;
  setExposedService(service);
  const serviceDelete = gatewayClient.deleteService;
  gatewayClient.deleteService = async () => {
    throw Object.assign(new Error("7 PERMISSION_DENIED: workspace"), {
      code: 7,
      details: "workspace",
    });
  };
  await assert.rejects(
    driver.withdrawHarnessExposure(enrolled),
    (error) => error instanceof SandboxGatewayUnauthorizedError,
  );
  gatewayClient.deleteService = serviceDelete;
  setExposedService(undefined);
  assert.equal(deletions.length, 5);
  // Finding 1692: GetWorkspace proves the role now, not at the first read, so a role restored
  // between them would confirm a live service withdrawn. The service is read again after
  // GetWorkspace: one that read finds is deleted, a refusal there carries the code, and only a
  // service still missing counts as withdrawn.
  gatewayClient.getWorkspace = async (name) => {
    workspaceReads.push(name);
    return getWorkspace(name);
  };
  const serviceAnswers: Array<OpenShellServiceResponse | Error | undefined> = [];
  gatewayClient.getService = async (...args) => {
    const answer = serviceAnswers.length === 0 ? serviceRead(...args) : serviceAnswers.shift();
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  setExposedService(service);
  deletion = async () => {
    setExposedService(undefined);
  };
  serviceAnswers.push(undefined);
  await driver.withdrawHarnessExposure(enrolled);
  assert.equal(workspaceReads.length, 3);
  assert.equal(deletions.length, 6);
  assert.equal(getExposedService(), undefined);
  setExposedService(service);
  serviceAnswers.push(
    undefined,
    Object.assign(new Error("7 PERMISSION_DENIED: workspace"), { code: 7, details: "workspace" }),
  );
  await assert.rejects(
    driver.withdrawHarnessExposure(enrolled),
    (error) => error instanceof SandboxGatewayUnauthorizedError,
  );
  assert.equal(deletions.length, 6);
  assert.notEqual(getExposedService(), undefined);
  setExposedService(undefined);
  serviceAnswers.push(undefined);
  await driver.withdrawHarnessExposure(enrolled);
  assert.equal(workspaceReads.length, 5);
  assert.equal(deletions.length, 6);
  gatewayClient.getService = serviceRead;
  gatewayClient.getWorkspace = getWorkspace;
  // Nothing is observed through a withdrawn exposure, and nothing is asked of the gateway.
  const getService = gatewayClient.getService;
  gatewayClient.getService = async () => assert.fail("an enrolled worker is not observed");
  await assert.rejects(
    driver.harnessStatus({ ...enrolled, transportToken: "transport-token" }),
    /node has enrolled; its Harness exposure is withdrawn/,
  );
  gatewayClient.getService = getService;
}
