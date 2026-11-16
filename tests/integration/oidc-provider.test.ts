import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { IncomingHttpHeaders } from "node:http";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { verifyIdToken } from "../../apps/controller/src/auth/id-token.ts";
import { createOidcProviderMaterial } from "../helpers/oidc-provider-material.mjs";
import { startOidcProvider } from "../helpers/oidc-provider-server.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const execute = promisify(execFile);
const hostname = "idp.oce.example.test";
const redirectUri = "https://console.oce.example.test/api/auth/providers/oidc/callback";

async function material(t: TestContext, parent: string) {
  const value = await createOidcProviderMaterial(parent, { hostname, redirectUri });
  t.after(value.dispose);
  return value;
}

function httpsRequest(port: number, ca: Buffer, path: string, body?: URLSearchParams) {
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; text: string }>(
    (resolve, reject) => {
      // Only the test client maps the canonical DNS host to the loopback listener.
      // CA and hostname verification remain enabled; no controller transport is patched.
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          servername: hostname,
          ca,
          path,
          method: body === undefined ? "GET" : "POST",
          headers: { host: hostname, "content-type": "application/x-www-form-urlencoded" },
          timeout: 5_000,
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, headers: response.headers, text }),
          );
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("OIDC fixture request timed out")));
      req.end(body?.toString());
    },
  );
}

async function exerciseProvider(port: number, fixture: Awaited<ReturnType<typeof material>>) {
  const { config, directory } = fixture;
  const ca = await readFile(join(directory, "ca.pem"));
  const discovery = await httpsRequest(port, ca, "/.well-known/openid-configuration");
  assert.equal(discovery.status, 200);
  assert.equal(JSON.parse(discovery.text).issuer, config.issuer);
  assert.equal(JSON.parse(discovery.text).token_endpoint, config.tokenUrl);
  const verifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const parameters = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid",
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  // Reject ambiguity before the adapter validates one value and the core captures another.
  const duplicate = new URLSearchParams(parameters);
  duplicate.append("redirect_uri", "https://other.oce.example.test/callback");
  assert.equal((await httpsRequest(port, ca, `/authorize?${duplicate}`)).status, 400);
  const authorize = async () => {
    const response = await httpsRequest(port, ca, `/authorize?${parameters}`);
    assert.equal(response.status, 302);
    assert.ok(response.headers.location);
    const callback = new URL(response.headers.location);
    assert.equal(callback.origin + callback.pathname, redirectUri);
    assert.equal(callback.searchParams.get("state"), state);
    const code = callback.searchParams.get("code");
    assert.ok(code);
    return code;
  };
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: await authorize(),
    code_verifier: verifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
  });
  const response = await httpsRequest(port, ca, "/oauth/token", form);
  assert.equal(response.status, 200);
  const keys = await httpsRequest(port, ca, "/.well-known/jwks.json");
  assert.equal(keys.status, 200);
  const token = JSON.parse(response.text).id_token;
  const expected = {
    issuers: new Set([config.issuer]),
    clientId: config.clientId,
    nonce,
    jwks: JSON.parse(keys.text),
    now: Date.now(),
  };
  // The production verifier checks the HTTPS-delivered key, signature and identity claims.
  assert.equal(verifyIdToken(token, expected)?.sub, config.subject);
  assert.equal(verifyIdToken(token, { ...expected, nonce: "wrong-nonce" }), undefined);
  assert.equal((await httpsRequest(port, ca, "/oauth/token", form)).status, 400);
  form.set("code", await authorize());
  // Valid verifier syntax isolates a digest mismatch from syntax rejection.
  form.set("code_verifier", "different-verifier".padEnd(43, "_"));
  assert.equal((await httpsRequest(port, ca, "/oauth/token", form)).status, 400);
  // A digest match cannot substitute for the required PKCE verifier.
  parameters.set("code_challenge", createHash("sha256").update("").digest("base64url"));
  form.set("code", await authorize());
  form.delete("code_verifier");
  assert.equal((await httpsRequest(port, ca, "/oauth/token", form)).status, 400);
}

test("fresh OIDC issuer material serves a signed one-use HTTPS authorization exchange", async (t) => {
  const parent = await temporaryDirectory(t, "oce-oidc-provider-");
  const first = await material(t, parent);
  const second = await material(t, parent);
  for (const key of ["clientId", "clientSecret", "subject"] as const) {
    assert.notEqual(first.config[key], second.config[key]);
  }
  const ca = new X509Certificate(await readFile(join(first.directory, "ca.pem")));
  assert.notEqual(
    ca.fingerprint256,
    new X509Certificate(await readFile(join(second.directory, "ca.pem"))).fingerprint256,
  );
  assert.equal((await stat(join(first.directory, "server.key"))).mode & 0o777, 0o600);
  assert.equal((await readdir(first.directory)).includes("ca-key.pem"), false);
  // Disposing one run twice must leave the other run's identity and TLS usable.
  await second.dispose();
  await second.dispose();
  await assert.rejects(stat(second.directory), { code: "ENOENT" });
  const provider = await startOidcProvider(first.directory);
  try {
    const address = provider.server.address();
    assert.ok(address && typeof address !== "string");
    await exerciseProvider(address.port, first);
  } finally {
    await provider.close();
  }
  assert.equal(provider.server.listening, false);
});

test("OIDC issuer starts from projected-volume links and remains importable", async (t) => {
  const parent = await temporaryDirectory(t, "oce-oidc-projection-");
  const fixture = await material(t, parent);
  const projection = join(parent, "projected");
  const snapshot = join(projection, "..snapshot");
  await mkdir(snapshot, { recursive: true });
  const modules = ["oidc-provider-server.mjs", "oidc-provider.mjs", "id-token.mjs"];
  for (const name of modules) {
    await copyFile(new URL(`../helpers/${name}`, import.meta.url), join(snapshot, name));
  }
  const files = await readdir(fixture.directory);
  for (const name of files) {
    await copyFile(join(fixture.directory, name), join(snapshot, name));
  }
  // Kubernetes projects all entries through one timestamp directory. ESM resolves
  // the file link while argv[1] keeps it, which previously suppressed startup.
  await symlink("..snapshot", join(projection, "..data"));
  for (const name of [...modules, ...files]) {
    await symlink(`..data/${name}`, join(projection, name));
  }
  for (const entrypoint of [
    join(snapshot, "oidc-provider-server.mjs"),
    join(projection, "oidc-provider-server.mjs"),
  ]) {
    const child = spawn(process.execPath, [entrypoint, projection], {
      env: { PATH: process.env.PATH, OIDC_LISTEN_HOST: "127.0.0.1", OIDC_LISTEN_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const ready = await new Promise<{ ready: boolean; port: number }>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Projected OIDC issuer did not start")), 10_000);
        child.once("error", reject);
        child.once("close", () =>
          reject(new Error("Projected OIDC issuer exited before readiness")),
        );
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.includes("\n")) {
            try {
              resolve(JSON.parse(stdout.slice(0, stdout.indexOf("\n"))));
            } catch {
              reject(new Error("Invalid provider readiness"));
            }
          }
        });
      });
      assert.equal(ready.ready, true);
      const response = await httpsRequest(
        ready.port,
        await readFile(join(fixture.directory, "ca.pem")),
        "/.well-known/openid-configuration",
      );
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.text).issuer, fixture.config.issuer);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        const [code, signal] = await closed;
        assert.equal(code, 0);
        assert.equal(signal, null);
        assert.equal(stderr, "");
      } finally {
        clearTimeout(kill);
      }
    }
  }
  // A normal importer has its own argv[1]; importing must expose the API without listening.
  const importer = join(projection, "import.mjs");
  await writeFile(
    importer,
    'import { startOidcProvider } from "./oidc-provider-server.mjs"; if (typeof startOidcProvider !== "function") process.exit(1);',
  );
  const imported = await execute(process.execPath, [importer], { timeout: 5_000 });
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  const fromStdin = execute(process.execPath, ["--input-type=module", "-"], { timeout: 5_000 });
  assert.ok(fromStdin.child.stdin);
  fromStdin.child.stdin.end(`import ${JSON.stringify(pathToFileURL(importer).href)};`);
  const stdinOutput = await fromStdin;
  assert.equal(stdinOutput.stdout, "");
  assert.equal(stdinOutput.stderr, "");
});

test("OIDC material cleanup removes partial generation and preserves unrelated files", async (t) => {
  const parent = await temporaryDirectory(t, "oce-oidc-partial-");
  await writeFile(join(parent, "unrelated"), "retain");
  let calls = 0;
  await assert.rejects(
    createOidcProviderMaterial(parent, {
      hostname,
      redirectUri,
      run: async (command: string, args: string[]) => {
        calls += 1;
        // Fail a real OpenSSL invocation after the CA and leaf key were written.
        await execute(command, calls === 3 ? [...args, "-invalid-fixture-option"] : args, {
          timeout: 10_000,
        });
      },
    }),
    { code: 1 },
  );
  assert.equal(calls, 3);
  assert.deepEqual(await readdir(parent), ["unrelated"]);
  assert.equal(await readFile(join(parent, "unrelated"), "utf8"), "retain");
});
