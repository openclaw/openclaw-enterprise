import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { AuditEventCreationInput } from "../../packages/audit/src/index.ts";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

type BrowserSelection = Awaited<
  ReturnType<OpenClawController["getBrowserAccessibleActiveAgentRevision"]>
>;

type Selection = {
  readonly agent: Pick<BrowserSelection["agent"], "id" | "namespaceId" | "desiredRuntimeState">;
  readonly revision: Pick<BrowserSelection["revision"], "id" | "compute" | "configuration">;
  readonly mode: BrowserSelection["mode"];
};

export interface UpgradeAuditTransportOptions {
  authorize(input: Selection & { readonly denied: Error }): Selection | Promise<Selection>;
  append?(event: AuditEventCreationInput): Promise<void>;
  appendSocket?(event: AuditEventCreationInput): Promise<void>;
  supportsBrowser?(): boolean;
}

export interface UpgradeAuditTransport {
  readonly host: string;
  readonly audits: readonly AuditEventCreationInput[];
  readonly warnings: readonly unknown[];
  readonly appClosed: Promise<void>;
  readonly auditEntered: Promise<void>;
  readonly serverClosed: Promise<boolean>;
  readonly peerClosed: Promise<boolean>;
  gatewayConnections(): number;
  denials(): readonly AuditEventCreationInput[];
  shutdown(): Promise<void>;
  open(): Promise<{
    readonly closed: Promise<boolean>;
    readonly ready: Promise<string>;
    received(): string;
  }>;
}

interface AuditTransportFixture {
  transportOwner(
    t: TestContext,
    options: UpgradeAuditTransportOptions,
  ): Promise<UpgradeAuditTransport>;
  within<T>(promise: Promise<T>, description: string, milliseconds?: number): Promise<T>;
}

interface RefusedUpgradeAuditFixture extends AuditTransportFixture {
  assertTransportDenial(
    owner: Pick<UpgradeAuditTransport, "denials" | "host">,
    revisionId: string | undefined,
  ): void;
}

function socketAudit(event: AuditEventCreationInput): Record<string, unknown> {
  const details = asRecord(event.details?.nativeAdmin);
  assert.ok(details, "socket audits must include native-admin details");
  return details;
}

export function registerUpgradeShutdownAuditCases({
  transportOwner,
  within,
  settleCallbacks,
}: AuditTransportFixture & { settleCallbacks(): Promise<void> }): void {
  for (const failedAudit of ["connect", "close"] as const) {
    test(`native-admin shutdown releases a rejected ${failedAudit} audit`, async (t) => {
      const rejected = new Error("Audit fixture unavailable");
      const owner = await transportOwner(t, {
        authorize: ({ agent, revision, mode }) => ({ agent, revision, mode }),
        appendSocket: async (event) => {
          if (socketAudit(event).event === failedAudit) {
            throw rejected;
          }
        },
      });
      const client = await owner.open();
      if (failedAudit === "connect") {
        await within(client.closed, "failed connect audit must close the client");
      } else {
        const response = await within(
          client.ready,
          "successful connect audit must allow forwarding",
        );
        assert.match(response, /^HTTP\/1\.1 101 /);
        assert.ok(
          response.includes("\r\n\r\npeer-ready"),
          "the gateway bytes must reach the client",
        );
      }
      await within(owner.shutdown(), "rejected audit must not wait out the shutdown deadline");
      assert.equal(owner.gatewayConnections(), 1);
      if (failedAudit === "connect") {
        assert.equal(
          client.received(),
          "",
          "the relay must not forward the gateway upgrade or bytes",
        );
      }
      assert.deepEqual(
        owner.audits.map((event) => socketAudit(event).event),
        failedAudit === "connect" ? ["connect"] : ["connect", "close"],
      );
      assert.deepEqual(
        owner.warnings.map((warning) => asRecord(warning)?.event),
        failedAudit === "connect" ? [] : ["native_admin.websocket_audit_failed"],
      );
    });
  }

  for (const deadline of [false, true]) {
    test(`native-admin shutdown drains connect and follow-on close audits${deadline ? " under one deadline" : " before onClose"}`, async (t) => {
      const connect = Promise.withResolvers<void>();
      const close = Promise.withResolvers<void>();
      const connectEntered = Promise.withResolvers<void>();
      const closeEntered = Promise.withResolvers<void>();
      const settled: ("connect" | "close" | "onClose")[] = [];
      const owner = await transportOwner(t, {
        authorize: ({ agent, revision, mode }) => ({ agent, revision, mode }),
        appendSocket: async (event) => {
          const name = socketAudit(event).event;
          assert.ok(name === "connect" || name === "close", "expected a socket audit event");
          if (name === "connect") {
            connectEntered.resolve();
            await connect.promise;
          } else {
            closeEntered.resolve();
            await close.promise;
          }
          settled.push(name);
        },
      });
      let storageMayClose = false;
      void owner.appClosed.then(() => {
        storageMayClose = true;
        settled.push("onClose");
      });
      // In the deadline case, create and clear the handshake and drain timers on
      // the same clock. The TCP/TLS peers and the test's I/O deadlines stay real.
      if (deadline) {
        t.mock.timers.enable({ apis: ["setTimeout"] });
      }
      let closing: Promise<void> | undefined;
      try {
        const client = await owner.open();
        await within(connectEntered.promise, "authorized upstream 101 must reach connect audit");
        closing = owner.shutdown();
        await within(
          Promise.all([client.closed, owner.serverClosed, owner.peerClosed]),
          "shutdown must close both relay ends without waiting for audit acknowledgment",
        );
        await settleCallbacks();
        if (deadline) {
          t.mock.timers.tick(3_000);
          await settleCallbacks();
        }
        assert.equal(storageMayClose, false, "onClose must wait for the connect audit");
        assert.deepEqual(settled, []);
        assert.equal(owner.audits.length, 1);
        connect.resolve();
        await within(closeEntered.promise, "connect settlement must emit its close audit");
        await settleCallbacks();
        assert.equal(
          storageMayClose,
          false,
          "onClose must also wait for the follow-on close audit",
        );
        assert.deepEqual(settled, ["connect"]);
        if (deadline) {
          t.mock.timers.tick(1_999);
          await settleCallbacks();
          assert.equal(storageMayClose, false, "shutdown must still wait at 4,999ms");
          assert.deepEqual(owner.warnings, []);
          t.mock.timers.tick(1);
          await within(closing, "close work must not get a fresh five-second budget");
          assert.deepEqual(owner.warnings, [
            { event: "native_admin.pending_work_unresolved", pending: 1 },
          ]);
          assert.deepEqual(settled, ["connect", "onClose"]);
        }
        close.resolve();
        await within(closing, "shutdown must finish after both audit acknowledgments");
        await settleCallbacks();
        assert.deepEqual(
          settled,
          deadline ? ["connect", "onClose", "close"] : ["connect", "close", "onClose"],
        );
        if (!deadline) {
          assert.deepEqual(owner.warnings, []);
        }
        assert.equal(owner.gatewayConnections(), 1);
        assert.equal(owner.audits.length, 2, "each socket audit is attempted exactly once");
        const [connected, closed] = owner.audits.map(socketAudit);
        assert.ok(connected && closed);
        assert.equal(connected.event, "connect");
        assert.equal(closed.event, "close");
        assert.ok(typeof connected.connectionId === "string");
        assert.match(connected.connectionId, /^naws_/);
        assert.equal(closed.connectionId, connected.connectionId);
        assert.equal(closed.closeReason, "shutdown");
      } finally {
        connect.resolve();
        close.resolve();
        try {
          await within(closing ?? owner.shutdown(), "shutdown cleanup must finish");
        } finally {
          t.mock.reset();
        }
      }
    });
  }
}

export function registerRefusedUpgradeAuditCase({
  transportOwner,
  within,
  assertTransportDenial,
}: RefusedUpgradeAuditFixture): void {
  test(
    "real native-admin transport closes a refused upgrade while its audit is pending",
    { timeout: 15_000 },
    async (t) => {
      const audit = Promise.withResolvers<void>();
      let auditSettled = false;
      const owner = await transportOwner(t, {
        authorize: ({ denied }) => Promise.reject(denied),
        append: () =>
          audit.promise.then(() => {
            auditSettled = true;
          }),
      });
      try {
        const client = await owner.open();
        await within(owner.auditEntered, "denial must reach the audit sink");
        await within(
          Promise.all([client.closed, owner.serverClosed]),
          "refused upgrade must close before audit settlement",
        );
        assert.equal(auditSettled, false);
        assert.equal(owner.gatewayConnections(), 0);
        assertTransportDenial(owner, undefined);
      } finally {
        audit.resolve();
        await owner.shutdown();
      }
      assert.equal(owner.denials().length, 1);
    },
  );
}
