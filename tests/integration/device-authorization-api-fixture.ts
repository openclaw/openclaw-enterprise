import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { Static } from "typebox";
import type { SandboxNetworkGrant } from "../../packages/contracts/src/index.ts";

import {
  credentialSourceDeliveryBinding,
  installationControllerOptions,
} from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import type { OpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";
import type { OccLogger } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { AgentDeviceAuthorizationResponse } from "../../packages/contracts/src/api/resources.ts";
import { OpenClawController, type PlatformStateStore } from "../../packages/occ/src/index.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  controlDeviceIssuer,
  installDeviceCredentialService,
  DEVICE_OAUTH_ACCESS_TOKEN,
  DEVICE_OAUTH_REFRESH_TOKEN,
  type DeviceIssuerOptions,
} from "../helpers/device-credential-service.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { gatewayRouting } from "../helpers/kubernetes-routed-options.ts";
import { completeOpenShellGatewayClient } from "../helpers/openshell-gateway-client.ts";

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type RequestArguments = Parameters<ConsoleFixture["request"]>;
type Session = NonNullable<RequestArguments[2]>["session"];
type ApiResponse = Omit<Awaited<ReturnType<ConsoleFixture["request"]>>, "body" | "data"> & {
  body: unknown;
  data: unknown;
};
type FixtureOptions = DeviceIssuerOptions & {
  oauthIssuer?: import("../../packages/occ/src/controller-composition.ts").ControllerOptions["oauthIssuer"];
  logger?: OccLogger;
  auditSink?: InMemoryAuditSink;
  native?: boolean;
  ceiling?: readonly SandboxNetworkGrant[];
  gatewayClient?: Partial<OpenShellGatewayClient>;
};
export type DeviceLogin = Static<typeof AgentDeviceAuthorizationResponse>["data"];
export type DeviceAuthFixture = Awaited<ReturnType<typeof createFixture>>;

export async function createFixture(
  t: TestContext,
  {
    logger,
    auditSink = new InMemoryAuditSink(),
    native = false,
    ceiling,
    gatewayClient,
    oauthIssuer,
    ...issuerOptions
  }: FixtureOptions = {},
) {
  const clock = createControlledClock();
  const secretDriver = createTestSecretDriver();
  const issuer = controlDeviceIssuer(t, issuerOptions);
  let state: PlatformStateStore | undefined;
  let runtime: Awaited<ReturnType<typeof loadInstallationFile>> = undefined;
  if (native) {
    const configuration = buildSandboxInstallation();
    Reflect.deleteProperty(configuration.drivers, "credential_gateway");
    Reflect.deleteProperty(configuration.backend[0]?.drivers ?? {}, "credential_gateway");
    Object.assign(configuration.drivers, { credential_service: { id: "occ", configuration: {} } });
    if (ceiling !== undefined) {
      Reflect.deleteProperty(configuration.drivers.compute.configuration.network, "gatewayClients");
      Object.assign(configuration.drivers.compute.configuration, { gatewayRouting });
    }
    runtime = await loadInstallationFile(
      t,
      configuration,
      gatewayClient === undefined
        ? {}
        : {
            createOpenShellBackend: (definition) =>
              createOpenShellBackend(definition, {
                gatewayClient: completeOpenShellGatewayClient(gatewayClient),
              }),
          },
    );
    assert.ok(runtime?.credentialDeliveryRegistration);
    if (gatewayClient !== undefined) {
      // This suite controls Namespace placement instead of contacting a Kubernetes cluster.
      runtime.computeDriver.resolveSandboxNamespace = async (namespace) => ({
        ...namespace,
        name: "oauth-api-fixture",
      });
    }
    if (ceiling !== undefined) {
      // Admission is under test; the disposable in-memory fixture has no Kubernetes API.
      runtime.computeDriver.getAgentRuntimeCredentialStatus = async () => ({
        transportConfigured: true,
      });
    }
  }
  const fixture = await createConsoleAppFixture(t, {
    ...(runtime
      ? {
          ...installationControllerOptions(runtime.installation),
          namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
          credentialSourceDelivery: credentialSourceDeliveryBinding(runtime),
        }
      : {}),
    auditSink,
    ...(oauthIssuer === undefined ? {} : { oauthIssuer }),
    secretDriver,
    logger,
    now: () => new Date(clock.wallNow()),
    wrapState: (value: PlatformStateStore) => {
      state = value;
      return value;
    },
    sandboxDriver: deviceTestSandbox(),
    ...(ceiling === undefined ? {} : { sandboxNetworkPolicyCeiling: ceiling }),
  });
  await fixture.bootstrap();
  const controller = fixture.controller;
  assert.ok(controller instanceof OpenClawController && state);
  const { owner, instanceId } = await installDeviceCredentialService(
    controller,
    state,
    secretDriver,
  );
  const namespace = await fixture.createNamespace("Device login", { ready: true });
  if (runtime) {
    controller.registerDriver(runtime.computeDriver);
    controller.selectDriver("compute", runtime.computeDriver.id);
    installSelectedSandboxDrivers(controller, runtime);
  }
  const responses: unknown[] = [];
  const request = async (...args: RequestArguments): Promise<ApiResponse> => {
    const response = await fixture.request(...args);
    responses.push(response.body);
    return response;
  };
  const path = `/namespaces/${namespace.id}/agents/device-authorizations`;
  return {
    ...fixture,
    controller,
    state,
    request,
    namespace,
    secretDriver,
    issuer,
    owner,
    instanceId,
    auditSink,
    responses,
    clock,
    path,
    sourcesPath: `/namespaces/${namespace.id}/credential-sources`,
    async start(loginPath = path, session?: Session) {
      const result = await request("POST", loginPath, {
        body: { harnessId: "codex" },
        ...(session === undefined ? {} : { session }),
      });
      const { data } = fixture.fixtureResponse(
        result,
        200,
        AgentDeviceAuthorizationResponse,
        "start device authorization",
      );
      assert.equal(data.status, "pending");
      assert.equal(data.source, undefined);
      return data;
    },
    async poll(login: Pick<DeviceLogin, "session">, loginPath = path, session?: Session) {
      return request("POST", `${loginPath}/${login.session.id}/poll`, {
        body: {},
        ...(session === undefined ? {} : { session }),
      });
    },
    async stored(login: Pick<DeviceLogin, "session">) {
      const record = await controller.transact((unit) =>
        unit.authenticationStates.findDevice(namespace.id, login.session.id),
      );
      assert.ok(record);
      return record;
    },
  };
}

export function deviceTestSandbox() {
  return {
    id: "device-test-sandbox",
    capability: "sandbox" as const,
    implementation: "test-admission-only",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async cleanup() {},
  };
}

export function assertNoCredentials(fixture: DeviceAuthFixture) {
  const publicOutput = JSON.stringify([fixture.responses, fixture.auditSink.events]);
  for (const value of [
    DEVICE_OAUTH_ACCESS_TOKEN,
    DEVICE_OAUTH_REFRESH_TOKEN,
    ...fixture.issuer.handles,
  ]) {
    assert.equal(
      publicOutput.includes(value),
      false,
      "public responses and audit exclude private credential material",
    );
  }
}

export function assertDeviceAudit(
  fixture: DeviceAuthFixture,
  operation: "start" | "poll" | "cancel",
  agentId?: string,
) {
  const event = fixture.auditSink.events
    .filter((event) => event.action === `openclaw.agents.device_authorization.${operation}`)
    .at(-1);
  assert.ok(event);
  assert.equal(event.kind, "mutation");
  assert.equal(event.outcome, "success");
  assert.equal(event.authorization?.action, agentId === undefined ? "create" : "update");
  assert.deepEqual(event.authorization?.resource, {
    kind: "agent",
    id: agentId ?? fixture.namespace.id,
    namespaceId: fixture.namespace.id,
  });
}

export async function readyLogin(fixture: DeviceAuthFixture, path?: string) {
  const login = await fixture.start(path);
  await fixture.clock.advance(5000);
  const result = await fixture.poll(login, path);
  const { data } = fixture.fixtureResponse(
    result,
    200,
    AgentDeviceAuthorizationResponse,
    "poll device authorization",
  );
  assert.equal(data.status, "ready");
  assert.ok(data.source);
  return { ...data, source: data.source };
}
