import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  pendingIdentityProbe,
  recordingChild,
  startSupervisor,
  type ProcessEventRow,
} from "./workspace-node-supervisor-fixture.ts";

// An OpenShell Sandbox delivers the Gateway CA as a provider file (OPENCLAW_NODE_CA_PATH)
// and runs the Harness with its own HOME. Codex hook commands call the Gateway route, so
// they need that CA as much as the node does, and their credential directory is HOME's.
export async function publishesFileDeliveredCa(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-node-ca-file-"));
  const caPath = join(directory, "node-ca.pem");
  await writeFile(caPath, "gateway-public-ca\n");
  const setupEnvelopePath = join(directory, "node-setup.json");
  await writeFile(
    setupEnvelopePath,
    JSON.stringify({
      url: "wss://gateway.example.test/node",
      bootstrapToken: "provider-bootstrap-token",
      expiresAtMs: Date.now() + 60_000,
    }),
  );
  const { waitFor } = await startSupervisor(t, directory, {
    child: [
      'const { appendFileSync } = require("node:fs");',
      "const [events, kind] = process.argv.slice(2);",
      "appendFileSync(events, JSON.stringify({ kind, pid: process.pid,",
      "caPath: process.env.NODE_EXTRA_CA_CERTS,",
      "shellCaPath: process.env.OPENCLAW_SHELL_NODE_EXTRA_CA_CERTS,",
      'hasCaPath: process.env.OPENCLAW_NODE_CA_PATH !== undefined }) + "\\n");',
      "setInterval(() => {}, 1_000);",
    ],
    stubs: pendingIdentityProbe,
    env: { OPENCLAW_NODE_SETUP_ENVELOPE: setupEnvelopePath, OPENCLAW_NODE_CA_PATH: caPath },
  });
  const rows = await waitFor(
    "children started",
    (observed) =>
      observed.some(({ kind }) => kind === "node") && observed.some(({ kind }) => kind === "codex"),
  );
  const node = rows.find((row) => row.kind === "node");
  const codex = rows.find((row) => row.kind === "codex");
  assert.ok(node && codex, "node and Codex recorded their starts");
  assert.equal(node.caPath, caPath);
  const hooks = join(directory, ".oce-native-hooks");
  assert.equal((await stat(hooks)).mode & 0o777, 0o700);
  assert.equal(codex.caPath, join(hooks, "gateway-ca.pem"));
  assert.equal(await readFile(codex.caPath, "utf8"), "gateway-public-ca");
  // No Pod CA: sandboxed commands get no NODE_EXTRA_CA_CERTS at all.
  assert.equal(codex.shellCaPath, "");
  assert.equal(codex.hasCaPath, false);
}

// Code in the Harness runs as the Harness user, so it can replace the hook directory, for
// example with a symlink into the workspace. On OpenShell HOME survives restarts, so the
// replacement would steer later relay credentials and the CA copy into the workspace.
export async function rebuildsLinkedHookPaths(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-node-hook-directory-"));
  const caPath = join(directory, "node-ca.pem");
  await writeFile(caPath, "gateway-public-ca\n");
  const setupEnvelopePath = join(directory, "node-setup.json");
  await writeFile(
    setupEnvelopePath,
    JSON.stringify({
      url: "wss://gateway.example.test/node",
      bootstrapToken: "provider-bootstrap-token",
      expiresAtMs: Date.now() + 60_000,
    }),
  );
  // A previous Harness lifetime left the directory as a link into the workspace.
  const hooks = join(directory, ".oce-native-hooks");
  const leak = join(directory, "workspace", "leak");
  await mkdir(leak, { recursive: true });
  await writeFile(join(leak, "planted.json"), "planted");
  await symlink(leak, hooks);
  const { waitFor } = await startSupervisor(t, directory, {
    child: [
      'const { appendFileSync } = require("node:fs");',
      "const [events, kind] = process.argv.slice(2);",
      "appendFileSync(events, JSON.stringify({ kind, pid: process.pid,",
      'caPath: process.env.NODE_EXTRA_CA_CERTS }) + "\\n");',
      "setInterval(() => {}, 1_000);",
    ],
    stubs: pendingIdentityProbe,
    env: { OPENCLAW_NODE_SETUP_ENVELOPE: setupEnvelopePath, OPENCLAW_NODE_CA_PATH: caPath },
  });
  const codexRows = (rows: ProcessEventRow[]) => rows.filter((row) => row.kind === "codex");
  const first = codexRows(await waitFor("Codex started", (rows) => codexRows(rows).length === 1));
  const assertPrivateHooks = async () => {
    const entry = await lstat(hooks);
    assert.equal(entry.isDirectory(), true);
    assert.equal(entry.mode & 0o777, 0o700);
    assert.equal((await lstat(join(hooks, "gateway-ca.pem"))).isFile(), true);
    assert.equal(await readFile(join(hooks, "gateway-ca.pem"), "utf8"), "gateway-public-ca");
  };
  await assertPrivateHooks();
  const [firstStart] = first;
  assert.ok(firstStart, "Codex recorded its first start");
  assert.equal(firstStart.caPath, join(hooks, "gateway-ca.pem"));
  assert.deepEqual(await readdir(leak), ["planted.json"]);

  // Mid-run, Harness code links the CA copy into the workspace and then swaps the
  // whole directory for a link. A Codex restart rebuilds the directory without
  // writing through either link, and drops the previous process's credentials.
  await writeFile(join(hooks, "relay.g1.json"), "previous-relay-credential", { mode: 0o600 });
  await rm(join(hooks, "gateway-ca.pem"));
  await symlink(join(leak, "linked-ca.pem"), join(hooks, "gateway-ca.pem"));
  process.kill(firstStart.pid, "SIGKILL");
  const second = codexRows(
    await waitFor("Codex restarted", (rows) => codexRows(rows).length === 2),
  );
  await assertPrivateHooks();
  assert.deepEqual(await readdir(hooks), ["gateway-ca.pem"]);
  assert.deepEqual(await readdir(leak), ["planted.json"]);

  await rm(hooks, { recursive: true });
  await symlink(leak, hooks);
  const secondStart = second.at(-1);
  assert.ok(secondStart, "Codex recorded its second start");
  process.kill(secondStart.pid, "SIGKILL");
  await waitFor("Codex restarted again", (rows) => codexRows(rows).length === 3);
  await assertPrivateHooks();
  assert.deepEqual(await readdir(hooks), ["gateway-ca.pem"]);
  assert.deepEqual(await readdir(leak), ["planted.json"]);
}

// An earlier Harness lifetime's credentials belong to retired relays. The first Codex
// start removes them from an intact directory, fixes its mode and replaces a linked CA copy.
export async function removesPreviousHookCredentials(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-node-hook-stale-"));
  const setupEnvelopePath = join(directory, "node-setup.json");
  await writeFile(
    setupEnvelopePath,
    JSON.stringify({
      url: "wss://gateway.example.test/node",
      bootstrapToken: "provider-bootstrap-token",
      expiresAtMs: Date.now() + 60_000,
    }),
  );
  const hooks = join(directory, ".oce-native-hooks");
  const workspace = join(directory, "workspace");
  await mkdir(hooks, { recursive: true, mode: 0o755 });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(hooks, "relay.g0.json"), "retired-relay-credential");
  await symlink(join(workspace, "linked-ca.pem"), join(hooks, "gateway-ca.pem"));
  const { waitFor } = await startSupervisor(t, directory, {
    child: recordingChild,
    stubs: pendingIdentityProbe,
    env: {
      OPENCLAW_NODE_SETUP_ENVELOPE: setupEnvelopePath,
      OPENCLAW_NODE_CA_PEM: "gateway-public-ca",
    },
  });
  await waitFor("Codex started", (rows) => rows.some(({ kind }) => kind === "codex"));
  assert.equal((await lstat(hooks)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(hooks), ["gateway-ca.pem"]);
  assert.equal((await lstat(join(hooks, "gateway-ca.pem"))).isFile(), true);
  assert.equal(await readFile(join(hooks, "gateway-ca.pem"), "utf8"), "gateway-public-ca");
  assert.deepEqual(await readdir(workspace), []);
}
