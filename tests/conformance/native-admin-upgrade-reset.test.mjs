import https from "node:https";
import test from "node:test";

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
} from "./native-admin-upgrade-transport-fixture.ts";

// The tests supply only the controller, IAM and auth methods exercised by the upgrade.
/** @param {import("./native-admin-upgrade-transport-fixture.ts").AccessRegistration} input */
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
}) {
  return createNativeAdminAccess({
    app,
    installationId,
    publicOrigin: "https://console.example.com",
    factory: { create: (event) => event },
    getController: () => ({
      async resolveAgentReference(predicate) {
        return predicate(agent) ? agent : undefined;
      },
      getBrowserAccessibleActiveAgentRevision: admit,
      selectedDriver: () => ({
        id: "compute_test",
        implementation: "native-admin-reset-test",
        getGatewayBrowserRequest: supportsBrowser()
          ? async () => ({
              endpoint: gatewayEndpoint(),
              subject: "test:native-actor-1",
              headers: { ...browserHeaders },
            })
          : undefined,
      }),
    }),
    selectedIAMDriver: () => ({
      id: "iam_test",
      async lookupIdentity() {
        return {
          kind: "principal",
          id: "actor_1",
          issuer: "https://issuer.example",
          subject: "user-1",
        };
      },
    }),
    getContext: () => undefined,
    getAdmission: () => undefined,
    auth: { sharedCookieDomain: "example.com", admissionVerifier },
    nativeAdmin: { enabled: true, domain },
    nativeAdminGatewayApiKey: gatewayKey,
    webSocketLeaseIntervalMs: leaseIntervalMs,
    auditSink: { append: appendAudit },
  });
}

/** @type {Parameters<typeof createDenialOwner>[0]} */
function registerDenial(input) {
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
}

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

for (const phase of ["admission", "gateway key"]) {
  test(`a client reset while the native-admin ${phase} is pending never opens the Agent gateway`, () =>
    clientResetWhilePending(phase, registerAccess));
}
