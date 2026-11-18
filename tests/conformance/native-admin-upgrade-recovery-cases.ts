import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import test, { type TestContext } from "node:test";

import type { AuditEventCreationInput } from "../../packages/audit/src/index.ts";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

type BrowserSelection = Awaited<
  ReturnType<OpenClawController["getBrowserAccessibleActiveAgentRevision"]>
>;

type AdmissionSelection = {
  readonly agent: Pick<BrowserSelection["agent"], "id" | "namespaceId" | "desiredRuntimeState">;
  readonly revision: Pick<BrowserSelection["revision"], "id" | "compute" | "configuration">;
  readonly mode: BrowserSelection["mode"];
};

type AuthorizationInput = AdmissionSelection & { readonly denied: Error };

export interface DenialOverrides {
  readonly authorize?: (input: AuthorizationInput) => Promise<AdmissionSelection>;
  readonly append?: (event: AuditEventCreationInput) => Promise<void>;
  readonly transport?: () => Promise<string>;
  readonly admissionError?: Error;
}

export interface UpgradeSocket {
  readonly destroyed: boolean;
  readonly writes: readonly (string | Buffer)[];
  destroy(): UpgradeSocket;
  emit(event: "error", error: Error): boolean;
}

interface GatewayRequest {
  emit(
    event: "upgrade",
    reply: { statusCode: number; headers: IncomingHttpHeaders },
    socket: UpgradeSocket,
    head: Buffer,
  ): boolean;
}

interface DenialOwner {
  readonly denied: Error;
  readonly warnings: readonly unknown[];
  readonly upstreams: readonly GatewayRequest[];
  denials(): readonly AuditEventCreationInput[];
  shutdown(): Promise<void>;
  upgrade(): UpgradeSocket;
}

interface RecoveryFixture {
  denialOwner(t: TestContext, overrides: DenialOverrides): Promise<DenialOwner>;
  settleCallbacks(): Promise<void>;
  AdmissionSocket: new () => UpgradeSocket;
}

function acknowledgeUpgrade(owner: DenialOwner, socket: UpgradeSocket): void {
  assert.equal(owner.upstreams.length, 1);
  const [upstream] = owner.upstreams;
  assert.ok(upstream);
  upstream.emit("upgrade", { statusCode: 101, headers: {} }, socket, Buffer.alloc(0));
}

export function registerUpgradeAdmissionRecoveryCases({
  denialOwner,
  settleCallbacks,
  AdmissionSocket,
}: RecoveryFixture): void {
  for (const boundary of ["timeout", "disconnect", "shutdown-wait-expiry"]) {
    test(`native-admin denial ownership consumes a denial after ${boundary}`, async (t) => {
      const admission = Promise.withResolvers<never>();
      const owner = await denialOwner(t, { authorize: () => admission.promise });
      const socket = owner.upgrade();
      let closing: Promise<void> | undefined;
      try {
        await settleCallbacks();
        if (boundary === "disconnect") {
          socket.destroy();
        } else {
          if (boundary === "shutdown-wait-expiry") {
            closing = owner.shutdown();
            await settleCallbacks();
          }
          t.mock.timers.tick(5_000);
          await settleCallbacks();
          if (closing) {
            await closing;
            const warning = asRecord(owner.warnings[0]);
            assert.equal(warning?.event, "native_admin.pending_work_unresolved");
            assert.equal(warning?.pending, 1);
          }
        }
        assert.equal(socket.destroyed, true);
        admission.reject(owner.denied);
        await settleCallbacks();
        assert.equal(owner.denials().length, 1);
        assert.equal(owner.denials()[0]?.resource.id, "agent_a");
        assert.equal(owner.upstreams.length, 0);
      } finally {
        admission.reject(owner.denied);
        socket.destroy();
        await settleCallbacks();
        await (closing ?? owner.shutdown());
      }
    });
  }

  test("native-admin denial ownership drains admission through append under one deadline", async (t) => {
    const admission = Promise.withResolvers<never>();
    const append = Promise.withResolvers<void>();
    const owner = await denialOwner(t, {
      authorize: () => admission.promise,
      append: () => append.promise,
    });
    const socket = owner.upgrade();
    let finished = false;
    await settleCallbacks();
    const closing = owner.shutdown().then(() => {
      finished = true;
    });
    try {
      await settleCallbacks();
      assert.equal(finished, false);
      t.mock.timers.tick(4_000);
      admission.reject(owner.denied);
      await settleCallbacks();
      assert.equal(owner.denials().length, 1);
      assert.equal(finished, false);
      // The transition to append must not get a second five-second shutdown budget.
      t.mock.timers.tick(1_000);
      await settleCallbacks();
      assert.equal(finished, true);
      assert.equal(asRecord(owner.warnings[0])?.pending, 1);
      append.resolve();
      await settleCallbacks();
      await owner.shutdown();
      assert.equal(owner.warnings.length, 1);
      assert.equal(owner.denials().length, 1);
    } finally {
      admission.reject(owner.denied);
      append.resolve();
      socket.destroy();
      await settleCallbacks();
      await closing;
    }
  });

  for (const boundary of ["timeout", "disconnect", "shutdown"]) {
    test(`native-admin denial ownership never opens a gateway after ${boundary}`, async (t) => {
      const admission = Promise.withResolvers<AdmissionSelection>();
      let selection: AuthorizationInput | undefined;
      const owner = await denialOwner(t, {
        authorize(input) {
          selection = input;
          return admission.promise;
        },
      });
      const socket = owner.upgrade();
      let closing: Promise<void> | undefined;
      try {
        await settleCallbacks();
        assert.ok(selection, "authorization must be pending before the connection is closed");
        if (boundary === "timeout") {
          t.mock.timers.tick(5_000);
          await settleCallbacks();
        } else if (boundary === "disconnect") {
          socket.destroy();
        } else {
          closing = owner.shutdown();
          await settleCallbacks();
        }
        admission.resolve(selection);
        await settleCallbacks();
        assert.equal(socket.destroyed, true);
        assert.equal(owner.upstreams.length, 0);
        assert.equal(owner.denials().length, 0);
      } finally {
        if (selection !== undefined) {
          admission.resolve(selection);
        }
        socket.destroy();
        await settleCallbacks();
        await (closing ?? owner.shutdown());
      }
    });
  }

  test("native-admin denial ownership closes a denied lease before append settles", async (t) => {
    const append = Promise.withResolvers<void>();
    let reads = 0;
    const owner = await denialOwner(t, {
      authorize(input) {
        reads += 1;
        return reads === 1 ? Promise.resolve(input) : Promise.reject(input.denied);
      },
      append(event) {
        return event.kind === "authorization_denial" ? append.promise : Promise.resolve();
      },
    });
    const socket = owner.upgrade();
    const upstreamSocket = new AdmissionSocket();
    try {
      await settleCallbacks();
      acknowledgeUpgrade(owner, upstreamSocket);
      await settleCallbacks();
      assert.ok(socket.writes.join("").startsWith("HTTP/1.1 101"));
      t.mock.timers.tick(25_000);
      await settleCallbacks();
      assert.equal(socket.destroyed, true);
      assert.equal(upstreamSocket.destroyed, true);
      assert.equal(owner.denials().length, 1);
      append.resolve();
      await settleCallbacks();
      assert.equal(owner.denials().length, 1);
    } finally {
      append.resolve();
      socket.destroy();
      upstreamSocket.destroy();
      await settleCallbacks();
      await owner.shutdown();
    }
  });
}

export function registerUpgradeLeaseAndResetRecoveryCases({
  denialOwner,
  settleCallbacks,
  AdmissionSocket,
}: RecoveryFixture): void {
  for (const order of ["denial-first", "deadline-first"]) {
    test(`native-admin denial ownership attempts one audit at the deadline (${order})`, async (t) => {
      const admission = Promise.withResolvers<never>();
      const owner = await denialOwner(t, { authorize: () => admission.promise });
      if (order === "denial-first") {
        setTimeout(() => admission.reject(owner.denied), 5_000);
      }
      const socket = owner.upgrade();
      try {
        await settleCallbacks();
        if (order === "deadline-first") {
          setTimeout(() => admission.reject(owner.denied), 5_000);
        }
        t.mock.timers.tick(5_000);
        await settleCallbacks();
        assert.equal(socket.destroyed, true);
        const denials = owner.denials();
        assert.equal(denials.length, 1);
        const [denial] = denials;
        assert.ok(denial);
        assert.equal(denial.actor?.principalId, "actor_1");
        assert.equal(denial.authorization?.action, "administer");
        assert.equal(denial.resource.id, "agent_a");
        assert.equal(owner.upstreams.length, 0);
        t.mock.timers.tick(5_000);
        await settleCallbacks();
        assert.equal(owner.denials().length, 1);
      } finally {
        admission.reject(owner.denied);
        socket.destroy();
        await settleCallbacks();
        await owner.shutdown();
      }
    });
  }

  test("native-admin denial ownership audits a lease denial after its timeout closes the connection", async (t) => {
    const renewal = Promise.withResolvers<never>();
    let reads = 0;
    const owner = await denialOwner(t, {
      authorize(input) {
        reads += 1;
        return reads === 1 ? Promise.resolve(input) : renewal.promise;
      },
    });
    const socket = owner.upgrade();
    const upstreamSocket = new AdmissionSocket();
    try {
      await settleCallbacks();
      acknowledgeUpgrade(owner, upstreamSocket);
      await settleCallbacks();
      t.mock.timers.tick(25_000);
      await settleCallbacks();
      assert.equal(reads, 2);
      t.mock.timers.tick(5_000);
      await settleCallbacks();
      assert.equal(socket.destroyed, true);
      renewal.reject(owner.denied);
      await settleCallbacks();
      assert.equal(owner.denials().length, 1);
      const nativeAdmin = asRecord(owner.denials()[0]?.details?.nativeAdmin);
      assert.equal(nativeAdmin?.revisionId, "rev_a");
    } finally {
      renewal.reject(owner.denied);
      socket.destroy();
      upstreamSocket.destroy();
      await settleCallbacks();
      await owner.shutdown();
    }
  });

  test("native-admin denial ownership preserves reset handling while transport is pending", async (t) => {
    const transport = Promise.withResolvers<string>();
    const owner = await denialOwner(t, {
      authorize: (selection) => Promise.resolve(selection),
      transport: () => transport.promise,
    });
    const socket = owner.upgrade();
    try {
      await settleCallbacks();
      socket.emit("error", new Error("synthetic reset"));
      transport.resolve("synthetic");
      await settleCallbacks();
      assert.equal(socket.destroyed, true);
      assert.equal(owner.upstreams.length, 0);
    } finally {
      transport.resolve("synthetic");
      socket.destroy();
      await settleCallbacks();
      await owner.shutdown();
    }
  });

  test("native-admin denial ownership preserves reset handling during admission", async (t) => {
    const admission = Promise.withResolvers<never>();
    const owner = await denialOwner(t, { authorize: () => admission.promise });
    const socket = owner.upgrade();
    try {
      await settleCallbacks();
      socket.emit("error", new Error("synthetic reset"));
      admission.reject(owner.denied);
      await settleCallbacks();
      assert.equal(socket.destroyed, true);
      assert.equal(owner.denials().length, 1);
      assert.equal(owner.upstreams.length, 0);
    } finally {
      admission.reject(owner.denied);
      socket.destroy();
      await settleCallbacks();
      await owner.shutdown();
    }
  });

  test("native-admin denial ownership keeps dependency failures distinct from denials", async (t) => {
    const unavailable = new Error("synthetic unavailable dependency");
    unavailable.name = "DependencyUnavailableError";
    const owner = await denialOwner(t, { authorize: () => Promise.reject(unavailable) });
    const socket = owner.upgrade();
    try {
      await settleCallbacks();
      assert.equal(socket.destroyed, true);
      assert.equal(owner.denials().length, 0);
      assert.equal(owner.upstreams.length, 0);
    } finally {
      socket.destroy();
      await owner.shutdown();
    }
  });
}
