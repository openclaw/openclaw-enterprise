import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { attachPostgresToK3d } from "../helpers/k3d-postgres-network.mjs";
import { FixtureCommandError } from "../helpers/production-rehearsal-custody.ts";
import { withEnvironment } from "../helpers/environment.ts";
import { writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

// Exercise the real attachment owner with a command-protocol peer. This checks
// dispatch, holder persistence and error propagation, not Docker networking.
async function fixture(t, initial, body) {
  const directory = await temporaryDirectory(t, "postgres-attachment-");
  const statePath = join(directory, "state.json");
  const registryPath = join(directory, "postgres-k3d-selected.json");
  const physicalPath = join(directory, "physical.json");
  const hooks = [];
  await writeFile(
    statePath,
    JSON.stringify({
      resources: [
        { kind: "k3d-cluster", status: "ready", name: "selected" },
        { kind: "compose-postgres", status: "ready", name: "database" },
      ],
    }),
  );
  await writeFile(physicalPath, JSON.stringify({ attached: false, ...initial }));
  const command = await writeCommand(
    directory,
    "docker-peer",
    `
const fs = require("node:fs/promises");
const path = require("node:path");
const delay = require("node:timers/promises").setTimeout;
(async () => {
  const root = process.env.ATTACHMENT_PROTOCOL_DIRECTORY;
  const args = process.argv.slice(2);
  await fs.appendFile(path.join(root, "calls.jsonl"), JSON.stringify(args) + "\\n");
  const file = path.join(root, "physical.json");
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  const pause = async phase => {
    if (state.pause !== phase) return;
    await fs.writeFile(path.join(root, "paused"), phase);
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (await fs.stat(path.join(root, "resume")).then(() => true, () => false)) return;
      await delay(10);
    }
    throw Error("protocol gate timeout");
  };
  if (args[0] === "ps") process.stdout.write("database-server\\n");
  else if (args[0] === "inspect") {
    if (args.at(-1) === "k3d-selected-server-0") process.stdout.write('{"k3d-selected":{}}');
    else if (args[2].includes("IPAddress")) process.stdout.write("172.20.0.2");
    else {
      await pause("inspect");
      process.stdout.write(state.attached ? '{"k3d-selected":{}}' : '{}');
    }
  } else if (args[0] === "network" && args[1] === "connect") {
    state.attached = true;
    await fs.writeFile(file, JSON.stringify(state));
    await pause("connect");
    if (state.connect === "lost") process.exitCode = 1;
  } else if (args[0] === "network" && args[1] === "disconnect") {
    if (state.detach !== "fail" && state.detach !== "ignore") {
      state.attached = false;
      await fs.writeFile(file, JSON.stringify(state));
    }
    if (state.detach === "fail" || state.detach === "lost") process.exitCode = 1;
  } else throw Error("unexpected protocol command");
})().catch(() => { process.exitCode = 2; });
`,
    { interpreter: process.execPath },
  );
  const read = () => readFile(physicalPath, "utf8").then(JSON.parse);
  const calls = async () =>
    (await readFile(join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  await withEnvironment(
    {
      OPENCLAW_ENTERPRISE_CI_STATE: statePath,
      OCC_DOCKER_BIN: command,
      ATTACHMENT_PROTOCOL_DIRECTORY: directory,
    },
    () =>
      body({
        directory,
        registryPath,
        hooks,
        read,
        calls,
        attach: (options) => attachPostgresToK3d((hook) => hooks.push(hook), options),
      }),
  );
}

for (const phase of ["inspect", "connect"]) {
  test(`PostgreSQL attachment cancellation during ${phase} preserves dispatch custody`, async (t) => {
    await fixture(
      t,
      { pause: phase },
      async ({ directory, registryPath, hooks, calls, attach }) => {
        const controller = new AbortController();
        const reason = new Error("stage cancelled");
        const outcome = attach({ signal: controller.signal, strictCleanup: true }).then(
          () => undefined,
          (error) => error,
        );
        const end = Date.now() + 5000;
        while (!(await readFile(join(directory, "paused"), "utf8").catch(() => ""))) {
          assert.ok(Date.now() < end, "attachment did not reach controlled suspension");
          await delay(10);
        }
        controller.abort(reason);
        await writeFile(join(directory, "resume"), "resume");
        assert.equal(await outcome, reason);
        const connections = (await calls()).filter(
          (args) => args[0] === "network" && args[1] === "connect",
        );
        if (phase === "inspect") {
          assert.equal(connections.length, 0);
          assert.equal(hooks.length, 1);
          await hooks[0]();
          await assert.rejects(readFile(registryPath), { code: "ENOENT" });
        } else {
          // A dispatched command completes bookkeeping before cancellation escapes;
          // its registered cleanup remains usable with an already aborted signal.
          assert.equal(connections.length, 1);
          assert.equal(hooks.length, 1);
          assert.equal(JSON.parse(await readFile(registryPath, "utf8")).connectedByHarness, true);
          await hooks[0]();
          await assert.rejects(readFile(registryPath), { code: "ENOENT" });
        }
      },
    );
  });
}

for (const detach of ["fail", "ignore", "lost"]) {
  test(`Strict PostgreSQL release retains custody for ${detach} detach`, async (t) => {
    await fixture(t, { detach }, async ({ registryPath, hooks, calls, attach }) => {
      await attach({ strictCleanup: true });
      const original = await readFile(registryPath, "utf8");
      await assert.rejects(
        hooks[0](),
        detach === "ignore"
          ? { message: /Owned PostgreSQL attachment remains/ }
          : FixtureCommandError,
      );
      assert.equal(await readFile(registryPath, "utf8"), original);
      const observed = await calls();
      assert.equal(
        observed.filter((args) => args[0] === "network" && args[1] === "disconnect").length,
        1,
      );
      if (detach === "lost") {
        // Even a server-side detach cannot be declared complete from a failed
        // client: preserve the record without interpreting one later absence.
        assert.equal(observed.at(-1)[1], "disconnect");
      }
    });
  });
}

for (const strictCleanup of [false, true]) {
  test(`PostgreSQL shared holders and pre-existing attachment survive release (strict=${strictCleanup})`, async (t) => {
    for (const attached of [false, true]) {
      await fixture(t, { attached }, async ({ registryPath, hooks, read, calls, attach }) => {
        assert.equal(await attach({ strictCleanup }), "172.20.0.2");
        assert.equal(await attach({ strictCleanup }), "172.20.0.2");
        await hooks[0]();
        assert.equal((await read()).attached, true);
        assert.equal(
          Object.keys(JSON.parse(await readFile(registryPath, "utf8")).holders).length,
          1,
        );
        assert.equal((await calls()).filter((args) => args[1] === "disconnect").length, 0);
        await hooks[1]();
        assert.equal((await read()).attached, attached);
        assert.equal(
          (await calls()).filter((args) => args[1] === "disconnect").length,
          attached ? 0 : 1,
        );
        await assert.rejects(readFile(registryPath), { code: "ENOENT" });
      });
    }
  });
}

test("Strict PostgreSQL acquisition retains uncertain connect for manual reconciliation", async (t) => {
  await fixture(t, { connect: "lost" }, async ({ registryPath, hooks, read, calls, attach }) => {
    await assert.rejects(attach({ strictCleanup: true }), (error) =>
      error instanceof FixtureCommandError ? error.outcome.exitCode === 1 : error.code === 1,
    );
    assert.equal((await read()).attached, true);
    const retained = await readFile(registryPath, "utf8");
    assert.equal(JSON.parse(retained).pendingConnect, true);
    assert.equal(hooks.length, 1);
    await assert.rejects(hooks[0](), /manual reconciliation/);
    // Neither strict nor ordinary callers may relabel this write as pre-existing.
    await assert.rejects(attach({ strictCleanup: true }), /manual reconciliation/);
    await assert.rejects(attach(), /manual reconciliation/);
    assert.equal(await readFile(registryPath, "utf8"), retained);
    const writes = (await calls()).filter((args) => args[0] === "network");
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1], "connect");
  });
});

test("Ordinary PostgreSQL release preserves a pending strict connect", async (t) => {
  await fixture(t, {}, async ({ directory, registryPath, hooks, read, calls, attach }) => {
    await attach();
    // Model a lost attachment while an ordinary holder still owns it. The next
    // strict repair attempt loses its ACK; neither holder may erase that intent.
    await writeFile(
      join(directory, "physical.json"),
      JSON.stringify({
        ...(await read()),
        attached: false,
        connect: "lost",
      }),
    );
    await assert.rejects(attach({ strictCleanup: true }), (error) =>
      error instanceof FixtureCommandError ? error.outcome.exitCode === 1 : error.code === 1,
    );
    const retained = await readFile(registryPath, "utf8");
    await hooks[0]();
    assert.equal(await readFile(registryPath, "utf8"), retained);
    await assert.rejects(hooks[1](), /manual reconciliation/);
    assert.equal((await calls()).filter((args) => args[1] === "disconnect").length, 0);
  });
});
