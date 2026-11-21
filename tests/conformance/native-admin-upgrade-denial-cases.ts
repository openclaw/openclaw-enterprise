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

async function startHttpProbe(t: TestContext, owner: DenialOwner, raw?: IncomingMessage) {
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  const entered = Promise.withResolvers<{ request: FastifyRequest; handled: Promise<boolean> }>();
  app.get("/", async (request, reply) => {
    if (raw) {
      request.raw = raw;
    }
    const handled = owner.access.interceptHttp(request, reply);
    entered.resolve({ request, handled });
    await handled;
  });
  const injected = Promise.resolve(
    app.inject({
      method: "GET",
      url: "/",
      headers: owner.request().headers,
      remoteAddress: "127.0.0.1",
    }),
  );
  const interception = await Promise.race([entered.promise, injected.then(() => undefined)]);
  assert.ok(interception, "injection must reach the HTTP interceptor");
  return {
    request: interception.request,
    async finish() {
      // Fastify can deliver a reply while the interceptor is still running.
      const [handled, response] = await Promise.all([interception.handled, injected]);
      assert.equal(handled, true);
      return response;
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
    try {
      const timely = await startHttpProbe(t, owner);
      const timelyResponse = await timely.finish();
      assert.equal(owner.access.httpAdmissionReason(timely.request), "denial_audit_failed");
      assert.equal(timelyResponse.statusCode, 503);
      assert.equal(errorCode(timelyResponse.json<unknown>()), "DEPENDENCY_UNAVAILABLE");
      const late = await startHttpProbe(t, owner);
      await settleCallbacks();
      t.mock.timers.tick(5_000);
      const lateResponse = await late.finish();
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
        const handling = await startHttpProbe(t, owner);
        const response = await handling.finish();
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
    const handling = await startHttpProbe(t, owner);
    const response = await handling.finish();
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
    let handling: Awaited<ReturnType<typeof startHttpProbe>> | undefined;
    try {
      await settleCallbacks();
      assert.equal(raw.destroyed, true);
      assert.equal(raw.socket.destroyed, false);
      handling = await startHttpProbe(t, owner, raw);
      await settleCallbacks();
      assert.equal(transportEntered, true);
      // End before proxying; this case proves admission ordering without a real upstream.
      transport.resolve("");
      assert.equal((await handling.finish()).statusCode, 503);
      assert.equal(owner.upstreams.length, 0);
    } finally {
      transport.resolve("");
      await Promise.allSettled([handling?.finish()]);
      raw.destroy();
      socket.destroy();
      await owner.shutdown();
    }
  });
}
