import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProtectedFile } from "../../apps/controller/src/composition/repository-credentials/protected-file.ts";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";

test("protected startup accepts RSA/TLS files without provider calls and rejects unsafe material", async (t) => {
  const { checkConfiguration } =
    await import("../../apps/controller/src/composition/repository-credentials/check-config.ts");
  const directory = await mkdtemp(join(tmpdir(), "repository-configuration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tls = await createTlsMaterial(t);
  const controlDirectory = await socketDirectory(t, "rcs-config-");
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
      controlSocket: join(controlDirectory, "control.sock"),
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
  assert.equal(summary.authority, "github-app");
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
  assert.deepEqual(await checkConfiguration(file), {
    ...summary,
    authority: "github-app-registry",
  });
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
test("development token authority loads only with both opt-ins and never reaches production inputs", async (t) => {
  const { checkConfiguration } =
    await import("../../apps/controller/src/composition/repository-credentials/check-config.ts");
  const directory = await mkdtemp(join(tmpdir(), "repository-token-configuration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tls = await createTlsMaterial(t);
  const controlDirectory = await socketDirectory(t, "rcs-config-");
  const tokenFile = join(directory, "token");
  const tlsKey = join(directory, "tls.key");
  const cert = join(directory, "tls.crt");
  const file = join(directory, "config.json");
  // Synthetic sentinel with the `gh auth token` prefix and its trailing newline.
  const token = `gho_${"s".repeat(36)}`;
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await writeFile(tlsKey, tls.key, { mode: 0o600 });
  await writeFile(cert, tls.cert, { mode: 0o644 });
  const input = {
    gateway: {
      publicOrigin: "https://credentials.example",
      listen: "127.0.0.1:8443",
      tlsCertFile: cert,
      tlsKeyFile: tlsKey,
      controlSocket: join(controlDirectory, "control.sock"),
    },
    sessionPolicy: {
      maximumDurationSeconds: 28800,
      defaultProfile: "git-write",
      allowedProfiles: ["git-read", "git-write"],
    },
    limits: { gitPushInputBytes: 67108864 },
    backend: {
      kind: "github-token",
      providerInstanceId: "github-local-dev",
      configVersion: "1",
      repositoryId: "73",
      repository: "fixture/repository",
      tokenFile,
      developmentOnly: true,
      pushRefAllowlist: ["refs/heads/agent/*"],
    },
  };
  const save = (value = input) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
  const development = { developmentAuthority: true };
  await save();
  // The config literal alone is not enough: the process flag is the second opt-in.
  await assert.rejects(checkConfiguration(file), { message: "invalid-configuration" });
  const summary = await checkConfiguration(file, development);
  assert.deepEqual(summary, {
    valid: true,
    gatewayOrigin: "https://credentials.example",
    profiles: ["git-read", "git-write"],
    maximumDurationSeconds: 28800,
    authority: "github-token-development",
    tokenClass: "oauth",
  });
  assert.equal(JSON.stringify(summary).includes(token), false);
  assert.equal(JSON.stringify(summary).includes(directory), false);
  // No App key is read for this kind; none exists in the input directory.
  assert.deepEqual((await readdir(directory)).sort(), [
    "config.json",
    "tls.crt",
    "tls.key",
    "token",
  ]);
  for (const invalid of [
    { ...input, sessionPolicy: { ...input.sessionPolicy, maximumDurationSeconds: 28801 } },
    // Token pushes are buffered for inspection, so the 256 MiB service default is refused.
    { ...input, limits: undefined },
    { ...input, limits: { gitPushInputBytes: 67108865 } },
    { ...input, backend: { ...input.backend, developmentOnly: false } },
    { ...input, backend: { ...input.backend, privateKeyFile: tokenFile } },
  ]) {
    await save(invalid);
    await assert.rejects(checkConfiguration(file, development), {
      message: "invalid-configuration",
    });
  }
  await save();
  // Token file hygiene matches the App key: private mode, no symlink, not empty.
  await chmod(tokenFile, 0o644);
  await assert.rejects(checkConfiguration(file, development), { message: "invalid-configuration" });
  await chmod(tokenFile, 0o600);
  const link = join(directory, "token-link");
  await symlink(tokenFile, link);
  await save({ ...input, backend: { ...input.backend, tokenFile: link } });
  await assert.rejects(checkConfiguration(file, development), { message: "invalid-configuration" });
  await rm(link);
  await save();
  for (const contents of ["\n", "\r\n", "", `${token}\n\n`, `${token} \n`, `${token}\r\r\n`]) {
    await writeFile(tokenFile, contents);
    await assert.rejects(checkConfiguration(file, development), {
      message: "invalid-configuration",
    });
  }
  for (const contents of [token, `${token}\r\n`]) {
    await writeFile(tokenFile, contents);
    assert.equal((await checkConfiguration(file, development)).tokenClass, "oauth");
  }
  // The flag does not change App configurations, which still reject token fields.
  const app = {
    ...input,
    backend: {
      kind: "github-app",
      providerInstanceId: "production",
      configVersion: "1",
      appId: "12345",
      installationId: "41",
      repositoryId: "73",
      repository: "fixture/repository",
      privateKeyFile: join(directory, "app.pem"),
    },
  };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(app.backend.privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  await save(app);
  assert.equal((await checkConfiguration(file)).authority, "github-app");
  assert.equal((await checkConfiguration(file, development)).authority, "github-app");
  await save({ ...app, backend: { ...app.backend, tokenFile } });
  await assert.rejects(checkConfiguration(file, development), { message: "invalid-configuration" });
});

test("production deployment inputs never name the development token authority", async () => {
  // Lint: only files whose names contain "development" may enable the kind.
  const root = new URL("../../", import.meta.url);
  const files = async (path) => {
    const entries = await readdir(new URL(path, root), { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  };
  const checked = [
    ...(await files("deploy/helm/")),
    ...(await files("deploy/examples/production/")),
    ...["compose.yaml", "service-config.json", "installation.fragment.yaml", "registry.json"].map(
      (name) => new URL(`deploy/examples/repository-credentials/${name}`, root).pathname,
    ),
  ];
  assert.ok(checked.length > 10);
  for (const path of checked) {
    const text = await readFile(path, "utf8");
    for (const marker of ["github-token", "developmentOnly", "development-authority"]) {
      assert.equal(text.includes(marker), false, `${path} names ${marker}`);
    }
  }
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
  // Every guard refuses with the same message, so each input breaks exactly one guard:
  // removing any guard lets its input through.
  const gateway = (patch) => ({ ...input, gateway: { ...input.gateway, ...patch } });
  const policy = (patch) => ({ ...input, sessionPolicy: { ...input.sessionPolicy, ...patch } });
  const profiles = Array.from({ length: 16 }, (_, index) => `profile-${index}`);
  for (const changed of [
    ...[0, -1, Infinity, NaN].map((exchangeMs) => ({ ...input, limits: { exchangeMs } })),
    { ...input, limits: { providerActions: 2 } },
    { ...input, limits: { unknownLimit: 1 } },
    { ...input, extra: true },
    gateway({ publicOrigin: "https://credentials.example/alias" }),
    gateway({ listen: "127.0.0.1:0" }),
    gateway({ controlSocket: "run/credentials/control.sock" }),
    policy({ maximumDurationSeconds: undefined }),
    policy({ maximumDurationSeconds: Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1 }),
    policy({ allowedProfiles: ["git-write", ...profiles] }),
    policy({ allowedProfiles: ["git-write", "git-write"] }),
    policy({ allowedProfiles: ["git-write", "x".repeat(129)] }),
  ]) {
    assert.throws(() => validateServiceConfig(changed), { message: "invalid-configuration" });
  }
  assert.throws(() => validateServiceConfig(null), { message: "invalid-configuration" });
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
