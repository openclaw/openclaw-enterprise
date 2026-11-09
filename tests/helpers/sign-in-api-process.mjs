import { once } from "node:events";
import { mock } from "node:test";
import { scryptPasswordHasher } from "../../apps/controller/src/auth/index.ts";
import { composeProductionSignIn, oidcUpgradeSettings, fakeOidc } from "./production-sign-in.mjs";

// This child has its own production API and PostgreSQL pools. Only the external
// provider transport and unused infrastructure Drivers come from the sign-in fixture.
const disposals = [];
const context = { mock, after: (dispose) => disposals.push(dispose) };
let closing;
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
      process.disconnect();
    }
  })();
  return closing;
}

process.once("SIGTERM", () => void close());
process.once("disconnect", () => void close());
try {
  const [input] = await once(process, "message");
  const idp = fakeOidc(context, {
    clientId: input.secrets["occ-oidc-login/client-id"],
    clientSecret: input.secrets["occ-oidc-login/client-secret"],
  });
  process.on("message", (message) => {
    if (message.type === "authorize") {
      process.send({
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
  process.send({ type: "ready", pid: process.pid, url });
} catch {
  // Keep credentials and response bodies out of the child's diagnostic channel.
  process.send?.({ type: "failed" });
  await close();
  process.exitCode = 1;
}
