import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHumanLogin } from "../../apps/controller/src/auth/human-login.ts";
import { createControllerAuth as createFixtureAuth } from "../helpers/password-hasher.ts";
import type {
  ControllerAuth,
  ControllerAuthOptions,
} from "../../apps/controller/src/auth/index.ts";
import type { createFastifyApp } from "../../apps/controller/src/index.ts";
import {
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { SIGN_IN_UNAVAILABLE, signInRateLimited } from "../helpers/refusal-text.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
type App = ReturnType<typeof createFastifyApp>;
export type Database = NonNullable<ControllerAuthOptions["memoryDatabase"]>;
export type AdapterFactory = ReturnType<ReturnType<typeof createHumanLogin>["database"]>;
type Audit = NonNullable<ControllerAuthOptions["passwordSignInAudit"]>;
export type Outcome = ["accepted", string] | ["refused"];
export type OperationalEvent = Parameters<
  NonNullable<ControllerAuthOptions["onOperationalEvent"]>
>[0];
type HumanState = Pick<
  PostgresHumanAuthentication,
  "createAttempt" | "consumeAttempt" | "snapshotExternal" | "snapshotPassword" | "recordDenied"
> &
  Partial<Pick<PostgresHumanAuthentication, "knownDeviceState" | "recoveryDesignation">>;
export const createControllerAuth: (options: ControllerAuthOptions) => ControllerAuth =
  createFixtureAuth;
const memoryModule: unknown = await import(require.resolve("better-auth/adapters/memory"));
assert.ok(
  typeof memoryModule === "object" &&
    memoryModule !== null &&
    "memoryAdapter" in memoryModule &&
    typeof memoryModule.memoryAdapter === "function",
);
export const memoryAdapter = memoryModule.memoryAdapter as (database: Database) => AdapterFactory;
const authModule: unknown = await import(require.resolve("better-auth"));
assert.ok(
  typeof authModule === "object" &&
    authModule !== null &&
    "APIError" in authModule &&
    typeof authModule.APIError === "function",
);
export const APIError = authModule.APIError as new (
  status: string | number,
  body: { message: string },
) => Error;
const fastifyModule: unknown = require("fastify");
assert.equal(typeof fastifyModule, "function");
const Fastify = fastifyModule as (options: { genReqId: () => string }) => App;

function humanState(overrides: HumanState): PostgresHumanAuthentication {
  const state = new PostgresPlatformState({
    async connect() {
      throw new Error("unexpected persistence access");
    },
    async end() {},
  });
  return Object.assign(
    new PostgresHumanAuthentication(state, "ins_sign_in_audit", "fixture"),
    overrides,
  );
}

export type Sent = {
  status: number;
  headers: Awaited<ReturnType<App["inject"]>>["headers"];
  payload: unknown;
};
function isErrorPayload(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}
export function errorOf(response: Sent): { code: string; message: string } {
  const payload = response.payload;
  assert.ok(typeof payload === "object" && payload !== null && "error" in payload);
  assert.ok(isErrorPayload(payload.error));
  return payload.error;
}

export const baseURL = "https://console.oce.localhost";
export const email = "audited@example.test";
export const password = "audited-account-password";

export const secret = "password-sign-in-audit-secret-at-least-32-bytes";

export const REFUSED = "The caller did not provide valid authentication credentials.";

// An outage and a rate limit each say what happened; neither reads as a wrong password.
export function assertUnavailable(response: Sent) {
  assert.equal(response.status, 503, JSON.stringify(response.payload));
  assert.deepEqual(errorOf(response), {
    code: "DEPENDENCY_UNAVAILABLE",
    message: SIGN_IN_UNAVAILABLE,
  });
}

export function assertLimited(response: Sent) {
  assert.equal(response.status, 429, JSON.stringify(response.payload));
  const seconds = Number(response.headers["retry-after"]);
  assert.ok(seconds >= 1 && seconds <= 60, String(seconds));
  assert.deepEqual(errorOf(response), {
    code: "RATE_LIMITED",
    message: signInRateLimited(seconds),
  });
}

export function controller(audit: Audit, extra: Partial<ControllerAuthOptions> = {}) {
  const memoryDatabase = { user: [], session: [], account: [], verification: [], apikey: [] };
  const auth = createControllerAuth({
    mode: "development",
    installationId: "ins_sign_in_audit",
    baseURL,
    agentDomain: "agents.oce.localhost",
    secret,
    memoryDatabase,
    passwordSignInAudit: audit,
    ...extra,
  });
  return { auth, memoryDatabase };
}

export async function signIn(
  auth: ControllerAuth,
  body: { email: string; password: string },
  headers: Record<string, string> = {},
) {
  return send(auth.signInEmail, {
    id: "req_audit",
    ip: "127.0.0.1",
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: baseURL, ...headers },
    body,
  });
}

// Calls one auth endpoint handler and records what it sends.
export async function send(
  handler: ControllerAuth["signInEmail"],
  request: {
    id: string;
    ip: string;
    method: "POST";
    url: string;
    headers: Record<string, string>;
    body: Record<string, string>;
  },
): Promise<Sent> {
  const app = Fastify({ genReqId: () => request.id });
  app.post(request.url, handler);
  try {
    const response = await app.inject({
      method: request.method,
      url: request.url,
      headers: request.headers,
      payload: request.body,
      remoteAddress: request.ip,
    });
    return {
      status: response.statusCode,
      headers: response.headers,
      payload: response.json<unknown>(),
    };
  } finally {
    await app.close();
  }
}

type GuardedControllerOptions = Pick<
  ControllerAuthOptions,
  "installationId" | "onOperationalEvent" | "passwordSlowLaneFloors"
> & {
  state?: Partial<HumanState>;
  passwordSignIn?: "recovery-only";
};

export function guardedController({
  installationId,
  state = {},
  passwordSignIn,
  onOperationalEvent,
  passwordSlowLaneFloors,
}: GuardedControllerOptions): ControllerAuth {
  const humanLogin = createHumanLogin(
    humanState({
      createAttempt: async () => {
        throw new Error("not used");
      },
      consumeAttempt: async () => undefined,
      snapshotExternal: async () => undefined,
      snapshotPassword: async () => undefined,
      recordDenied: async () => {},
      ...state,
    }),
    {
      recoveryUserId: "guarded-recovery",
      google: {
        clientId: "guarded-client",
        clientSecret: "guarded-client-secret",
        allowedDomains: [],
      },
      ...(passwordSignIn ? { passwordSignIn } : {}),
    },
    baseURL,
  );
  return createControllerAuth({
    mode: "development",
    installationId,
    baseURL,
    agentDomain: "agents.oce.localhost",
    secret,
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], apikey: [] }),
    humanLogin,
    ...(onOperationalEvent ? { onOperationalEvent } : {}),
    ...(passwordSlowLaneFloors ? { passwordSlowLaneFloors } : {}),
  });
}
