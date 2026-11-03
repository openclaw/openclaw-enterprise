import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { prepareProjectedInputs } from "../../apps/controller/src/composition/repository-credentials/projected-inputs.ts";
import { loadConfiguration } from "../../apps/controller/src/composition/repository-credentials/config.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import {
  createTlsMaterial,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";

async function project(directory, generation, values) {
  const path = join(directory, generation);
  await mkdir(path, { mode: 0o755 });
  for (const [name, value] of Object.entries(values)) {
    await writeFile(join(path, name), value, { mode: 0o440 });
  }
  await symlink(generation, join(directory, "..data-next"));
  await rename(join(directory, "..data-next"), join(directory, "..data"));
  for (const name of Object.keys(values)) {
    try {
      await symlink(`..data/${name}`, join(directory, name));
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  return path;
}

async function fixture(t) {
  // Canonicalize macOS's /var alias.
  const directory = await realpath(await temporaryDirectory(t, "rp-"));
  const inputsDirectory = join(directory, "inputs");
  const registryDirectory = join(directory, "registry");
  const privateVolume = join(directory, "private-volume");
  // The control socket needs a short path, so its volume lives apart from the inputs.
  const controlVolume = join(
    await socketDirectory(t, "rp-control-", { longest: "control/private/control.sock" }),
    "control",
  );
  for (const path of [inputsDirectory, registryDirectory, privateVolume, controlVolume]) {
    await mkdir(path, { mode: 0o755 });
  }
  // This filesystem fixture supplies trusted, non-writable ancestors. Actual
  // Kubernetes volume ownership and modes require the installed chart check.
  const options = {
    inputsDirectory,
    registryFile: join(registryDirectory, "registry.json"),
    privateDirectory: join(privateVolume, "private"),
    controlSocket: join(controlVolume, "private", "control.sock"),
    expectedOrigin: "https://credentials.example.test",
    backendId: "github-primary",
    authority: "prepared-git",
  };
  const tls = await createTlsMaterial(t);
  const config = {
    gateway: {
      publicOrigin: options.expectedOrigin,
      listen: "0.0.0.0:8443",
      controlSocket: options.controlSocket,
      tlsCertFile: join(inputsDirectory, "tls.crt"),
      tlsKeyFile: join(inputsDirectory, "tls.key"),
    },
    backend: {
      kind: "github-prepared-git-registry",
      backendId: options.backendId,
      registryFile: options.registryFile,
    },
    sessionPolicy: {
      maximumDurationSeconds: 3600,
      defaultProfile: "git-write",
      allowedProfiles: ["git-write"],
    },
  };
  const registry = {
    version: 1,
    backendId: options.backendId,
    providerInstanceId: "github-production",
    appId: "123",
    githubInstallationId: "456",
    maximumDurationSeconds: 3600,
    repositories: [
      {
        repositoryRef: "example-repository",
        repositoryId: "789",
        repository: "example/repo",
        namespaces: [
          {
            namespaceId: "10000000-0000-4000-8000-000000000001",
            profiles: ["git-write"],
            transport: "git-only",
            pushRefAllowlist: ["refs/heads/agent-work"],
          },
        ],
      },
    ],
  };
  const values = {
    "config.json": JSON.stringify(config),
    "tls.crt": tls.cert,
    "tls.key": tls.key,
  };
  const generation = await project(inputsDirectory, "..generation-one", values);
  const registryGeneration = await project(registryDirectory, "..registry-one", {
    "registry.json": JSON.stringify(registry),
  });
  const clock = createSystemClock();
  return {
    options,
    config,
    registry,
    values,
    generation,
    registryGeneration,
    clock,
    prepare: () => prepareProjectedInputs(options, clock),
  };
}

test("projected service inputs become owned private files accepted by the real loader, including restart", async (t) => {
  const f = await fixture(t);
  // The protected loader must still reject kubelet's symlinked entrypoints.
  await assert.rejects(loadConfiguration(join(f.options.inputsDirectory, "config.json"), f.clock), {
    message: "invalid-configuration",
  });
  const loaded = await f.prepare();
  assert.equal(loaded.config.gateway.publicOrigin, f.options.expectedOrigin);
  assert.equal(loaded.config.gateway.listen, "0.0.0.0:8443");
  loaded.close();
  for (const name of Object.keys(f.values).concat("registry.json")) {
    const info = await lstat(join(f.options.privateDirectory, name));
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.uid, process.getuid());
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.nlink, 1);
  }
  assert.equal((await lstat(f.options.privateDirectory)).mode & 0o777, 0o700);
  const copied = JSON.parse(
    await readFile(join(f.options.privateDirectory, "config.json"), "utf8"),
  );
  assert.equal(copied.backend.privateKeyFile, undefined);
  assert.equal(copied.backend.registryFile, join(f.options.privateDirectory, "registry.json"));
  // A projected generation switch takes effect together on the next process
  // start, and owned files left in the memory volume are safely replaced.
  const changed = {
    ...f.config,
    sessionPolicy: { ...f.config.sessionPolicy, maximumDurationSeconds: 1800 },
  };
  await project(f.options.inputsDirectory, "..generation-two", {
    ...f.values,
    "config.json": JSON.stringify(changed),
  });
  const restarted = await f.prepare();
  assert.equal(restarted.config.sessionPolicy.maximumDurationSeconds, 1800);
  restarted.close();
});

test("prepared projection loads without an App key and refuses an authority mismatch", async (t) => {
  const f = await fixture(t);
  f.options.authority = "prepared-git";
  await project(join(f.options.registryFile, ".."), "..prepared-registry", {
    "registry.json": JSON.stringify({
      ...f.registry,
      repositories: f.registry.repositories.map((repository) => ({
        ...repository,
        namespaces: repository.namespaces.map((policy) => ({
          ...policy,
          transport: "git-only",
          pushRefAllowlist: ["refs/heads/agent-work"],
        })),
      })),
    }),
  });
  const backend = {
    kind: "github-prepared-git-registry",
    backendId: f.options.backendId,
    registryFile: f.options.registryFile,
  };
  // The mounted generation contains only the service configuration and TLS.
  await project(f.options.inputsDirectory, "..prepared", {
    "config.json": JSON.stringify({ ...f.config, backend }),
    "tls.crt": f.values["tls.crt"],
    "tls.key": f.values["tls.key"],
  });
  const loaded = await f.prepare();
  assert.equal(loaded.authority, "github-prepared-git-registry");
  assert.equal(loaded.repositoryDescriptions, undefined);
  assert.equal(loaded.config.gateway.controlSocket, f.options.controlSocket);
  loaded.close();
  assert.deepEqual((await readdir(f.options.privateDirectory)).sort(), [
    "config.json",
    "registry.json",
    "tls.crt",
    "tls.key",
  ]);
  const copied = JSON.parse(
    await readFile(join(f.options.privateDirectory, "config.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(copied.backend, "privateKeyFile"), false);
  f.options.authority = "github-app";
  await assert.rejects(f.prepare(), /signing gateway retired/);
  f.options.authority = "prepared-git";
  await project(f.options.inputsDirectory, "..wrong-authority", {
    ...f.values,
    "config.json": JSON.stringify({
      ...f.config,
      backend: { ...f.config.backend, kind: "github-app-registry" },
    }),
  });
  await assert.rejects(f.prepare(), /signing gateway retired/);
});

test("projection startup derives the broker origin from the trusted deployment argument", async (t) => {
  const f = await fixture(t);
  const gateway = { ...f.config.gateway };
  delete gateway.publicOrigin;
  await project(f.options.inputsDirectory, "..derived-origin", {
    ...f.values,
    "config.json": JSON.stringify({ ...f.config, gateway }),
  });
  const loaded = await f.prepare();
  assert.equal(loaded.config.gateway.publicOrigin, f.options.expectedOrigin);
  loaded.close();
});

test("projection startup rejects a serving certificate without the broker host", async (t) => {
  const f = await fixture(t);
  f.options.expectedOrigin = "https://git.example.test";
  const gateway = { ...f.config.gateway, publicOrigin: f.options.expectedOrigin };
  await project(f.options.inputsDirectory, "..wrong-cert-host", {
    ...f.values,
    "config.json": JSON.stringify({ ...f.config, gateway }),
  });
  await assert.rejects(f.prepare(), { message: "invalid-projected-inputs" });
});

test("projection startup rejects a writable ancestor above its private snapshot", async (t) => {
  const f = await fixture(t);
  const loaded = await f.prepare();
  loaded.close();
  const privateVolume = join(f.options.privateDirectory, "..");
  // Keeping the immediate snapshot directory private does not protect it from
  // replacement through a writable parent volume. Startup must fail closed.
  await chmod(privateVolume, 0o770);
  assert.equal((await lstat(f.options.privateDirectory)).mode & 0o777, 0o700);
  await assert.rejects(f.prepare(), { message: "invalid-projected-inputs" });
  await chmod(privateVolume, 0o755);
  const restored = await f.prepare();
  restored.close();
});

test("projection startup bounds service drain within the worker Pod termination grace", async (t) => {
  const f = await fixture(t);
  for (const shutdownGraceMs of [60000, 60001, 90000]) {
    await project(f.options.inputsDirectory, `..shutdown-${shutdownGraceMs}`, {
      ...f.values,
      "config.json": JSON.stringify({ ...f.config, limits: { shutdownGraceMs } }),
    });
    if (shutdownGraceMs === 60000) {
      const loaded = await f.prepare();
      assert.equal(loaded.config.limits.shutdownGraceMs, shutdownGraceMs);
      loaded.close();
      continue;
    }
    // These are valid standalone service limits, but this topology must leave
    // time to report unresolved cleanup before Kubernetes' fixed 75s cutoff.
    await assert.rejects(
      f.prepare().then((loaded) => {
        loaded.close();
        return loaded;
      }),
      { message: "invalid-projected-inputs" },
    );
    const standalone = await loadConfiguration(
      join(f.options.privateDirectory, "config.json"),
      f.clock,
    );
    assert.equal(standalone.config.limits.shutdownGraceMs, shutdownGraceMs);
    standalone.close();
  }
});

test("projection startup rejects mismatched deployment bindings and invalid actual key material", async (t) => {
  const f = await fixture(t);
  const loaded = await f.prepare();
  loaded.close();
  let generation = 0;
  for (const config of [
    {
      ...f.config,
      gateway: { ...f.config.gateway, publicOrigin: "https://different.example.test" },
    },
    { ...f.config, gateway: { ...f.config.gateway, listen: "0.0.0.0:443" } },
    { ...f.config, gateway: { ...f.config.gateway, controlSocket: "/tmp/other.sock" } },
    { ...f.config, backend: { ...f.config.backend, backendId: "different-provider" } },
    // The development token authority has no Kubernetes path; the projection
    // composition never passes the process opt-in and requires the registry kind.
    {
      ...f.config,
      backend: {
        kind: "github-token",
        providerInstanceId: "github-production",
        configVersion: "1",
        repositoryId: "789",
        repository: "example/repo",
        tokenFile: join(f.options.privateDirectory, "tls.key"),
        developmentOnly: true,
        pushRefAllowlist: ["refs/heads/agent/*"],
      },
    },
  ]) {
    await project(f.options.inputsDirectory, `..invalid-${generation++}`, {
      ...f.values,
      "config.json": JSON.stringify(config),
    });
    await assert.rejects(f.prepare(), { message: "invalid-projected-inputs" });
  }
  await project(f.options.inputsDirectory, "..invalid-key", {
    ...f.values,
    "tls.key": "not a TLS key",
  });
  await assert.rejects(f.prepare(), { message: "invalid-projected-inputs" });
  await project(f.options.inputsDirectory, "..restored", f.values);
  const badRegistry = { ...f.registry, backendId: "different-provider" };
  await unlink(join(f.registryGeneration, "registry.json"));
  await writeFile(join(f.registryGeneration, "registry.json"), JSON.stringify(badRegistry), {
    mode: 0o440,
  });
  await assert.rejects(f.prepare(), { message: "invalid-projected-inputs" });
});

test("projection startup preserves unexpected stale entries and rejects unsafe projected files", async (t) => {
  const f = await fixture(t);
  const loaded = await f.prepare();
  loaded.close();
  const saved = await readFile(join(f.options.privateDirectory, "config.json"));
  const unexpected = join(f.options.privateDirectory, "unrelated");
  await writeFile(unexpected, "preserve", { mode: 0o600 });
  await assert.rejects(f.prepare(), { message: "invalid-projected-inputs" });
  assert.deepEqual(await readFile(join(f.options.privateDirectory, "config.json")), saved);
  assert.equal(await readFile(unexpected, "utf8"), "preserve");
  await unlink(unexpected);
  const key = join(f.generation, "tls.key");
  const privateKey = join(f.options.privateDirectory, "tls.key");
  await unlink(privateKey);
  await symlink(key, privateKey);
  await assert.rejects(f.prepare(), { message: "invalid-projected-inputs" });
  assert.equal(await readlink(privateKey), key);
  assert.ok((await readFile(key)).equals(f.values["tls.key"]));
  await unlink(privateKey);
  await writeFile(privateKey, f.values["tls.key"], { flag: "wx", mode: 0o600 });
  await unlink(key);
  await symlink(join(f.options.privateDirectory, "tls.key"), key);
  await assert.rejects(f.prepare(), { message: "invalid-projected-inputs" });
  await unlink(key);
  await writeFile(key, Buffer.alloc(65537), { flag: "wx", mode: 0o440 });
  await assert.rejects(f.prepare(), { message: "invalid-projected-inputs" });
  assert.equal((await readdir(f.options.privateDirectory)).length, 4);
});
