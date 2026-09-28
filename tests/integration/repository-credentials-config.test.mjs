import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProtectedFile } from "../../apps/controller/src/composition/repository-credentials/protected-file.ts";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";

test("protected startup accepts RSA/TLS files without provider calls and rejects unsafe material", async (t) => {
  const { checkConfiguration } =
    await import("../../apps/controller/src/composition/repository-credentials/check-config.ts");
  const directory = await mkdtemp(join(tmpdir(), "repository-configuration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tls = await createTlsMaterial(t);
  const key = join(directory, "app.pem");
  const tlsKey = join(directory, "tls.key");
  const cert = join(directory, "tls.crt");
  const file = join(directory, "config.json");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  await writeFile(key, pem, { mode: 0o600 });
  await writeFile(tlsKey, tls.key, { mode: 0o600 });
  await writeFile(cert, tls.cert, { mode: 0o644 });
  const input = {
    gateway: {
      publicOrigin: "https://credentials.example",
      listen: "127.0.0.1:8443",
      tlsCertFile: cert,
      tlsKeyFile: tlsKey,
      controlSocket: join(directory, "control.sock"),
    },
    sessionPolicy: {
      maximumDurationSeconds: 172800,
      defaultProfile: "git-write",
      allowedProfiles: ["git-read", "git-write", "git-full"],
    },
    backend: {
      kind: "github-app",
      providerInstanceId: "production",
      configVersion: "1",
      appId: "12345",
      installationId: "41",
      repositoryId: "73",
      repository: "fixture/repository",
      privateKeyFile: key,
    },
  };
  async function save(value = input) {
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  }
  await save();
  const summary = await checkConfiguration(file);
  assert.equal(summary.valid, true);
  assert.equal(summary.maximumDurationSeconds, 172800);
  assert.deepEqual(summary.profiles, ["git-read", "git-write", "git-full"]);
  assert.equal(JSON.stringify(summary).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(summary).includes(directory), false);
  // Registry mode has a separate discriminator and binds its protected App key
  // to the same provider and duration policy consumed by controller composition.
  const registryFile = join(directory, "registry.json");
  const registry = {
    version: 1,
    backendId: "github-provider",
    providerInstanceId: "production",
    appId: "12345",
    githubInstallationId: "41",
    maximumDurationSeconds: 172800,
    repositories: [
      {
        repositoryRef: "source",
        repositoryId: "73",
        repository: "fixture/repository",
        namespaces: [{ namespaceId: "namespace-a", profiles: ["git-read", "git-write"] }],
      },
    ],
  };
  await writeFile(registryFile, JSON.stringify(registry), { mode: 0o600 });
  const bound = {
    ...input,
    backend: {
      kind: "github-app-registry",
      backendId: "github-provider",
      registryFile,
      privateKeyFile: key,
    },
  };
  await save(bound);
  assert.deepEqual(await checkConfiguration(file), summary);
  for (const invalid of [
    { ...bound, backend: { ...bound.backend, backendId: "another-provider" } },
    { ...bound, backend: { ...bound.backend, appId: "12345" } },
    { ...bound, sessionPolicy: { ...bound.sessionPolicy, maximumDurationSeconds: 172801 } },
    { ...bound, backend: { ...bound.backend, registryFile: key } },
  ]) {
    await save(invalid);
    await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  }
  await writeFile(registryFile, JSON.stringify({ ...registry, privateKey: pem }));
  await save(bound);
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await writeFile(registryFile, JSON.stringify(registry));
  const registryLink = join(directory, "registry-link.json");
  await symlink(registryFile, registryLink);
  await save({ ...bound, backend: { ...bound.backend, registryFile: registryLink } });
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });

  // A writable earlier ancestor can select a different trusted-owned directory
  // without modifying either private configuration file. Reject that ancestry
  // before opening material, even when the immediate parent remains private.
  const shared = join(directory, "shared");
  const active = join(shared, "active");
  const previous = join(shared, "previous");
  const selectedFile = join(active, "config.json");
  await mkdir(shared, { mode: 0o700 });
  for (const [selected, profile] of [
    [active, "git-read"],
    [previous, "git-full"],
  ]) {
    await mkdir(selected, { mode: 0o700 });
    await writeFile(
      join(selected, "config.json"),
      JSON.stringify({
        ...input,
        sessionPolicy: {
          ...input.sessionPolicy,
          defaultProfile: profile,
          allowedProfiles: [profile],
        },
      }),
      { mode: 0o600 },
    );
  }
  assert.deepEqual((await checkConfiguration(selectedFile)).profiles, ["git-read"]);
  await chmod(shared, 0o777);
  await assert.rejects(checkConfiguration(selectedFile), { message: "invalid-configuration" });
  // A sticky directory is trusted only when root owns it. The system temporary
  // ancestor remains supported, but a service-owned writable ancestor cannot
  // gain that exception merely by setting its sticky bit.
  if (process.getuid?.() !== 0) {
    await chmod(shared, 0o1777);
    await assert.rejects(checkConfiguration(selectedFile), { message: "invalid-configuration" });
    await chmod(shared, 0o777);
  }
  await rename(active, join(shared, "retired"));
  await rename(previous, active);
  await assert.rejects(checkConfiguration(selectedFile), { message: "invalid-configuration" });
  await chmod(shared, 0o700);
  assert.deepEqual((await checkConfiguration(selectedFile)).profiles, ["git-full"]);
  // Removed and unknown profiles must fail at trusted startup, before serving
  // any sessions, even when they are explicitly named in the operator policy.
  for (const profile of ["read-write", "app-full"]) {
    await save({
      ...input,
      sessionPolicy: {
        ...input.sessionPolicy,
        defaultProfile: profile,
        allowedProfiles: [profile],
      },
    });
    await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  }
  await save();
  await chmod(key, 0o644);
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await chmod(key, 0o600);
  const link = join(directory, "link.pem");
  await symlink(key, link);
  await save({ ...input, backend: { ...input.backend, privateKeyFile: link } });
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await save({ ...input, backend: { ...input.backend, privateKeyFile: directory } });
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await save();
  await writeFile(key, "x".repeat(65537));
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await writeFile(key, ec.privateKey.export({ type: "pkcs8", format: "pem" }));
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await writeFile(key, pem);
  await chmod(file, 0o644);
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await chmod(file, 0o600);
  await chmod(directory, 0o777);
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  await chmod(directory, 0o700);
});
test("service admission bounds are finite and retain an explicit long-task policy", async () => {
  const { validateServiceConfig } =
    await import("../../apps/controller/src/drivers/repo/credentials/configuration.ts");
  const input = {
    gateway: {
      publicOrigin: "https://credentials.example",
      listen: "127.0.0.1:8443",
      controlSocket: "/run/credentials/control.sock",
    },
    sessionPolicy: {
      maximumDurationSeconds: 172800,
      defaultProfile: "git-write",
      allowedProfiles: ["git-write"],
    },
  };
  assert.equal(validateServiceConfig(input).sessionPolicy.maximumDurationSeconds, 172800);
  for (const value of [0, -1, Infinity, NaN]) {
    assert.throws(() => validateServiceConfig({ ...input, limits: { exchangeMs: value } }));
  }
  assert.throws(() =>
    validateServiceConfig({
      ...input,
      sessionPolicy: { ...input.sessionPolicy, maximumDurationSeconds: undefined },
    }),
  );
  assert.throws(() =>
    validateServiceConfig({
      ...input,
      gateway: { ...input.gateway, publicOrigin: "https://credentials.example/alias" },
    }),
  );
  assert.throws(() => validateServiceConfig({ ...input, limits: { providerActions: 2 } }));
});

test("protected file transfers its candidate only after descriptor cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "protected-file-transfer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "input");
  const contents = "protected file fixture";
  await writeFile(path, contents, { mode: 0o600 });

  for (const failure of [undefined, "read", "close"]) {
    await t.test(
      failure ? `${failure} failure disposes owned buffers` : "successful transfer",
      async (t) => {
        const open = fs.open;
        const from = Buffer.from;
        let scratch;
        let candidate;
        let closed = false;
        t.after(() => {
          t.mock.restoreAll();
          syncBuiltinESMExports();
        });
        // Read a real protected file and close the real descriptor. Faults occur at
        // the filesystem boundary; the production reader still owns every buffer.
        t.mock.method(fs, "open", async (...args) => {
          const handle = await open(...args);
          const read = handle.read;
          const close = handle.close;
          t.mock.method(handle, "read", async (...args) => {
            scratch = args[0];
            const result = await read.apply(handle, args);
            if (failure === "read") {
              throw new Error("fixture read failed");
            }
            return result;
          });
          t.mock.method(handle, "close", async () => {
            await close.call(handle);
            closed = true;
            if (failure === "close") {
              throw new Error("fixture close failed");
            }
          });
          return handle;
        });
        t.mock.method(Buffer, "from", (...args) => {
          const result = from(...args);
          if (Buffer.isBuffer(args[0]) && args[0].buffer === scratch?.buffer) {
            candidate = result;
          }
          return result;
        });
        syncBuiltinESMExports();
        const result = await readProtectedFile(path, 1024);
        assert.equal(closed, true);
        assert.ok(scratch);
        assert.ok(scratch.every((byte) => byte === 0));
        if (failure) {
          assert.deepEqual(result, { ok: false });
          if (failure === "close") {
            assert.ok(candidate);
            assert.ok(candidate.every((byte) => byte === 0));
          } else {
            assert.equal(candidate, undefined);
          }
        } else {
          assert.equal(result.ok, true);
          assert.equal(result.bytes, candidate);
          assert.equal(result.bytes.toString(), contents);
          // Successful transfer leaves disposal with the actual caller.
          result.bytes.fill(0);
          assert.ok(candidate.every((byte) => byte === 0));
        }
      },
    );
  }
});
