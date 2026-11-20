import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { IncomingMessage, type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import test, { type TestContext } from "node:test";

import Fastify, {
  type FastifyRequest,
} from "../../apps/controller/node_modules/fastify/fastify.js";
import { AdmissionFailure } from "../../apps/controller/src/admission/admission-verifier.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type {
  DenialOwner,
  RecoveryFixture,
  UpgradeSocket,
} from "./native-admin-upgrade-recovery-cases.ts";

export class AdmissionSocket extends EventEmitter<{
  close: [];
  error: [Error];
  upgrade: [{ statusCode: number; headers: IncomingHttpHeaders }, UpgradeSocket, Buffer];
}> {
  destroyed = false;
  readableEnded = false;
  writableEnded = false;
  writableLength = 0;
  writes: (string | Buffer)[] = [];

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }

  write(value: string | Buffer): boolean {
    this.writes.push(value);
    return true;
  }

  pipe<Destination>(destination: Destination): Destination {
    return destination;
  }
}

// The interceptor's public boundary requires real Fastify requests and replies.
// Injection keeps this probe local and unbound; only the denial fixture's decisions are controlled.
async function httpProbe(t: TestContext, owner: DenialOwner) {
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  let next: { entered: PromiseWithResolvers<FastifyRequest>; raw?: IncomingMessage } | undefined;
  app.get("/", async (request, reply) => {
    const pending = next;
    assert.ok(pending, "an HTTP probe request must have an owner");
    next = undefined;
    if (pending.raw) {
      request.raw = pending.raw;
    }
    pending.entered.resolve(request);
    assert.equal(await owner.access.interceptHttp(request, reply), true);
  });
  await app.ready();
  return {
    async start(raw?: IncomingMessage) {
      const entered = Promise.withResolvers<FastifyRequest>();
      next = { entered, ...(raw === undefined ? {} : { raw }) };
      const response = app.inject({
        method: "GET",
        url: "/",
        headers: owner.request().headers,
        remoteAddress: "127.0.0.1",
      });
      const request = await entered.promise;
      return { request, response };
    },
  };
}

function errorCode(body: unknown): string | undefined {
  const code = asRecord(asRecord(body)?.error)?.code;
  return typeof code === "string" ? code : undefined;
}

export function registerDelayedDenialAppendCase({
  denialOwner,
  settleCallbacks,
}: RecoveryFixture): void {
  test("native-admin denial ownership closes before a delayed or rejected append", async (t) => {
    const append = Promise.withResolvers<void>();
    const owner = await denialOwner(t, { append: () => append.promise });
    const socket = owner.upgrade();
    try {
      await settleCallbacks();
      assert.equal(socket.destroyed, true);
      assert.equal(owner.denials().length, 1);
      const [denial] = owner.denials();
      assert.ok(denial);
      assert.equal(denial.actor?.principalId, "actor_1");
      assert.equal(denial.authorization?.action, "administer");
      append.reject(new Error("synthetic sink failure"));
      await settleCallbacks();
      assert.equal(
        asRecord(owner.warnings[0])?.event,
        "native_admin.websocket_denial_audit_failed",
      );
      assert.equal(owner.denials().length, 1);
      assert.equal(owner.upstreams.length, 0);
    } finally {
      append.resolve();
      socket.destroy();
      await settleCallbacks();
      await owner.shutdown();
    }
  });
}

export function registerHttpAuditFailureCase({
  denialOwner,
  settleCallbacks,
}: RecoveryFixture): void {
  test("native-admin denial ownership retains HTTP audit failure and timeout responses", async (t) => {
    const admission = Promise.withResolvers<never>();
    let reads = 0;
    const owner = await denialOwner(t, {
      authorize({ denied }) {
        reads += 1;
        return reads === 1 ? Promise.reject(denied) : admission.promise;
      },
      append: () => Promise.reject(new Error("synthetic sink failure")),
    });
    const probe = await httpProbe(t, owner);
    try {
      const timely = await probe.start();
      const timelyResponse = await timely.response;
      assert.equal(owner.access.httpAdmissionReason(timely.request), "denial_audit_failed");
      assert.equal(timelyResponse.statusCode, 503);
      assert.equal(errorCode(timelyResponse.json<unknown>()), "DEPENDENCY_UNAVAILABLE");
      const late = await probe.start();
      await settleCallbacks();
      t.mock.timers.tick(5_000);
      const lateResponse = await late.response;
      assert.equal(lateResponse.statusCode, 503);
      assert.equal(owner.access.httpAdmissionReason(late.request), "admission_unavailable");
      admission.reject(owner.denied);
      await settleCallbacks();
      assert.equal(owner.access.httpAdmissionReason(late.request), "admission_unavailable");
      assert.equal(owner.denials().length, 2);
      assert.equal(owner.upstreams.length, 0);
    } finally {
      admission.reject(owner.denied);
      await Promise.allSettled([admission.promise]);
      await settleCallbacks();
      await owner.shutdown();
    }
  });
}

export function registerHttpDenialResponseCases({
  denialOwner,
  settleCallbacks,
}: RecoveryFixture): void {
  test("native-admin HTTP admission preserves typed refusals and dependency failures", async (t) => {
    type Reason = Exclude<ReturnType<DenialOwner["access"]["httpAdmissionReason"]>, undefined>;
    const cases: readonly { error: Error; status: number; reason: Reason }[] = [
      {
        error: new AdmissionFailure(401, "UNAUTHENTICATED", "missing session"),
        status: 403,
        reason: "session_invalid",
      },
      {
        error: new AdmissionFailure(403, "FORBIDDEN", "scope refused"),
        status: 403,
        reason: "admission_forbidden",
      },
      { error: new Error("session store unavailable"), status: 503, reason: "dependency_failure" },
    ];
    for (const { error, status, reason } of cases) {
      await t.test(reason, async (t) => {
        // The verifier's public failure contract drives the real HTTP admission owner.
        const owner = await denialOwner(t, { admissionError: error });
        const probe = await httpProbe(t, owner);
        const handling = await probe.start();
        const response = await handling.response;
        assert.equal(response.statusCode, status);
        assert.equal(owner.access.httpAdmissionReason(handling.request), reason);
        assert.equal(owner.denials().length, 0, "no attributed IAM operation was attempted");
        assert.equal(owner.upstreams.length, 0);
        await owner.shutdown();
      });
    }
  });

  test("native-admin denial ownership preserves a timely HTTP denial response", async (t) => {
    const owner = await denialOwner(t);
    const probe = await httpProbe(t, owner);
    const handling = await probe.start();
    const response = await handling.response;
    assert.equal(response.statusCode, 403);
    assert.equal(errorCode(response.json<unknown>()), "FORBIDDEN");
    assert.equal(owner.denials().length, 1);
    assert.equal(owner.upstreams.length, 0);
    await owner.shutdown();
  });

  test("native-admin denial ownership permits a completed HTTP request on a live connection", async (t) => {
    const transport = Promise.withResolvers<string>();
    let transportEntered = false;
    const owner = await denialOwner(t, {
      authorize: (selection) => Promise.resolve(selection),
      transport() {
        transportEntered = true;
        return transport.promise;
      },
    });
    const probe = await httpProbe(t, owner);
    // IncomingMessage may finish and auto-destroy while its connection remains live.
    // Admission must check the connection rather than treating that EOF as disconnect.
    const socket = new net.Socket();
    const raw = new IncomingMessage(socket);
    const request = owner.request();
    raw.method = request.method;
    raw.url = request.url;
    raw.headers = request.headers;
    raw.complete = true;
    raw.push(null);
    raw.resume();
    let response: ReturnType<typeof probe.start> | undefined;
    try {
      await settleCallbacks();
      assert.equal(raw.destroyed, true);
      assert.equal(raw.socket.destroyed, false);
      response = probe.start(raw);
      const handling = await response;
      await settleCallbacks();
      assert.equal(transportEntered, true);
      // End before proxying; this case proves admission ordering without a real upstream.
      transport.resolve("");
      assert.equal((await handling.response).statusCode, 503);
      assert.equal(owner.upstreams.length, 0);
    } finally {
      transport.resolve("");
      if (response) {
        await (
          await response
        ).response;
      }
      raw.destroy();
      socket.destroy();
      await owner.shutdown();
    }
  });
}
