import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import type { ServiceConfig } from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { createAlternateDriverFactory } from "./alternate.ts";
import { appFunction } from "./app-functions.ts";
import type { createTlsMaterial } from "./process.ts";
import { gatewayRequest } from "./service-fixture.ts";

export type AlternateProcessInput = {
  scenario: "listen" | "unresolved-rotation";
  config: ServiceConfig;
  tls: Pick<Awaited<ReturnType<typeof createTlsMaterial>>, "keyFile" | "certFile">;
};

async function start() {
  const input: unknown = JSON.parse(await text(process.stdin));
  if (
    !input ||
    typeof input !== "object" ||
    !("scenario" in input) ||
    (input.scenario !== "listen" && input.scenario !== "unresolved-rotation") ||
    !("config" in input) ||
    !("tls" in input) ||
    !input.tls ||
    typeof input.tls !== "object" ||
    !("keyFile" in input.tls) ||
    typeof input.tls.keyFile !== "string" ||
    !("certFile" in input.tls) ||
    typeof input.tls.certFile !== "string"
  ) {
    throw new Error("invalid alternate service fixture input");
  }

  const [validateServiceConfig, createSystemClock, runService, key, cert] = await Promise.all([
    appFunction("drivers/repo/access/configuration", "validateServiceConfig"),
    appFunction("drivers/repo/access/clock", "createSystemClock"),
    appFunction("composition/repository-credentials/service", "runService"),
    readFile(input.tls.keyFile),
    readFile(input.tls.certFile),
  ]);
  const validated = validateServiceConfig(input.config);
  // The runtime allows a kernel-assigned port after operator configuration validation.
  const config = { ...validated, gateway: { ...validated.gateway, listen: "127.0.0.1:0" } };
  const clock = createSystemClock();
  const waitingForRotation = input.scenario === "unresolved-rotation";
  const factory = createAlternateDriverFactory({
    origin: "https://upstream.example.test",
    gatewayOrigin: config.gateway.publicOrigin,
    clock,
    ...(waitingForRotation ? { controls: { lateCapture: new Promise<never>(() => {}) } } : {}),
  });
  const { service, listeners } = await runService(
    {
      config,
      tls: { key, cert },
      factory,
      authority: "github-token-development",
      trustedUpstreamOrigins: new Set(),
      close() {},
    },
    clock,
  );

  if (waitingForRotation) {
    assert.deepEqual(Reflect.ownKeys(service).sort(), ["close", "open", "shutdown", "status"]);
    assert.equal(Object.isFrozen(service), true);

    // Reach pending provider settlement over the actual HTTPS listener before SIGTERM.
    const opened = service.open({ durationSeconds: 86_400, profile: "git-write" });
    const result = await gatewayRequest(
      { config, listeners, tls: { ca: cert }, opened },
      "/team/nested/project",
    );
    assert.equal(result.status, 503);
    assert.ok(factory.events.some((event) => event.kind === "rotate"));
  }

  assert.ok(process.send, "alternate service fixture requires an IPC channel");
  process.send("ready");
}

// The parent owns the service lifetime, including interrupted startup.
process.once("disconnect", () => process.exit(1));
try {
  await start();
} catch (error) {
  // Startup failure is part of the socket refusal contract. Keep other error details,
  // including assertion values and input paths, inside the child.
  writeSync(
    process.stderr.fd,
    error instanceof Error && error.message === "startup-failed"
      ? "startup-failed\n"
      : "alternate service fixture failed\n",
  );
  process.exit(1);
}
