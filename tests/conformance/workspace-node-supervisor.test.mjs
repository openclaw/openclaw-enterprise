import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_WITH_NODE_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

// This proves process supervision with real child processes. It does not prove
// native pairing, Codex startup or container integration.
test(
  "workspace node and Codex restart independently and retire their process groups",
  {
    timeout: 15_000,
    // These are Linux container entrypoints. Darwin can report EPERM when a
    // process group contains only zombies, unlike the production kernel.
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-node-supervisor-"));
    const eventsPath = join(directory, "events.jsonl");
    const childPath = join(directory, "child.cjs");
    await writeFile(
      childPath,
      [
        'const { appendFileSync } = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        "const [events, kind] = process.argv.slice(2);",
        "appendFileSync(events, JSON.stringify({ kind, pid: process.pid, parent: process.ppid,",
        "hasSetup: process.env.OPENCLAW_NODE_SETUP_CODE !== undefined,",
        "hasModelKey: process.env.OPENAI_API_KEY !== undefined,",
        'hasTransportToken: process.env.APP_SERVER_TOKEN !== undefined }) + "\\n");',
        'if (kind === "codex") spawn(process.execPath, [__filename, events, "grandchild"], { stdio: "inherit" });',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    );
    // Native initialization is covered by the runtime-image test. Substitute it
    // and external executable bodies; supervision, signals and environments run unchanged.
    const launch = [
      'const cp = require("node:child_process"); const realSpawn = cp.spawn;',
      // Native workspace initialization is covered by the runtime image test.
      "cp.spawnSync = () => ({ status: 0 });",
      "cp.spawn = (command, args, options) => realSpawn(command, [" +
        JSON.stringify(childPath) +
        ", " +
        JSON.stringify(eventsPath) +
        ", " +
        'args[0] === "/app/openclaw.mjs" ? "node" : "codex"], options);',
      AGENT_WITH_NODE_ENTRYPOINT.replace("\ninitializeRuntimeAssets();\n", "\n"),
    ].join("\n");
    const supervisor = spawn(process.execPath, ["-e", launch], {
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        OPENCLAW_NODE_STATE_DIR: join(directory, "node-state"),
        OPENCLAW_NODE_SETUP_CODE: "synthetic-setup",
        OPENAI_API_KEY: "synthetic-model-key",
        APP_SERVER_TOKEN: "synthetic-transport-token",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let output = "";
    supervisor.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = once(supervisor, "exit");
    const events = async () => {
      const contents = await readFile(eventsPath, "utf8").catch((error) => {
        if (error.code === "ENOENT") {
          return "";
        }
        throw error;
      });
      return contents
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    };
    t.after(async () => {
      supervisor.kill("SIGTERM");
      await exited;
      for (const { pid } of await events()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") {
            throw error;
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    });
    const waitFor = async (description, predicate) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const observed = await events();
        if (await predicate(observed)) {
          return observed;
        }
        assert.equal(supervisor.exitCode, null, output);
        await delay(25);
      }
      assert.fail(description + ": " + output);
    };
    const initial = await waitFor(
      "children started",
      (rows) =>
        rows.some(({ kind }) => kind === "node") && rows.some(({ kind }) => kind === "grandchild"),
    );
    const node = initial.find(({ kind }) => kind === "node");
    const codex = initial.find(({ kind }) => kind === "codex");
    assert.equal(node.hasSetup, false);
    assert.equal(node.hasModelKey, false);
    assert.equal(node.hasTransportToken, false);
    assert.equal(codex.hasSetup, false);
    assert.equal(codex.hasModelKey, true);
    assert.equal(codex.hasTransportToken, true);

    process.kill(codex.pid, "SIGKILL");
    const afterCodex = await waitFor(
      "Codex restarted",
      (rows) => rows.filter(({ kind }) => kind === "codex").length === 2,
    );
    assert.equal(afterCodex.filter(({ kind }) => kind === "node").length, 1);
    process.kill(node.pid, 0);
    const descendant = initial.find(({ kind }) => kind === "grandchild");
    await waitFor("old Codex descendant exited", () => {
      try {
        process.kill(descendant.pid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") {
          return true;
        }
        throw error;
      }
    });

    process.kill(node.pid, "SIGKILL");
    const afterNode = await waitFor(
      "node restarted",
      (rows) => rows.filter(({ kind }) => kind === "node").length === 2,
    );
    assert.equal(afterNode.filter(({ kind }) => kind === "codex").length, 2);
    supervisor.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null], output);
    for (const { pid } of await events()) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
  },
);
