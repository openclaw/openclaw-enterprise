import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appRoot, appExtension, appModule, credentialClientPath } from "./runtime.mjs";
import { cleanEnvironment, run, temporaryDirectory } from "./process.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Publish real session encoding and render the same native include used by initialization. */
export async function createNativeClientMaterial(t, entries, { ca, root } = {}) {
  root ??= await temporaryDirectory(t, "repository-native-material-");
  await mkdir(join(root, "sessions"), { mode: 0o700 });
  const { readClientConfiguration, writeClientConfiguration } = await appModule(
    "drivers/repo/github/credentials/client/config",
  );
  const { readRuntimeRepositoryManifest } = await appModule(
    "drivers/repo/github/credentials/client/manifest",
  );
  const { renderNativeGitConfiguration } = await appModule(
    "drivers/repo/github/credentials/client/native-git",
  );
  const bindings = [];
  for (const { opened, clientDirectory, repositoryRef, publicCa = ca } of entries) {
    const configuration = opened
      ? {
          sessionId: opened.session.sessionId,
          deadlineWallMs: opened.session.deadlineWallMs,
          client: opened.client,
        }
      : await readClientConfiguration(clientDirectory);
    const directory = join(root, "sessions", hash([repositoryRef, configuration.sessionId]));
    if (opened) {
      await writeClientConfiguration(opened, directory, publicCa);
    } else {
      // Preserve the established clientDirectory-only fixture consumer, including
      // live qualification, without loading its bearer into the fixture process.
      await cp(clientDirectory, directory, { recursive: true, errorOnExist: true, force: false });
    }
    bindings.push({
      repositoryRef,
      sessionId: configuration.sessionId,
      deadlineWallMs: configuration.deadlineWallMs,
      directory,
      client: configuration.client,
    });
  }
  bindings.sort((a, b) =>
    a.repositoryRef < b.repositoryRef ? -1 : a.repositoryRef > b.repositoryRef ? 1 : 0,
  );
  const manifest = {
    version: 1,
    generation: hash(bindings.map(({ repositoryRef, sessionId }) => [repositoryRef, sessionId])),
    bindings,
  };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  const helper = join(appRoot, `drivers/repo/github/credentials/client/git-helper.${appExtension}`);
  let hooks;
  if (bindings.some(({ client }) => client.pushRefAllowlist !== undefined)) {
    // Executable test wrappers belong to a separate image stand-in, never to
    // the private material generation. They run the actual client dispatcher.
    hooks = await temporaryDirectory(t, "repository-native-hooks-");
    const names = JSON.parse(
      await readFile(
        new URL("../../../deploy/runtime/repository-credentials/hooks.json", import.meta.url),
        "utf8",
      ),
    );
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const name of names) {
      await writeFile(
        join(hooks, name),
        "#!/bin/sh\nexec " +
          quote(process.execPath) +
          " " +
          quote(credentialClientPath("hook-dispatch")) +
          " " +
          name +
          ' "$@"\n',
        { mode: 0o755 },
      );
    }
  }
  const config = await renderNativeGitConfiguration(
    await readRuntimeRepositoryManifest(root),
    root,
    { node: process.execPath, helper, ...(hooks === undefined ? {} : { hooks }) },
  );
  await writeFile(join(root, "gitconfig"), config, { mode: 0o600 });
  return { root, manifest, config, helper, hooks };
}

/** Execute stock Git with a real native include; gh retains its private session configuration. */
export async function runPinnedClients(t, fixture, { signal = t.signal } = {}) {
  const directory = await temporaryDirectory(t, "repository-credentials-client-work-");
  const launcher = join(appRoot, `drivers/repo/github/credentials/client/launch.${appExtension}`);
  const material = await createNativeClientMaterial(t, [
    { clientDirectory: fixture.clientDirectory, repositoryRef: "fixture" },
  ]);
  const env = cleanEnvironment({
    HOME: directory,
    GIT_CONFIG_SYSTEM: join(material.root, "gitconfig"),
  });
  delete env.GIT_CONFIG_NOSYSTEM;
  const invoke = (client, args, options = {}) =>
    run(
      client === "git" ? "/usr/bin/git" : process.execPath,
      client === "git" ? args : [launcher, fixture.clientDirectory, "gh", ...args],
      { env, cwd: directory, signal, ...options },
    );
  const version = await run("gh", ["--version"], { env, signal });
  assert.match(version.stdout, /^gh version 2\.100\.0\b/);
  return {
    directory,
    material,
    git: (args, options) => invoke("git", args, options),
    gh: (args, options) => invoke("gh", args, options),
    async json(name, value) {
      const path = join(directory, name);
      await writeFile(path, JSON.stringify(value));
      return path;
    },
  };
}
