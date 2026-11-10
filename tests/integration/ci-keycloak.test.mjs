import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { keycloakRealmFile, prepareKeycloak } from "../../scripts/ci/keycloak.mjs";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cleanupPath = join(repositoryRoot, "scripts/ci/cleanup.mjs");

function fixture(t) {
  return temporaryDirectory(t, "ci-keycloak-test-");
}

test("the Keycloak realm fixture holds no secret", async () => {
  const realm = JSON.parse(await readFile(keycloakRealmFile, "utf8"));
  const [client] = realm.clients;
  // Every credential is a placeholder that preparation fills from per-run values.
  assert.match(client.secret, /^\$\{[A-Z_]+\}$/);
  assert.deepEqual(
    client.redirectUris.map((uri) => /^\$\{[A-Z_]+\}$/.test(uri)),
    [true],
  );
  for (const user of realm.users) {
    assert.deepEqual(
      user.credentials.map((credential) => /^\$\{[A-Z_]+\}$/.test(credential.value)),
      [true],
      user.username,
    );
  }
});

test("Keycloak preparation refuses an unset realm placeholder before starting a container", async (t) => {
  const root = await fixture(t);
  const realm = JSON.parse(await readFile(keycloakRealmFile, "utf8"));
  realm.clients[0].attributes["post.logout.redirect.uris"] = "${OCE_KEYCLOAK_UNSET_FOR_TEST}";
  const realmFile = join(root, "realm.json");
  await writeFile(realmFile, JSON.stringify(realm));
  const commands = [];
  const resources = [];
  // Keycloak would import the unset placeholder as literal text, so the lane must stop.
  await assert.rejects(
    prepareKeycloak({
      stateDirectory: root,
      name: "openclaw-ci-kc-test-0123456789ab",
      realmFile,
      execFile: async (command, args) => {
        commands.push([command, ...args]);
        return { stdout: "", stderr: "" };
      },
      ensureImage: async () => {},
      portAccepts: async () => false,
      reservePort: async () => 40443,
      registerResource: async (details) => {
        resources.push(details);
        return details;
      },
      saveState: async () => {},
    }),
    /^Error: Keycloak placeholders step failed: .*OCE_KEYCLOAK_UNSET_FOR_TEST/,
  );
  assert.deepEqual(commands, []);
  // The resource is recorded first, so cleanup still runs after the refusal.
  assert.equal(resources.length, 1);
});

test("cleanup removes the owned Keycloak container and its private directory", async (t) => {
  const root = await fixture(t);
  const bin = join(root, "bin");
  await mkdir(bin);
  const log = join(root, "docker.log");
  await writeCommand(bin, "docker", "exit 0\n", { log });
  const prefix = "openclaw-ci-local-keycloak1234";
  const name = `openclaw-ci-kc-${prefix}-0123456789ab`;
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "secrets.json"), "{}", { mode: 0o600 });
  const statePath = join(root, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      repositoryRoot,
      lane: "keycloak-oidc",
      prefix,
      resources: [
        { id: "keycloak-server-1", kind: "keycloak-server", owner: prefix, name, directory },
      ],
    }),
    { mode: 0o600 },
  );

  const result = spawnSync(process.execPath, [cleanupPath, "--state", statePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, OCC_DOCKER_BIN: join(bin, "docker") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await commandCalls(log), [
    `rm --force --volumes ${name}`,
    `ps --all --filter name=^${name}$ --format {{.Names}}`,
  ]);
  await assert.rejects(stat(directory), { code: "ENOENT" });
  await assert.rejects(stat(statePath), { code: "ENOENT" });
});

test("Keycloak preparation accepts dual loopback DNS but rejects remote and IPv6-only answers", async (t) => {
  for (const [addresses, accepted] of [
    [["127.0.0.1", "::1"], true],
    [["127.0.0.1", "192.0.2.1"], false],
    [["::1"], false],
  ]) {
    await t.test(addresses.join(","), async (t) => {
      const root = await fixture(t);
      const commands = [];
      // Exercise real certificate preparation and host gating, stopping at the
      // container boundary; the live lane separately proves HTTPS readiness.
      await assert.rejects(
        prepareKeycloak({
          stateDirectory: root,
          name: "openclaw-ci-kc-dns-test-0123456789ab",
          ensureImage: async () => {},
          portAccepts: async () => false,
          reservePort: async () => 40443,
          registerResource: async (details) => details,
          saveState: async () => {},
          lookupAll: async () => addresses.map((address) => ({ address })),
          log: () => {},
          execFile: async (command, args) => {
            commands.push(command);
            if (command === "openssl") {
              return promisify(execFile)(command, args);
            }
            if (command === "sudo") {
              return { stdout: "", stderr: "" };
            }
            throw new Error("test container boundary");
          },
        }),
        accepted
          ? /Keycloak start step failed: test container boundary/
          : /Keycloak hosts step failed:.*not restricted to loopback/,
      );
      assert.equal(commands.includes("sudo"), !accepted);
      assert.equal(commands.includes("docker"), accepted);
    });
  }
});
