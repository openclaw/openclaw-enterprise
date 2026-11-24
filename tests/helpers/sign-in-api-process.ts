import assert from "node:assert/strict";
import { once } from "node:events";
import { mock, type TestContext } from "node:test";
import { scryptPasswordHasher } from "../../apps/controller/src/auth/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { composeProductionSignIn, fakeOidc, oidcUpgradeSettings } from "./production-sign-in.mjs";

export type ApiInput = {
  databaseUrl: string;
  recoveryUserId: string;
  secrets: {
    "occ-auth/secret": string;
    "occ-oidc-login/client-id": string;
    "occ-oidc-login/client-secret": string;
  };
};

export type AuthorizeRequest = { type: "authorize"; id: string; url: string };

type ApiMessage =
  | { type: "ready"; pid: number; url: string }
  | { type: "code"; id: string; code: string }
  | { type: "failed" };

function isApiInput(value: unknown): value is ApiInput {
  const input = asRecord(value);
  const secrets = asRecord(input?.secrets);
  return (
    typeof input?.databaseUrl === "string" &&
    typeof input.recoveryUserId === "string" &&
    typeof secrets?.["occ-auth/secret"] === "string" &&
    typeof secrets["occ-oidc-login/client-id"] === "string" &&
    typeof secrets["occ-oidc-login/client-secret"] === "string"
  );
}

function isAuthorizeRequest(value: unknown): value is AuthorizeRequest {
  const message = asRecord(value);
  return (
    message?.type === "authorize" &&
    typeof message.id === "string" &&
    typeof message.url === "string"
  );
}

function send(message: ApiMessage) {
  process.send?.(message);
}

// This child has its own production API and PostgreSQL pools. Only the external
// provider transport and unused infrastructure Drivers come from the sign-in fixture.
type Dispose = () => void | Promise<void>;
const disposals: Dispose[] = [];
const context = {
  mock,
  after(dispose: Dispose) {
    disposals.push(dispose);
  },
};
let closing: Promise<void> | undefined;

async function close() {
  closing ??= (async () => {
    let failed = false;
    for (const dispose of disposals.reverse()) {
      try {
        await dispose();
      } catch {
        failed = true;
      }
    }
    mock.restoreAll();
    process.exitCode = failed ? 1 : 0;
    if (process.connected) {
      process.disconnect?.();
    }
  })();
  return closing;
}

process.once("SIGTERM", () => void close());
process.once("disconnect", () => void close());
try {
  const [input]: unknown[] = await once(process, "message");
  assert.ok(isApiInput(input));
  // The shared fixture only uses the mock tracker from the test context.
  const idp = fakeOidc(context as TestContext, {
    clientId: input.secrets["occ-oidc-login/client-id"],
    clientSecret: input.secrets["occ-oidc-login/client-secret"],
  });
  process.on("message", (message: unknown) => {
    if (isAuthorizeRequest(message)) {
      send({
        type: "code",
        id: message.id,
        code: idp.authorize(message.url, { subject: "9400011" }),
      });
    }
  });
  const app = await composeProductionSignIn(context, {
    databaseUrl: input.databaseUrl,
    settings: oidcUpgradeSettings(input.recoveryUserId),
    secrets: input.secrets,
    passwordHasher: scryptPasswordHasher,
  });
  context.after(() => app.close());
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  send({ type: "ready", pid: process.pid, url });
} catch {
  // Keep credentials and response bodies out of the child's diagnostic channel.
  send({ type: "failed" });
  await close();
  process.exitCode = 1;
}
