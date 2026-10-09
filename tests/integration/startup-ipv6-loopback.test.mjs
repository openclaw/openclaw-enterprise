import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const developmentEnvironment = {
  PATH: process.env.PATH,
  NODE_ENV: "development",
  OCC_HOST: "127.0.0.1",
  OCC_PORT: "8080",
  OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
};

function diagnostic(result, path) {
  const event = path.endsWith("server.mjs") ? "startup-error" : "installation.bootstrap-failed";
  const line = result.stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((entry) => JSON.parse(entry))
    .find((entry) => entry.event === event);
  assert.ok(line, result.stderr);
  return line;
}

function run(path, env) {
  return spawnSync(process.execPath, [path], {
    cwd: process.cwd(),
    env: {
      ...developmentEnvironment,
      ...env,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("development startup accepts bracketed IPv6 loopback auth base URLs", () => {
  for (const path of ["apps/controller/src/server.mjs", "scripts/bootstrap-installation.mjs"]) {
    const result = run(path, {
      OCC_AUTH_BASE_URL: "http://[::1]:3000",
      OCC_AUTH_SECRET: "short",
    });
    assert.equal(result.status, 1);
    assert.equal(diagnostic(result, path).code, "AUTH_SECRET_INVALID");
    assert.doesNotMatch(result.stderr, /OCC_AUTH_SECRET|loopback host|loopback HTTP\(S\) URL/);
  }
});

test("development API and bootstrap accept localhost auth origins", () => {
  for (const origin of ["http://localhost:3000", "https://localhost:3000"]) {
    for (const path of ["apps/controller/src/server.mjs", "scripts/bootstrap-installation.mjs"]) {
      const result = run(path, {
        OCC_AUTH_BASE_URL: origin,
        OCC_AUTH_SECRET: "short",
      });
      assert.equal(result.status, 1);
      // This later validation proves the real entrypoint admitted the origin,
      // without connecting to a database or claiming a complete startup.
      assert.equal(diagnostic(result, path).code, "AUTH_SECRET_INVALID", `${path}: ${origin}`);
    }
  }
});

test("development startup still rejects nonloopback auth base URLs", () => {
  for (const path of ["apps/controller/src/server.mjs", "scripts/bootstrap-installation.mjs"]) {
    const result = run(path, {
      OCC_AUTH_BASE_URL: "http://192.0.2.10:3000",
      OCC_AUTH_SECRET: "development-auth-secret-with-at-least-32-characters",
    });
    assert.equal(result.status, 1);
    assert.equal(diagnostic(result, path).code, "AUTH_BASE_URL_INVALID");
    assert.doesNotMatch(result.stderr, /loopback host|loopback HTTP\(S\) URL/);
  }
});
