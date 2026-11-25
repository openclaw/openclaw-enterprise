import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createRuntimeLogFixture } from "../helpers/runtime-logs.ts";

const publicOrigin = "https://console.oce.localhost";

export type RuntimeRoute = "logs" | "status";
export type HandledResponse = { statusCode: number; payload: unknown };

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function assertTimeoutResponse(response: HandledResponse): void {
  assert.equal(response.statusCode, 504);
  assert.ok(typeof response.payload === "string");
  const payload: unknown = JSON.parse(response.payload);
  assert.equal(record(record(payload).error).code, "RUNTIME_LOGS_TIMEOUT");
}

export async function assertRuntimeResponse(
  response: Response,
  revisionId: string,
  route: RuntimeRoute,
): Promise<void> {
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  const data = record(record(payload).data);
  assert.equal(data.revisionId, revisionId);
  if (route === "logs") {
    assert.equal(data.source, "gateway");
    assert.ok(Array.isArray(data.records));
  } else {
    assert.ok(Array.isArray(data.pods));
    assert.ok(Array.isArray(data.sources));
  }
}

export async function createListeningFixture(compute: ComputeDriver) {
  const fixture = await createRuntimeLogFixture({ computeDriver: compute });
  const target = await fixture.deployAgent("runtime-log-disconnect");
  const iam = fixture.controller.selectedDriver("iam");
  const app = createFastifyApp({
    controller: fixture.controller,
    iamDriver: iam,
    computeDriver: compute,
    auth: fixture.admin.auth,
    auditSink: fixture.auditSink,
    resolveHarness: resolveApprovedHarness,
    development: {
      enabled: true,
      installationId: fixture.controller.installation.id,
      browserOrigin: publicOrigin,
    },
    agentRuntimeLogs: {
      enabled: true,
      cursorSecret: `runtime-log-disconnect-${randomUUID()}`,
    },
  });
  const sockets = new Set<Socket>();
  app.server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return {
    fixture,
    target,
    iam,
    app,
    headers: authenticatedHeaders(fixture.adminSession, {
      host: new URL(publicOrigin).host,
      origin: publicOrigin,
    }),
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await within(app.close(), "Controller listener cleanup");
      assert.equal(app.server.listening, false);
    },
  };
}
