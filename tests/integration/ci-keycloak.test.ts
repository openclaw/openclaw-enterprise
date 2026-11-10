import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  keycloakRealmFile,
  prepareKeycloak as prepareKeycloakJs,
} from "../../scripts/ci/keycloak.mjs";
import { commandCalls, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cleanupPath = join(repositoryRoot, "scripts/ci/cleanup.mjs");

type Realm = {
  clients: { secret: string; redirectUris: string[]; attributes: Record<string, unknown> }[];
  users: { username: string; credentials: { value: string }[] }[];
};

function assertRealm(realm: unknown): asserts realm is Realm {
  assert.ok(typeof realm === "object" && realm !== null);
  assert.ok("clients" in realm && Array.isArray(realm.clients));
  const clients: unknown[] = realm.clients;
  for (const client of clients) {
    assert.ok(typeof client === "object" && client !== null);
    assert.ok("secret" in client && typeof client.secret === "string");
    assert.ok(
      "redirectUris" in client &&
        Array.isArray(client.redirectUris) &&
        client.redirectUris.every((uri: unknown) => typeof uri === "string"),
    );
    assert.ok(
      "attributes" in client &&
        typeof client.attributes === "object" &&
        client.attributes !== null &&
        !Array.isArray(client.attributes),
    );
  }
  assert.ok("users" in realm && Array.isArray(realm.users));
  const users: unknown[] = realm.users;
  for (const user of users) {
    assert.ok(
      typeof user === "object" &&
        user !== null &&
        "username" in user &&
        typeof user.username === "string",
    );
    assert.ok(
      "credentials" in user &&
        Array.isArray(user.credentials) &&
        user.credentials.every(
          (credential: unknown) =>
            typeof credential === "object" &&
            credential !== null &&
            "value" in credential &&
            typeof credential.value === "string",
        ),
    );
  }
}

function parseRealm(text: string): Realm {
  const realm: unknown = JSON.parse(text);
  assertRealm(realm);
  return realm;
}

type KeycloakResource = { name: string; directory: string };
type PrepareKeycloakOptions = {
  stateDirectory: string;
  name: string;
  realmFile?: string;
  execFile: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  ensureImage: () => Promise<void>;
  portAccepts: () => Promise<boolean>;
  reservePort: () => Promise<number>;
  registerResource: (resource: KeycloakResource) => Promise<KeycloakResource>;
  saveState: () => Promise<void>;
  lookupAll?: () => Promise<{ address: string }[]>;
  log?: () => void;
};
const prepareKeycloak = prepareKeycloakJs as typeof prepareKeycloakJs &
  ((options: PrepareKeycloakOptions) => ReturnType<typeof prepareKeycloakJs>);

function fixture(t: TestContext) {
  return temporaryDirectory(t, "ci-keycloak-test-");
}

test("the Keycloak realm fixture holds no secret", async () => {
  const realm = parseRealm(await readFile(keycloakRealmFile, "utf8"));
  const [client] = realm.clients;
  assert.ok(client);
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
  const realm = parseRealm(await readFile(keycloakRealmFile, "utf8"));
  const [client] = realm.clients;
  assert.ok(client);
  client.attributes["post.logout.redirect.uris"] = "${OCE_KEYCLOAK_UNSET_FOR_TEST}";
  const realmFile = join(root, "realm.json");
  await writeFile(realmFile, JSON.stringify(realm));
  const commands: string[][] = [];
  const resources: KeycloakResource[] = [];
  // Keycloak would import the unset placeholder as literal text, so the lane must stop.
  await assert.rejects(
    prepareKeycloak({
      stateDirectory: root,
      name: "openclaw-ci-kc-test-0123456789ab",
      realmFile,
      execFile: async (command: string, args: string[]) => {
        commands.push([command, ...args]);
        return { stdout: "", stderr: "" };
      },
      ensureImage: async () => {},
      portAccepts: async () => false,
      reservePort: async () => 40443,
      registerResource: async (details: KeycloakResource) => {
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
  ] satisfies [string[], boolean][]) {
    await t.test(addresses.join(","), async (t) => {
      const root = await fixture(t);
      const commands: string[] = [];
      // Exercise real certificate preparation and host gating, stopping at the
      // container boundary; the live lane separately proves HTTPS readiness.
      await assert.rejects(
        prepareKeycloak({
          stateDirectory: root,
          name: "openclaw-ci-kc-dns-test-0123456789ab",
          ensureImage: async () => {},
          portAccepts: async () => false,
          reservePort: async () => 40443,
          registerResource: async (details: KeycloakResource) => details,
          saveState: async () => {},
          lookupAll: async () => addresses.map((address) => ({ address })),
          log: () => {},
          execFile: async (command: string, args: string[]) => {
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
