import assert from "node:assert/strict";
import type { strandsBoxResources } from "../../apps/controller/src/drivers/sandbox/strands-box-resources.ts";
import {
  StrandsBoxSandboxDriver,
  type StrandsBoxOptions,
} from "../../apps/controller/src/drivers/sandbox/strands-box.ts";
import { StrandsBoxCredentialProxyDriver } from "../../apps/controller/src/drivers/credential-proxy/strands-box.ts";
import { gatewayRouting } from "../helpers/kubernetes-routed-scenarios.mjs";
import { providerEndpointFixture } from "./kubernetes-provider-endpoint.mjs";

type Context = Parameters<typeof strandsBoxResources>[0];

export async function preparedHarness(): Promise<Context> {
  // Capture the real Compute-generated launch description, including the
  // distinct model and transport keys in one revision-owned Secret.
  const fixture = providerEndpointFixture({ servicePrincipalCredentials: { mode: "disabled" } });
  Object.assign(fixture.sandbox, { implementation: "strands-box" });
  Object.assign(fixture.revision.compute, {
    admission: fixture.driver.admitRevision(fixture.revision),
  });
  await fixture.prepare();
  fixture.setGatewayServing();
  fixture.setSetupAvailable(true);
  fixture.observePods([fixture.pod("ready")]);
  assert.equal((await fixture.prepare()).ready, true);
  return fixture.provisions[0]!;
}

export function selection(namespace?: string): StrandsBoxOptions {
  return {
    kubernetes: {
      ...(namespace !== undefined && { stockLauncher: { namespace } }),
      seccompProfile: "oce-strands-box-v0.3.1.json",
      nodeSelector: { "kubernetes.io/arch": "arm64" },
      controlPlanePeer: { namespace: "control-plane", podLabels: { app: "worker" } },
    },
    policy: { network: { endpoints: [{ host: "api.openai.com", ports: [443] }] } },
  };
}

export async function stagedStockFixture() {
  const context = await preparedHarness();
  const { agentId, namespaceId, configurationId } = context.revision;
  const sourceId = "model-source";
  const driverId = "strands-test";
  const grant = { agentId, sourceId, profile: "openai-responses" } as const;
  const options = selection();
  const stagedOptions = {
    ...options,
    kubernetes: {
      ...options.kubernetes,
      stockLauncher: { namespace: context.namespace.name, agentGrants: [grant] },
    },
  };
  const route = {
    host: "api.openai.com",
    ports: [{ from: 443, to: 443 }],
    requestPolicy: { type: "http" as const, method: "POST", path: "/v1/responses" },
  };
  const allowed = [{ ...route, subject: "agent" as const }];
  const deployment: NonNullable<Context["revision"]["credentialDeployment"]> = {
    driver: { id: driverId, implementation: "strands-box", configurationId: "a".repeat(64) },
    proxyDriverId: driverId,
    bindings: [
      {
        bindingRef: "model",
        sourceRef: { kind: "credential_source", id: sourceId, namespaceId },
        consumer: { kind: "model", providerId: "codex" },
        projection: { environment: "OPENAI_API_KEY", presentation: "bearer" },
      },
    ],
    networkAccessPolicy: { allowed },
    injectionPolicies: [{ bindingRef: "model", allowedRequests: allowed }],
  };
  const revision = {
    ...context.revision,
    compute: { ...context.revision.compute },
    executionAdmission: { version: 8, mode: "standalone" },
    sandboxDriverId: driverId,
    sandboxPolicy: {
      driverId,
      implementation: "strands-box",
      version: 1,
      defaults: {},
      additions: [],
    },
    harnessAuth: {
      method: "credential_source",
      sourceType: "static",
      sourceId,
      tokenServiceInstanceId: "issuer",
    },
    credentialDeployment: deployment,
  } satisfies Context["revision"];
  // Capture Compute's actual staged transport delivery and launch requirements.
  // Unprotected inputs can carry a different kind of credential projection.
  const sandbox = new StrandsBoxSandboxDriver(stagedOptions, {
    id: driverId,
    authentication: { mode: "inCluster" },
    routing: gatewayRouting,
    dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
  });
  const proxy = new StrandsBoxCredentialProxyDriver(sandbox);
  const fixture = providerEndpointFixture({
    sandboxDriver: sandbox,
    servicePrincipalCredentials: { mode: "disabled" },
  });
  Object.assign(fixture.driver, {
    credentialDeliveryRegistration: {
      ref: deployment.driver,
      require: (capability: string) => (capability === "sandbox" ? sandbox : proxy),
    },
  });
  const captured = new Error("Captured Box provision request");
  let staged: Context | undefined;
  sandbox.workspaceNodePeerLabels = async () => undefined;
  sandbox.provisionStagedHarness = async (input) => {
    staged = input;
    throw captured;
  };
  Object.assign(revision.compute, { admission: fixture.driver.admitRevision(revision) });
  const prepare = {
    harnessAuth: revision.harnessAuth,
    configureCredentialDeployment: async () => assert.fail("No execution has been staged"),
  };
  await fixture.prepare(revision, prepare);
  fixture.setGatewayServing();
  fixture.setSetupAvailable(true);
  fixture.observePods([fixture.pod("ready")]);
  await assert.rejects(fixture.prepare(revision, prepare), (error) => error === captured);
  assert.ok(staged);
  sandbox.provisionStagedHarness = StrandsBoxSandboxDriver.prototype.provisionStagedHarness;
  return {
    staged,
    stagedOptions,
    context,
    route,
    allowed,
    deployment,
    sourceId,
    configurationId,
    sandbox,
    proxy,
    fixture,
    prepare,
  };
}
