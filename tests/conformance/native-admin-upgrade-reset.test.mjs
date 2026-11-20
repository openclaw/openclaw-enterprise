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

// These three registrations deliberately provide partial product options. Keep them at
// the JS boundary rather than fabricating a complete Controller, IAM Driver or auth object.
/** @param {import("./native-admin-upgrade-transport-fixture.ts").TransportRegistration} input */
function registerTransport({
  app,
  installationId,
  agent,
  revision,
  denied,
  entered,
  authorize,
  supportsBrowser,
  gatewayEndpoint,
  appendAudit,
  domain,
}) {
  createNativeAdminAccess({
    app,
    installationId,
    publicOrigin: "https://console.example.com",
    factory: { create: (event) => event },
    getController: () => ({
      async resolveAgentReference(predicate) {
        return predicate(agent) ? agent : undefined;
      },
      getBrowserAccessibleActiveAgentRevision() {
        entered.resolve();
        return authorize({ agent, revision, denied, mode: "admin" });
      },
      selectedDriver: () => ({
        id: "compute_test",
        implementation: "native-admin-reset-test",
        getGatewayBrowserRequest: supportsBrowser()
          ? async () => ({
              endpoint: gatewayEndpoint(),
              subject: "test:native-actor-1",
              headers: {
                "x-occ-identity": "test:native-actor-1",
                "x-occ-browser-key": "browser-test-secret",
              },
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
    auth: {
      sharedCookieDomain: "example.com",
      admissionVerifier: {
        async verify() {
          return {
            method: "session",
            decisionId: "dec_1",
            admittedScope: { installationId },
            externalIdentity: { issuer: "https://issuer.example", subject: "user-1" },
            session: {
              id: "sess_1",
              userId: "user-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        },
      },
    },
    nativeAdmin: { enabled: true, domain },
    nativeAdminGatewayApiKey: async () => "transport-fixture-key",
    webSocketLeaseIntervalMs: 50,
    auditSink: { append: appendAudit },
  });
}

/** @param {import("./native-admin-upgrade-transport-fixture.ts").DenialRegistration} input */
function registerDenial({
  t,
  app,
  installationId,
  agent,
  revision,
  denied,
  overrides,
  upstreams,
  domain,
  appendAudit,
}) {
  // A missing interception fails before any external network request can occur.
  t.mock.method(https, "request", () => {
    const upstream = new AdmissionSocket();
    upstreams.push(upstream);
    return upstream;
  });
  return createNativeAdminAccess({
    app,
    installationId,
    publicOrigin: "https://console.example.com",
    factory: { create: (event) => event },
    getController: () => ({
      async resolveAgentReference(predicate) {
        return predicate(agent) ? agent : undefined;
      },
      getBrowserAccessibleActiveAgentRevision() {
        return (
          overrides.authorize?.({ agent, revision, denied, mode: "admin" }) ??
          Promise.reject(denied)
        );
      },
      selectedDriver: () => ({
        id: "compute_test",
        implementation: "native-admin-reset-test",
        getGatewayBrowserRequest: async () => ({
          endpoint: "wss://gateway.example.test",
          subject: "test:native-actor-1",
          headers: {},
        }),
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
    auth: {
      sharedCookieDomain: "example.com",
      admissionVerifier: {
        async verify() {
          if (overrides.admissionError) {
            throw overrides.admissionError;
          }
          return {
            method: "session",
            decisionId: "dec_1",
            admittedScope: { installationId },
            externalIdentity: { issuer: "https://issuer.example", subject: "user-1" },
            session: {
              id: "sess_1",
              userId: "user-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        },
      },
    },
    nativeAdmin: { enabled: true, domain },
    nativeAdminGatewayApiKey: overrides.transport ?? (async () => "synthetic"),
    webSocketLeaseIntervalMs: undefined,
    auditSink: { append: appendAudit },
  });
}

/** @param {import("./native-admin-upgrade-transport-fixture.ts").PendingResetRegistration} input */
function registerPendingReset({
  app,
  installationId,
  agent,
  domain,
  admit,
  gatewayEndpoint,
  gatewayKey,
}) {
  createNativeAdminAccess({
    app,
    installationId,
    publicOrigin: "https://console.example.com",
    factory: {
      create(input) {
        return input;
      },
    },
    getController() {
      return {
        async resolveAgentReference(predicate) {
          return predicate(agent) ? agent : undefined;
        },
        getBrowserAccessibleActiveAgentRevision() {
          return admit();
        },
        selectedDriver() {
          return {
            id: "compute_test",
            implementation: "native-admin-reset-test",
            getGatewayBrowserRequest: async () => ({
              endpoint: gatewayEndpoint(),
              subject: "test:native-actor-1",
              headers: {},
            }),
          };
        },
      };
    },
    selectedIAMDriver() {
      return {
        id: "iam_test",
        async lookupIdentity() {
          return {
            kind: "principal",
            id: "actor_1",
            issuer: "https://issuer.example",
            subject: "user-1",
          };
        },
      };
    },
    getContext() {
      return undefined;
    },
    getAdmission() {
      return undefined;
    },
    auth: {
      sharedCookieDomain: "example.com",
      admissionVerifier: {
        async verify() {
          return {
            method: "session",
            decisionId: "dec_1",
            admittedScope: { installationId },
            externalIdentity: { issuer: "https://issuer.example", subject: "user-1" },
            session: {
              id: "sess_1",
              userId: "user-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        },
      },
    },
    nativeAdmin: { enabled: true, domain },
    nativeAdminGatewayApiKey() {
      return gatewayKey();
    },
    webSocketLeaseIntervalMs: undefined,
    auditSink: { async append() {} },
  });
}

const auditFixture = {
  transportOwner: createTransportOwner(registerTransport),
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
    clientResetWhilePending(phase, registerPendingReset));
}
