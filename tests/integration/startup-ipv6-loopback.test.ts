import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { compileCacheEnvironment } from "../helpers/compile-cache.mjs";
import { jsonEvent } from "../helpers/json-lines.mjs";

type StartupEntryPoint =
  | { path: "apps/controller/src/server.mjs"; event: "startup-error" }
  | { path: "scripts/bootstrap-installation.mjs"; event: "installation.bootstrap-failed" };

type StartupMode = "development" | "production";

type StartupEnvironment = {
  NODE_ENV?: StartupMode;
  OCC_AUTH_BASE_URL: string;
  OCC_AUTH_SECRET: string;
  OCC_AGENT_NATIVE_ADMIN_DOMAIN?: string;
};

const controller = {
  path: "apps/controller/src/server.mjs",
  event: "startup-error",
} satisfies StartupEntryPoint;
const bootstrap = {
  path: "scripts/bootstrap-installation.mjs",
  event: "installation.bootstrap-failed",
} satisfies StartupEntryPoint;

const startupEnvironment = {
  ...compileCacheEnvironment,
  PATH: process.env.PATH,
  NODE_ENV: "development",
  OCC_HOST: "127.0.0.1",
  OCC_PORT: "8080",
  OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.occ-dev-example.oce.localhost",
  OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
};

const startupCases: readonly { entryPoint: StartupEntryPoint; mode: StartupMode }[] = [
  { entryPoint: controller, mode: "development" },
  { entryPoint: bootstrap, mode: "development" },
  { entryPoint: bootstrap, mode: "production" },
];

function diagnosticCode(stderr: string, entryPoint: StartupEntryPoint) {
  const record: unknown = jsonEvent(stderr, entryPoint.event, { strict: true });
  assert.ok(
    typeof record === "object" &&
      record !== null &&
      "code" in record &&
      typeof record.code === "string",
    stderr,
  );
  return record.code;
}

function run(entryPoint: StartupEntryPoint, env: StartupEnvironment) {
  const result = spawnSync(process.execPath, [entryPoint.path], {
    cwd: process.cwd(),
    env: {
      ...startupEnvironment,
      ...env,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

test("API and bootstrap reject IPv6 origins without a shared HTTPS DNS scope", () => {
  for (const { entryPoint, mode } of startupCases) {
    const result = run(entryPoint, {
      NODE_ENV: mode,
      OCC_AUTH_BASE_URL: "http://[::1]:3000",
      // URL refusal precedes the separate secret check and any database access.
      OCC_AUTH_SECRET: "short",
    });
    assert.equal(result.status, 1);
    assert.equal(diagnosticCode(result.stderr, entryPoint), "AUTH_BASE_URL_INVALID");
    assert.doesNotMatch(result.stderr, /OCC_AUTH_SECRET|loopback host|loopback HTTP\(S\) URL/);
  }
});

test("development controller accepts reserved localhost subdomains for its browser origin", () => {
  const result = run(controller, {
    OCC_AUTH_BASE_URL: "https://console.occ-dev-example.oce.localhost:8443",
    OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.occ-dev-example.oce.localhost",
    OCC_AUTH_SECRET: "short",
  });
  assert.equal(result.status, 1);
  assert.equal(diagnosticCode(result.stderr, controller), "AUTH_SECRET_INVALID");
  assert.doesNotMatch(result.stderr, /loopback host|AUTH_BASE_URL_INVALID/);
});

test("API and bootstrap reject bare localhost browser session origins", () => {
  for (const origin of ["http://localhost:3000", "https://localhost:3000"]) {
    for (const entryPoint of [controller, bootstrap]) {
      const result = run(entryPoint, {
        OCC_AUTH_BASE_URL: origin,
        OCC_AUTH_SECRET: "short",
      });
      assert.equal(result.status, 1);
      // Bare localhost has no registrable suffix to share with Agent hosts.
      assert.equal(
        diagnosticCode(result.stderr, entryPoint),
        "AUTH_BASE_URL_INVALID",
        `${entryPoint.path}: ${origin}`,
      );
    }
  }
});

test("development API and both bootstrap modes reject nonloopback HTTP auth origins", () => {
  for (const { entryPoint, mode } of startupCases) {
    const result = run(entryPoint, {
      NODE_ENV: mode,
      OCC_AUTH_BASE_URL: "http://192.0.2.10:3000",
      OCC_AUTH_SECRET: "development-auth-secret-with-at-least-32-characters",
    });
    assert.equal(result.status, 1);
    assert.equal(diagnosticCode(result.stderr, entryPoint), "AUTH_BASE_URL_INVALID");
    assert.doesNotMatch(result.stderr, /loopback host|loopback HTTP\(S\) URL/);
  }
});
