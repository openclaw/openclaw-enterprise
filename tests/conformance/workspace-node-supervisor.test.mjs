import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_WITH_NODE_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";

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
        'args[0] === "/app/openclaw.mjs" ? "node" : "codex"], options);',
      AGENT_WITH_NODE_ENTRYPOINT.replace(
        "\ninitializeRuntimeAssets();\npublishAgentPluginSkillPath();\n",
        "\n",
      ),
    ].join("\n");
    // Launch through the same bounded program pieces the container receives.
    const supervisor = spawn(process.execPath, ["-e", ...nodeProgramArguments(launch)], {
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
    assert.equal(node.autoUpdateDisabled, true);
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

// A Deployment-backed Codex Harness starts before its node setup Secret exists
// and receives the code through an optional volume. Real child processes prove
// the start order; native pairing and the kubelet volume refresh are not run here.
test(
  "Codex starts before the node setup file and the node reconnects after the code is removed",
  {
    timeout: 20_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-node-setup-file-"));
    const eventsPath = join(directory, "events.jsonl");
    const childPath = join(directory, "child.cjs");
    const setupDirectory = join(directory, "setup");
    const setupPath = join(setupDirectory, "setup-code");
    const setupReadsPath = join(directory, "setup-reads.jsonl");
    const identityPath = join(directory, "identity.json");
    await writeFile(
      childPath,
      [
        'const { appendFileSync } = require("node:fs");',
        "const [events, kind, args] = process.argv.slice(2);",
        "appendFileSync(events, JSON.stringify({ kind, pid: process.pid, args: JSON.parse(args),",
        "hasSetupPath: process.env.OPENCLAW_NODE_SETUP_PATH !== undefined,",
        "hasDisplayName: process.env.OPENCLAW_NODE_DISPLAY_NAME !== undefined }) + '\\n');",
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    );
    // Substitute native initialization, the child bodies and the saved-identity
    // lookup; the supervisor's setup polling and restarts run unchanged.
    const launch = [
      'const cp = require("node:child_process"); const realSpawn = cp.spawn;',
      "cp.spawnSync = () => ({ status: 0 });",
      "cp.execFile = (file, args, options, callback) => {",
      `  try { callback(null, require("node:fs").readFileSync(${JSON.stringify(identityPath)}, "utf8")); }`,
      '  catch (error) { callback(error, ""); }',
      "};",
      "cp.spawn = (command, args, options) => realSpawn(command, [" +
        JSON.stringify(childPath) +
        ", " +
        JSON.stringify(eventsPath) +
        ', args[0] === "/app/openclaw.mjs" ? "node" : "codex", JSON.stringify(args)], options);',
      // Record each setup poll and what it read, so the test waits for polls.
      'const fs = require("node:fs"); const realRead = fs.readFileSync;',
      "fs.readFileSync = (path, ...rest) => {",
      `  if (path !== ${JSON.stringify(setupPath)}) return realRead(path, ...rest);`,
      "  let content = null;",
      "  try { content = realRead(path, ...rest); return content; }",
      `  finally { fs.appendFileSync(${JSON.stringify(setupReadsPath)}, JSON.stringify({ content }) + "\\n"); }`,
      "};",
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
        OPENCLAW_NODE_SETUP_PATH: setupPath,
        OPENCLAW_NODE_DISPLAY_NAME: "agent-0123456789ab-workspace",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let output = "";
    supervisor.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = once(supervisor, "exit");
    const jsonLines = async (path) => {
      const contents = await readFile(path, "utf8").catch((error) => {
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
    const events = () => jsonLines(eventsPath);
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
    const waitFor = async (description, predicate, read = events) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const observed = await read();
        if (predicate(observed)) {
          return observed;
        }
        assert.equal(supervisor.exitCode, null, output);
        await delay(25);
      }
      assert.fail(description + ": " + output);
    };
    const nodes = (rows) => rows.filter(({ kind }) => kind === "node");
    // The supervisor polls the setup file until it starts a node. A poll that read
    // `content` followed by another poll proves that content started no node.
    const evaluated = (content) =>
      waitFor(
        `a setup poll after reading ${JSON.stringify(content)}`,
        (reads) => {
          const index = reads.findIndex((read) => read.content === content);
          return index !== -1 && index < reads.length - 1;
        },
        () => jsonLines(setupReadsPath),
      );

    const [codex] = await waitFor("Codex started without the setup", (rows) =>
      rows.some(({ kind }) => kind === "codex"),
    );
    assert.equal(codex.hasSetupPath, false, "Codex does not learn where the setup code lives");
    assert.equal(codex.hasDisplayName, false);
    await evaluated(null);
    assert.deepEqual(nodes(await events()), [], "no node without a setup or a saved identity");

    // The kubelet swaps Secret files atomically; an empty or truncated code is
    // still treated as absent rather than handed to native pairing.
    const code = Buffer.from(
      JSON.stringify({ url: "wss://gateway.example.test", bootstrapToken: "bootstrap" }),
    ).toString("base64url");
    await mkdir(setupDirectory);
    for (const incomplete of ["", "\n", code.slice(0, 17)]) {
      await writeFile(setupPath, incomplete);
      await evaluated(incomplete);
      assert.deepEqual(nodes(await events()), [], JSON.stringify(incomplete));
    }

    await writeFile(setupPath, `${code}\n`);
    const [paired] = nodes(
      await waitFor("node started with the setup", (rows) => nodes(rows).length === 1),
    );
    assert.deepEqual(paired.args.slice(0, 5), [
      "/app/openclaw.mjs",
      "node",
      "run",
      "--pair-if-needed",
      code,
    ]);
    // Every start names the node after the Agent, not the first Pod's host name.
    const displayName = (args) => args[args.indexOf("--display-name") + 1];
    assert.equal(displayName(paired.args), "agent-0123456789ab-workspace");
    assert.match(output, /"phase":"node-setup"/);

    // After pairing the controller removes the code and the kubelet removes the
    // file. A node restart then reconnects with its saved device identity.
    await rm(setupPath);
    await writeFile(identityPath, JSON.stringify({ deviceId: "a".repeat(64) }));
    process.kill(paired.pid, "SIGKILL");
    const restarted = nodes(
      await waitFor("node reconnected without a code", (rows) => nodes(rows).length === 2),
    )[1];
    assert.deepEqual(restarted.args.slice(0, 3), ["/app/openclaw.mjs", "node", "run"]);
    assert.equal(restarted.args.includes("--pair-if-needed"), false);
    assert.equal(restarted.args.includes(code), false);
    assert.equal(displayName(restarted.args), "agent-0123456789ab-workspace");
    assert.equal((await events()).filter(({ kind }) => kind === "codex").length, 1);

    supervisor.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null], output);
  },
);

// After pairing the controller removes the setup code, so every later Harness
// start depends on the saved-identity probe. A probe that fails once (a timeout
// under Codex startup contention) must not park the node until a restart.
test(
  "a failed saved-identity probe is retried and the node starts without a code",
  {
    timeout: 20_000,
    skip: process.platform !== "linux" && "Run the container entrypoint test on Linux.",
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-node-identity-retry-"));
    const eventsPath = join(directory, "events.jsonl");
    const childPath = join(directory, "child.cjs");
    await writeFile(
      childPath,
      [
        'const { appendFileSync } = require("node:fs");',
        "const [events, kind, args] = process.argv.slice(2);",
        "appendFileSync(events, JSON.stringify({ kind, pid: process.pid, args: JSON.parse(args) }) + '\\n');",
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    );
    // The saved identity exists throughout; only the first probe fails.
    const launch = [
      'const cp = require("node:child_process"); const realSpawn = cp.spawn;',
      'const { appendFileSync } = require("node:fs");',
      "cp.spawnSync = () => ({ status: 0 });",
      "let probes = 0;",
      "cp.execFile = (file, args, options, callback) => {",
      "  probes += 1;",
      `  appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ kind: "probe", attempt: probes }) + "\\n");`,
      '  if (probes === 1) { setImmediate(() => callback(Object.assign(new Error("timed out"), { killed: true }), "")); return; }',
      `  setImmediate(() => callback(null, JSON.stringify({ deviceId: ${JSON.stringify("b".repeat(64))} })));`,
      "};",
      "cp.spawn = (command, args, options) => realSpawn(command, [" +
        JSON.stringify(childPath) +
        ", " +
        JSON.stringify(eventsPath) +
        ', args[0] === "/app/openclaw.mjs" ? "node" : "codex", JSON.stringify(args)], options);',
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
        OPENCLAW_NODE_SETUP_PATH: join(directory, "setup", "setup-code"),
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
        if (pid === undefined) {
          continue;
        }
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
    const deadline = Date.now() + 8_000;
    let rows = [];
    while (!rows.some(({ kind }) => kind === "node")) {
      assert.ok(Date.now() < deadline, "node never started after a failed probe: " + output);
      assert.equal(supervisor.exitCode, null, output);
      await delay(50);
      rows = await events();
    }
    const probes = rows.filter(({ kind }) => kind === "probe");
    assert.equal(probes.length, 2, "one failed probe, one retry");
    const node = rows.find(({ kind }) => kind === "node");
    assert.deepEqual(node.args.slice(0, 3), ["/app/openclaw.mjs", "node", "run"]);
    assert.equal(node.args.includes("--pair-if-needed"), false);
    assert.equal(rows.filter(({ kind }) => kind === "codex").length, 1);

    supervisor.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null], output);
  },
);
