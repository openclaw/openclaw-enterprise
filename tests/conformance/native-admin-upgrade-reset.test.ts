import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import https from "node:https";
import test from "node:test";

import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import type { ComputeDriver, IAMDriver } from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { createControllerAuth } from "../helpers/password-hasher.ts";
import { createNativeAdminAccess } from "../../apps/controller/src/http/native-admin.ts";
import {
  registerRefusedUpgradeAuditCase,
  registerUpgradeShutdownAuditCases,
  registerUpgradeTransportAuditCases,
} from "./native-admin-upgrade-audit-cases.ts";
import {
  AdmissionSocket,
  clientResetDuringPendingDenial,
  clientResetDuringUpgradeAdmission,
  clientResetWhilePending,
  registerUpgradeAdmissionRecoveryCases,
  registerUpgradeLeaseAndResetRecoveryCases,
  settleCallbacks,
} from "./native-admin-upgrade-recovery-cases.ts";
import {
  createDenialOwner,
  createTransportOwner,
  within,
  type AccessRegistration,
  type PendingResetPhase,
} from "./native-admin-upgrade-transport-fixture.ts";

// The upgrade uses controlled decisions and transport; unrelated Driver effects fail closed.
function registerAccess({
  app,
  installationId,
  agent,
  domain,
  admissionVerifier,
  admit,
  supportsBrowser = () => true,
  gatewayEndpoint,
  browserHeaders,
  gatewayKey,
  leaseIntervalMs,
  appendAudit,
}: AccessRegistration) {
  const createdAt = "2026-09-01T00:00:00.000Z";
  const controller = new OpenClawController({
    id: installationId,
    name: "Native admin reset conformance",
    createdAt,
  });
  const unexpected = () => assert.fail("unexpected upgrade fixture Driver operation");
  const compute: ComputeDriver = {
    id: "compute_test",
    implementation: "native-admin-reset-test",
    capability: "compute",
    ensureNamespace: unexpected,
    deleteNamespace: unexpected,
    prepareRevision: unexpected,
    stopRevision: unexpected,
    retireRevision: unexpected,
  };
  // The lease cases can remove delegation after an accepted upgrade.
  Object.defineProperty(compute, "getGatewayBrowserRequest", {
    get(): ComputeDriver["getGatewayBrowserRequest"] {
      return supportsBrowser()
        ? async () => ({
            endpoint: gatewayEndpoint(),
            subject: "test:native-actor-1",
            headers: { ...browserHeaders },
          })
        : undefined;
    },
  });
  controller.registerDriver(compute);
  controller.selectDriver("compute", compute.id);
  controller.resolveAgentReference = async (predicate) => (predicate(agent) ? agent : undefined);
  controller.getBrowserAccessibleActiveAgentRevision = async () => {
    const selection = await admit();
    const configurationId = "cfg_a";
    const servicePrincipalId = "service_agent_a";
    return {
      mode: selection.mode,
      agent: {
        name: "Reset Agent",
        status: "active",
        configurationId,
        backendId: null,
        harnessAuth: null,
        executionMode: "embedded",
        gatewayManagedMode: true,
        servicePrincipalId,
        createdAt,
        ...selection.agent,
      },
      revision: {
        namespaceId: selection.agent.namespaceId,
        agentId: selection.agent.id,
        revision: 1,
        backendId: null,
        executionAdmission: { version: 2, mode: "unprotected" },
        configurationId,
        configurationKind: "agent",
        configurationGeneration: 1,
        gatewayManagedMode: true,
        harness: {
          id: "openclaw",
          mode: "embedded",
          version: "1",
          overrides: {},
          configuration: {},
        },
        harnessAuth: { method: "runtime" },
        servicePrincipalId,
        createdAt,
        ...selection.revision,
      },
    };
  };
  const iam: IAMDriver = {
    id: "iam_test",
    implementation: "native-admin-reset-test",
    capability: "iam",
    authorize: unexpected,
    async lookupIdentity() {
      return {
        kind: "principal",
        id: "actor_1",
        issuer: "https://issuer.example",
        subject: "user-1",
      };
    },
  };
  const auth = createControllerAuth({
    mode: "development",
    installationId,
    baseURL: "https://console.example.com",
    agentDomain: domain,
    secret: randomBytes(32).toString("hex"),
  });
  auth.admissionVerifier.verify = admissionVerifier.verify.bind(admissionVerifier);
  assert.equal(auth.sharedCookieDomain, "example.com");
  return createNativeAdminAccess({
    app,
    installationId,
    publicOrigin: "https://console.example.com",
    factory: new AuditEventFactory(),
    getController: () => controller,
    selectedIAMDriver: () => iam,
    getContext: () => undefined,
    getAdmission: () => undefined,
    auth,
    nativeAdmin: { enabled: true, domain },
    nativeAdminGatewayApiKey: gatewayKey,
    webSocketLeaseIntervalMs: leaseIntervalMs,
    auditSink: { append: appendAudit },
  });
}

const registerDenial: Parameters<typeof createDenialOwner>[0] = (input) => {
  const { t, app, upstreams } = input;
  // A missing interception fails before any external network request can occur.
  t.mock.method(https, "request", () => {
    const upstream = new AdmissionSocket();
    upstreams.push(upstream);
    return upstream;
  });
  return {
    access: registerAccess(input),
    emitUpgrade(request, socket, head) {
      app.server.emit("upgrade", request, socket, head);
    },
  };
};

const auditFixture = {
  transportOwner: createTransportOwner(registerAccess),
  within,
  settleCallbacks,
};
registerUpgradeShutdownAuditCases(auditFixture);
registerRefusedUpgradeAuditCase(auditFixture);
registerUpgradeTransportAuditCases(auditFixture);

test(
  "a client reset during native-admin upgrade admission does not crash",
  clientResetDuringUpgradeAdmission,
);

// These cases use real Fastify registration and shutdown without binding a port.
// Upgrade sockets, deadlines, external decisions and the HTTPS transport are controlled.
// The typed HTTP cases use an unbound Fastify probe; the cases above prove real network behavior.
const recoveryFixture = {
  denialOwner: createDenialOwner(registerDenial),
  settleCallbacks,
  AdmissionSocket,
};
registerUpgradeAdmissionRecoveryCases(recoveryFixture);
registerUpgradeLeaseAndResetRecoveryCases(recoveryFixture);

test(
  "a client reset during a pending native-admin denial still records the denial",
  clientResetDuringPendingDenial,
);

const pendingPhases: readonly PendingResetPhase[] = ["admission", "gateway key"];
for (const phase of pendingPhases) {
  test(`a client reset while the native-admin ${phase} is pending never opens the Agent gateway`, () =>
    clientResetWhilePending(phase, registerAccess));
}
