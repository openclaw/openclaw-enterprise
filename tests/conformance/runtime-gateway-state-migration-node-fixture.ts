import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { RuntimeFailureEvidence } from "@openclaw-enterprise/contracts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { setVersion, sharedPath } from "./runtime-gateway-state-migration-fixture.ts";

const TRANSPORT_TOKEN = "fixture-transport-token";
// The Compute status port's identity, and a Sandbox provider's transport exposure (the
// token's verifier, never the token): where a held startup failure is read.
export const COMPUTE_STATUS_ENV = {
  OPENCLAW_RUNTIME_STATUS_PORT: "18791",
  OPENCLAW_AGENT_REVISION_ID: "rev_fixture",
  OPENCLAW_RUNTIME_STATUS_CONTAINER: "agent",
  OPENCLAW_POD_UID: "pod-fixture",
};
export const PROVIDER_TRANSPORT_ENV = {
  APP_TOKEN_SHA: createHash("sha256").update(TRANSPORT_TOKEN).digest("hex"),
  APP_SERVER_PORT: "18790",
};

interface StatusRequest {
  method: "GET";
  url: string;
  headers: { authorization?: string };
}

interface StatusResponse {
  destroyed?: boolean;
  writeHead(code: number): void;
  end(chunk?: string): void;
}

export type RequestHandler = (request: StatusRequest, response: StatusResponse) => void;

export interface CapturedServer {
  handler: RequestHandler;
  port: number | string | undefined;
}

// Answers one request to a captured server handler.
export async function call(
  handler: RequestHandler,
  {
    url = "/openclaw/runtime/status",
    authorization,
  }: { url?: string; authorization?: string | undefined } = {},
) {
  let status: number | undefined;
  let body = "";
  await new Promise<void>((resolve) => {
    handler(
      { method: "GET", url, headers: authorization === undefined ? {} : { authorization } },
      {
        writeHead(code) {
          status = code;
        },
        end(chunk) {
          body += chunk ?? "";
          resolve();
        },
      },
    );
  });
  const parsed: unknown = body === "" ? undefined : JSON.parse(body);
  return { status, body: parsed };
}

// What a held startup failure serves: on the Compute status port, the status Compute
// validates (exact revision, container and Pod) with readiness held at 503; on the
// provider's transport, the failure to the token holder only. Never any log text.
export async function assertHeldFailureServed(
  servers: readonly CapturedServer[],
  env: NodeJS.ProcessEnv,
  check: RuntimeFailureEvidence["check"],
) {
  const listening = servers.filter((server) => server.port !== undefined);
  assert.equal(listening.length, 1, JSON.stringify(listening));
  const [server] = listening;
  assert.ok(server);
  const { port, handler } = server;
  const compute = env.OPENCLAW_RUNTIME_STATUS_PORT !== undefined;
  assert.equal(String(port), compute ? env.OPENCLAW_RUNTIME_STATUS_PORT : env.APP_SERVER_PORT);
  const authorization = compute ? undefined : `Bearer ${TRANSPORT_TOKEN}`;
  const answer = await call(handler, { authorization });
  assert.equal(answer.status, 200);
  const { body } = answer;
  assert.ok(body && typeof body === "object" && "runtimeFailure" in body);
  const { runtimeFailure } = body;
  assert.ok(runtimeFailure && typeof runtimeFailure === "object" && "checkedAt" in runtimeFailure);
  const { checkedAt, ...held } = runtimeFailure;
  assert.ok(typeof checkedAt === "string");
  assert.ok(!Number.isNaN(Date.parse(checkedAt)));
  assert.deepEqual(held, { component: "agent", check, code: "UNAVAILABLE" });
  if (compute) {
    assert.deepEqual(Object.keys(body), ["revisionId", "container", "podUid", "runtimeFailure"]);
    assert.deepEqual(
      [
        "revisionId" in body ? body.revisionId : undefined,
        "container" in body ? body.container : undefined,
        "podUid" in body ? body.podUid : undefined,
      ],
      ["rev_fixture", "agent", "pod-fixture"],
    );
    assert.equal((await call(handler, { url: "/readyz" })).status, 503);
  } else {
    assert.deepEqual(Object.keys(body), ["runtimeFailure"]);
    assert.equal((await call(handler, {})).status, 401);
  }
}

// A failed bind emits an error. Without the wrapper's error listener it throws.
export function listener(servers: CapturedServer[], handler: RequestHandler, bindError?: string) {
  const server: CapturedServer = { handler, port: undefined };
  servers.push(server);
  const emitter = new EventEmitter<{ error: [error: NodeJS.ErrnoException] }>();
  return {
    on: (event: "error", handle: (error: NodeJS.ErrnoException) => void) =>
      emitter.on(event, handle),
    listen(port: number | string) {
      if (bindError !== undefined) {
        emitter.emit("error", Object.assign(new Error("bind failed"), { code: bindError }));
        return;
      }
      server.port = port;
    },
  };
}

// The workspace node and dedicated worker keep their shared state on the workspace claim.
export async function workspaceNodeDirectory(t: TestContext, version?: number) {
  const directory = await temporaryDirectory(t, "oce-harness-state-migration-");
  await mkdir(join(directory, "node-state", "state"), { recursive: true });
  await mkdir(join(directory, "workspace"));
  if (version !== undefined) {
    setVersion(sharedPath(join(directory, "node-state")), version);
  }
  return directory;
}
