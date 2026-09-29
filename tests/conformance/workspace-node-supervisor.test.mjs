import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_WITH_NODE_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";

// This proves process supervision with real child processes. It does not prove
// native pairing, Codex startup or container integration.
for (const stopBeforeEnrollment of [false, true]) {
  test(
    stopBeforeEnrollment
      ? "workspace node never launches when shutdown precedes credentials"
      : "workspace node waits for credentials while Codex runs, then both restart independently",
    {
      timeout: 25_000,
      // These are Linux container entrypoints. Darwin can report EPERM when a
      // process group contains only zombies, unlike the production kernel.
      skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "oce-node-supervisor-"));
      const eventsPath = join(directory, "events.jsonl");
      const childPath = join(directory, "child.cjs");
      const setupPath = join(directory, "setup-code");
      await writeFile(
        childPath,
        [
          'const { appendFileSync } = require("node:fs");',
          'const { spawn } = require("node:child_process");',
          "const [events, kind] = process.argv.slice(2);",
          "appendFileSync(events, JSON.stringify({ kind, pid: process.pid, parent: process.ppid,",
          "hasSetup: process.env.OPENCLAW_NODE_SETUP_CODE !== undefined,",
          "hasSetupFile: process.env.OPENCLAW_NODE_SETUP_CODE_FILE !== undefined,",
          "setupCode: process.argv[4],",
          "hasModelKey: process.env.OPENAI_API_KEY !== undefined,",
          'autoUpdateDisabled: process.env.OPENCLAW_NO_AUTO_UPDATE === "1",',
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
          'args[0] === "/app/openclaw.mjs" ? "node" : "codex", args[4] || ""], options);',
        AGENT_WITH_NODE_ENTRYPOINT.replace(
          "\ninitializeRuntimeAssets();\npublishAgentPluginSkillPath();\n",
          "\n",
        ),
      ].join("\n");
      const supervisor = spawn(process.execPath, ["-e", ...nodeProgramArguments(launch)], {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          OPENCLAW_NODE_STATE_DIR: join(directory, "node-state"),
          OPENCLAW_NODE_SETUP_CODE_FILE: setupPath,
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
      const beforeEnrollment = await waitFor("Codex starts before credentials arrive", (rows) =>
        rows.some(({ kind }) => kind === "grandchild"),
      );
      assert.equal(
        beforeEnrollment.some(({ kind }) => kind === "node"),
        false,
      );
      const firstCodex = beforeEnrollment.find(({ kind }) => kind === "codex");
      if (stopBeforeEnrollment) {
        supervisor.kill("SIGTERM");
        await writeFile(setupPath, "synthetic-setup");
        assert.deepEqual(await exited, [0, null], output);
        assert.equal(
          (await events()).some(({ kind }) => kind === "node"),
          false,
        );
        assert.throws(() => process.kill(firstCodex.pid, 0), { code: "ESRCH" });
        return;
      }
      // Empty and unreadable projections must leave Codex alive while waiting.
      await writeFile(setupPath, "");
      await delay(1_100);
      await rm(setupPath);
      await mkdir(setupPath);
      await delay(1_100);
      assert.equal(
        (await events()).some(({ kind }) => kind === "node"),
        false,
      );
      process.kill(firstCodex.pid, 0);
      await rm(setupPath, { recursive: true });
      // Replacing the path also exercises reopening rather than watching an inode.
      await writeFile(setupPath + ".next", "synthetic-setup");
      await rename(setupPath + ".next", setupPath);
      const initial = await waitFor(
        "children started",
        (rows) =>
          rows.some(({ kind }) => kind === "node") &&
          rows.some(({ kind }) => kind === "grandchild"),
      );
      const node = initial.find(({ kind }) => kind === "node");
      const codex = initial.find(({ kind }) => kind === "codex");
      assert.equal(node.hasSetup, false);
      assert.equal(node.hasSetupFile, false);
      assert.equal(node.setupCode, "synthetic-setup");
      assert.equal(node.hasModelKey, false);
      assert.equal(node.hasTransportToken, false);
      assert.equal(node.autoUpdateDisabled, true);
      assert.equal(codex.hasSetup, false);
      assert.equal(codex.hasSetupFile, false);
      assert.equal(codex.pid, firstCodex.pid);
      assert.equal(initial.filter(({ kind }) => kind === "codex").length, 1);
      await writeFile(setupPath + ".next", "changed-setup");
      await rename(setupPath + ".next", setupPath);
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
      // Expired setup renewal takes effect on node retry without restarting Codex.
      assert.equal(afterNode.filter(({ kind }) => kind === "node")[1].setupCode, "changed-setup");
      assert.equal(output.includes("synthetic-setup"), false);
      assert.equal(output.includes("changed-setup"), false);
      supervisor.kill("SIGTERM");
      assert.deepEqual(await exited, [0, null], output);
      for (const { pid } of await events()) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
    },
  );
}
