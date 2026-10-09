import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createDevUpModelProvider } from "../helpers/dev-up-model-provider.mjs";
import { configureModelProviderDNS } from "../helpers/runtime-model-provider.mjs";

const execute = promisify(execFile);
const revision = "a".repeat(40);
const digest = "b".repeat(64);
const ownerLabel = "dev.openclaw.model-provider-owner";

// A command-boundary engine double: checks fixture orchestration and recovery,
// never substitutes for Docker storage, hosted image, Kubernetes, or native activation proof.
async function scenario(
  t,
  {
    failAfterCreate,
    failAfterRemove,
    failRemove,
    existingRegistry = false,
    signal,
    beforeCreate,
    beforeBuild,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "oce-provider-contract-"));
  const directory = join(root, "provider");
  await mkdir(directory);
  t.after(() => rm(root, { recursive: true, force: true }));
  const objects = new Map();
  const calls = [];
  const environment = {
    OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
    DOCKER_HOST: "unix:///owned.sock",
  };
  const events = [{ event: "listening", at: 1 }];
  const faults = { inspect: false };
  let failedCreate = false;
  let failedRemove = false;
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const output = (value) => ({
      stdout: typeof value === "string" ? value : JSON.stringify(value),
      stderr: "",
    });
    const flag = (name) => args[args.indexOf(name) + 1];
    if (command === "openssl") {
      return execute(command, args);
    }
    if (command === "git") {
      return output(revision);
    }
    assert.equal(command, "docker", "no actual cluster command may escape the fixture test");
    if (args[1] === "inspect") {
      if (faults.inspect) {
        throw Object.assign(new Error("engine unavailable"), {
          stderr: "permission denied while connecting to the Docker API",
        });
      }
      const name = args[2];
      if (existingRegistry && name.endsWith("-registry")) {
        return output([{ Id: "unrelated-registry", Config: { Labels: {} } }]);
      }
      const value = objects.get(name) ?? [...objects.values()].find((object) => object.Id === name);
      if (!value) {
        throw Object.assign(new Error("missing"), {
          stderr:
            args[0] === "network"
              ? `Error response from daemon: network ${name} not found`
              : `Error response from daemon: No such ${args[0]}: ${name}`,
        });
      }
      return output([value]);
    }
    if (args[0] === "run" || (args[0] === "network" && args[1] === "create")) {
      const name = args[0] === "run" ? flag("--name") : args.at(-1);
      const [key, value] = flag("--label").split("=");
      // Creation must already have a durable cleanup obligation, even if its
      // acknowledgement is lost after the engine has materialized the object.
      const journal = JSON.parse(await readFile(join(directory, "resources.json"), "utf8"));
      assert.ok(journal.resources.some((resource) => resource.name === name));
      const object = {
        Id: `id-${name}`,
        Config: { Labels: { [key]: value } },
        Labels: { [key]: value },
      };
      await beforeCreate?.({ name, object, options });
      objects.set(name, object);
      if (failAfterCreate && !failedCreate) {
        failedCreate = true;
        throw new Error("creation acknowledgement lost");
      }
      return output(`id-${name}`);
    }
    if (args[0] === "buildx") {
      const name = flag("--tag");
      await beforeBuild?.({ name, options });
      const labels = {};
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--label") {
          const [key, value] = args[index + 1].split("=");
          labels[key] = value;
        }
      }
      const baseArg = args.find((arg) => arg.startsWith("RUNTIME_IMAGE="));
      const config = baseArg
        ? objects.get(baseArg.slice("RUNTIME_IMAGE=".length)).Config
        : {
            Labels: { ...labels, "org.opencontainers.image.revision": revision },
            User: "node",
            Entrypoint: null,
            Cmd: ["node"],
            WorkingDir: "/app",
          };
      objects.set(name, {
        Id: `id-${name}`,
        Config: structuredClone(config),
        RepoDigests: [],
      });
      return output("");
    }
    if (args[0] === "push") {
      const name = args[1];
      objects.get(name).RepoDigests = [`${name.slice(0, name.lastIndexOf(":"))}@sha256:${digest}`];
      return output("");
    }
    if (args[0] === "logs") {
      return output(events.map((event) => JSON.stringify(event)).join("\n"));
    }
    if (args[1] === "rm") {
      const name = [...objects.keys()].find(
        (name) => name === args.at(-1) || objects.get(name).Id === args.at(-1),
      );
      assert.ok(name);
      if (failRemove && !failedRemove && (failRemove === true || name.endsWith(failRemove))) {
        failedRemove = true;
        throw new Error("owned deletion failed");
      }
      const object = objects.get(name);
      if (args[0] === "container") {
        assert.equal(args.at(-1), object.Id, "remove the inspected container ID");
      }
      objects.delete(name);
      if (failAfterRemove && !failedRemove) {
        failedRemove = true;
        throw new Error("deletion acknowledgement lost");
      }
      return output("");
    }
    throw new Error(`Unexpected fixture operation: ${command} ${args.join(" ")}`);
  };
  const fixture = createDevUpModelProvider({
    directory,
    cluster: "owned-cluster",
    environment,
    signal,
    run,
  });
  return {
    fixture,
    root,
    run,
    directory,
    calls,
    objects,
    environment,
    events,
    faults,
  };
}

test("provider prepares a scoped immutable image pair and requires a completed turn receipt", async (t) => {
  const { fixture, directory, environment, calls, objects, events } = await scenario(t);
  const before = { ...environment };
  const images = await fixture.prepare();
  assert.deepEqual(environment, before, "caller and global environment must not be mutated");
  const ca = join(directory, "model", "ca.pem");
  const leaf = join(directory, "model", "cert.pem");
  await execute("openssl", ["verify", "-CAfile", ca, "-verify_hostname", "api.openai.com", leaf]);
  await assert.rejects(
    execute("openssl", ["verify", "-CAfile", ca, "-verify_hostname", "unrelated.test", leaf]),
  );
  assert.match(images.OCC_DEVELOPMENT_CONTROLLER_IMAGE, /\/controller@sha256:[a-f0-9]{64}$/);
  assert.match(images.OCC_KUBERNETES_RUNTIME_IMAGE, /\/runtime@sha256:[a-f0-9]{64}$/);
  const provider = calls.find(({ args }) => args.includes("PROBE_ENDPOINT_MODE=answer"));
  assert.equal(provider.args.at(-2), images.OCC_KUBERNETES_RUNTIME_IMAGE);
  assert.ok(calls.some(({ args }) => args[0] === "network" && args.includes("--internal")));
  assert.ok(calls.some(({ args }) => args.includes(`OCC_BUILD_REVISION=${revision}`)));
  for (const { args } of calls.filter(({ args }) => args[0] === "buildx")) {
    assert.equal(
      args[args.indexOf("--builder") + 1],
      "default",
      "reuse the launcher's engine cache without hosted cache credentials",
    );
  }
  await assert.rejects(fixture.assertAnswered(), /completed fixture response/);
  events.push({ event: "request", turn: true, transport: "websocket", at: 10 });
  events.push({ event: "turn-answered", status: 401, transport: "websocket", at: 11 });
  await assert.rejects(fixture.assertAnswered(), /completed fixture response/);
  // A failed first WebSocket attempt must not hide a successful HTTPS fallback.
  events.push({ event: "request", turn: true, transport: "https", at: 12 });
  events.push({
    event: "turn-answered",
    status: 200,
    transport: "https",
    at: 13,
    authorization: "must-not-be-copied",
  });
  assert.deepEqual(await fixture.assertAnswered(), {
    requestAt: 12,
    completedAt: 13,
    status: 200,
    transport: "https",
  });
  await fixture.cleanup();
  assert.equal(objects.size, 0);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "resources.json"), "utf8")).resources,
    [],
  );
  assert.ok(
    calls
      .filter(({ args }) => args[0] === "image" && args[1] === "rm")
      .every(({ args }) => !args.includes("--force")),
  );
});

test("provider reconciles a creation whose acknowledgement was lost", async (t) => {
  const { fixture, directory, objects } = await scenario(t, {
    failAfterCreate: true,
    failAfterRemove: true,
  });
  await assert.rejects(fixture.prepare(), /acknowledgement lost/);
  assert.equal(objects.size, 1);
  assert.equal(
    JSON.parse(await readFile(join(directory, "resources.json"), "utf8")).resources.length,
    1,
  );
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  assert.equal(objects.size, 0);
  await fixture.cleanup();
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "resources.json"), "utf8")).resources,
    [],
  );
});

test("provider leaves pre-existing resources untouched", async (t) => {
  const { fixture, calls } = await scenario(t, { existingRegistry: true });
  await assert.rejects(fixture.prepare(), /already exists/);
  await fixture.cleanup();
  assert.equal(
    calls.some(({ args }) => args[0] === "run" || args[1] === "rm"),
    false,
  );
});

test("provider retains failed cleanup obligations and retries only the remainder", async (t) => {
  const { fixture, directory, objects } = await scenario(t, { failRemove: true });
  await fixture.prepare();
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  const remaining = JSON.parse(await readFile(join(directory, "resources.json"), "utf8")).resources;
  assert.equal(remaining.length, 1);
  assert.equal(objects.size, 1);
  await fixture.cleanup();
  assert.equal(objects.size, 0);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "resources.json"), "utf8")).resources,
    [],
  );
});

test("provider retains the registry recovery obligation until removal succeeds", async (t) => {
  const { fixture, directory, objects } = await scenario(t, {
    failRemove: "-registry",
  });
  await fixture.prepare();
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  const remaining = JSON.parse(await readFile(join(directory, "resources.json"), "utf8")).resources;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].kind, "container");
  assert.match(remaining[0].name, /-registry$/);
  assert.equal(objects.size, 1);
  await fixture.cleanup();
  assert.equal(objects.size, 0);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "resources.json"), "utf8")).resources,
    [],
  );
});

test("provider refuses changed ownership and unrelated cluster routing", async (t) => {
  const { fixture, directory, objects, calls } = await scenario(t);
  await fixture.prepare();
  await writeFile(join(directory, "state.json"), JSON.stringify({ cluster: "other-cluster" }));
  await assert.rejects(fixture.route(directory), /other-cluster/);
  assert.equal(
    calls.some(({ command }) => command === "kubectl"),
    false,
  );
  const provider = [...objects.values()].find(({ Id }) => Id.endsWith("-endpoint"));
  provider.Config.Labels[ownerLabel] = "another-owner";
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  assert.ok([...objects.values()].includes(provider), "unowned endpoint must survive cleanup");
});

test("provider DNS readiness requires the mapped provider, API Service and settled resolver", async () => {
  let observation = 0;
  const writes = [];
  const lookups = [
    { provider: "8.8.8.8", api: "10.43.0.1" },
    { provider: "11.123.45.2", api: null },
    { provider: "11.123.45.2", api: "10.43.0.1" },
  ];
  await configureModelProviderDNS({
    modelAddress: "11.123.45.2",
    platformNamespace: "owned-system",
    serverFile: "owned.server",
    kubectl: async (args, options) => {
      if (args[0] === "apply") {
        writes.push(JSON.parse(options.input));
      }
      if (args.includes("get")) {
        return {
          stdout: JSON.stringify({
            items: [{ metadata: observation === 0 ? { deletionTimestamp: "terminating" } : {} }],
          }),
        };
      }
      if (args.includes("exec")) {
        assert.equal(args[1], "owned-system");
        return { stdout: JSON.stringify(lookups.shift()) };
      }
      return { stdout: "" };
    },
    waitFor: async (_description, operation, timeout) => {
      assert.equal(timeout, 120_000);
      for (observation = 0; observation < 4; observation += 1) {
        assert.equal((await operation()).done, observation === 3);
      }
    },
  });
  assert.deepEqual(writes, [
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "coredns-custom", namespace: "kube-system" },
      data: {
        "owned.server":
          "api.openai.com:53 {\n    hosts {\n        11.123.45.2 api.openai.com\n    }\n}\n",
      },
    },
  ]);
});

test("provider DNS configuration failure stops before readiness or Agent use", async () => {
  let waited = false;
  await assert.rejects(
    configureModelProviderDNS({
      modelAddress: "11.123.45.2",
      platformNamespace: "owned-system",
      serverFile: "owned.server",
      kubectl: async () => {
        throw new Error("ConfigMap write denied");
      },
      waitFor: async () => {
        waited = true;
      },
    }),
    /ConfigMap write denied/,
  );
  assert.equal(waited, false);
});

test("provider retains ownership obligations when the engine cannot be inspected", async (t) => {
  const { fixture, directory, objects, faults } = await scenario(t);
  await fixture.prepare();
  const before = JSON.parse(await readFile(join(directory, "resources.json"), "utf8"));
  faults.inspect = true;
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "resources.json"), "utf8")), before);
  assert.equal(objects.size, before.resources.length);
  faults.inspect = false;
  await fixture.cleanup();
  assert.equal(objects.size, 0);
});

test("cleanup drains admitted image builds before reconciling their reservations", async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const signals = [];
  const { fixture, objects, directory, calls } = await scenario(t, {
    beforeBuild: async ({ options }) => {
      signals.push(options.signal);
      if (signals.length === 2) {
        started.resolve();
      }
      // A dispatched engine effect can finish despite client cancellation.
      await release.promise;
    },
    failRemove: "-registry",
  });
  const preparing = fixture.prepare().catch((error) => error);
  await started.promise;
  const cleaning = fixture.cleanup().catch((error) => error);
  const early = await Promise.race([cleaning.then(() => true), delay(40).then(() => false)]);
  const reserved = JSON.parse(await readFile(join(directory, "resources.json"), "utf8"));
  release.resolve();
  await preparing;
  const cleanupError = await cleaning;
  t.diagnostic(
    JSON.stringify({
      cleanupSettledWhileBuildsPending: early,
      objectsAfterSettlement: objects.size,
    }),
  );
  assert.equal(early, false, "cleanup must join both dispatched builds");
  assert.equal(reserved.resources.length, 4, "pending build obligations must remain durable");
  assert.ok(
    signals.every((signal) => signal?.aborted),
    "commands receive cancellation",
  );
  assert.match(cleanupError.message, /recovery journal retained/);
  assert.equal(objects.size, 1, "only the failed registry removal remains");
  const remaining = JSON.parse(await readFile(join(directory, "resources.json"), "utf8"));
  assert.equal(remaining.resources.length, 1);
  const creates = calls.filter(({ args }) => args[0] === "run" || args[0] === "buildx").length;
  await fixture.cleanup();
  assert.equal(objects.size, 0);
  await assert.rejects(fixture.prepare(), { name: "AbortError" });
  await assert.rejects(fixture.route(directory), { name: "AbortError" });
  assert.equal(
    calls.filter(({ args }) => args[0] === "run" || args[0] === "buildx").length,
    creates,
  );
});

test("cancelled creation remains journaled until its late outcome can be reconciled", async (t) => {
  const controller = new AbortController();
  let late;
  const { fixture, objects, directory, calls } = await scenario(t, {
    signal: controller.signal,
    beforeCreate: async (creation) => {
      late = creation;
      controller.abort();
      throw new Error("creation response lost during cancellation");
    },
  });
  await assert.rejects(fixture.prepare(), /response lost/);
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  const journal = JSON.parse(await readFile(join(directory, "resources.json"), "utf8"));
  assert.deepEqual(journal.resources, [{ kind: "container", name: late.name, uncertain: true }]);
  const count = calls.length;
  await assert.rejects(fixture.route(directory), { name: "AbortError" });
  await assert.rejects(fixture.prepare(), { name: "AbortError" });
  assert.equal(calls.length, count, "cancellation closes admission before any command");
  // The adapter now exposes the delayed result of that same create, without replay.
  objects.set(late.name, late.object);
  objects.set("unrelated", { Id: "unrelated", Config: { Labels: {} } });
  await fixture.cleanup();
  assert.deepEqual([...objects.keys()], ["unrelated"]);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "resources.json"), "utf8")).resources,
    [],
  );
  assert.equal(calls.filter(({ args }) => args[0] === "run").length, 1);
});

test("cleanup before prepare permanently closes provider admission", async (t) => {
  const { fixture, directory, calls } = await scenario(t);
  await fixture.cleanup();
  await assert.rejects(fixture.prepare(), { name: "AbortError" });
  await assert.rejects(fixture.route(directory), { name: "AbortError" });
  assert.equal(calls.length, 0);
});

test("Node timeout teardown joins the actual launcher case owner and rejects later work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-provider-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = join(directory, "trace.jsonl");
  const root = join(directory, "case");
  const child = join(directory, "timeout.test.mjs");
  const helper = new URL("../helpers/dev-up-model-provider.mjs", import.meta.url).href;
  // Run a genuinely timed-out node:test in a subprocess so its expected
  // cancellation does not cancel this suite. The actual owner and command
  // executor run here; no Docker/Kubernetes executable is invoked.
  await writeFile(
    child,
    `
import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { runDevUpModelProviderCase } from ${JSON.stringify(helper)};
const trace = ${JSON.stringify(trace)};
const root = ${JSON.stringify(root)};
const mark = (event) => appendFileSync(trace, JSON.stringify(event) + "\\n");
mkdirSync(root);
test("deliberate cancellation", { timeout: 500 }, async (t) => {
  const scope = { signal: t.signal, after: (cleanup) => t.after(async () => {
    mark("teardown-start");
    await cleanup();
    mark("teardown-end");
  }) };
  await runDevUpModelProviderCase(scope, {
    root, cluster: "owned", environment: { OCC_DEVELOPMENT_STATE_DIRECTORY: root + "/state" },
  }, async ({ execute, provider }) => {
    try {
      await execute(process.execPath, ["-e", \`
        const { appendFileSync } = require("node:fs");
        const mark = (event) => appendFileSync(\${JSON.stringify(trace)}, JSON.stringify(event) + "\\\\n");
        process.on("SIGTERM", () => setTimeout(() => { mark("process-settled"); process.exit(0); }, 100));
        mark("command-started");
        setInterval(() => {}, 1000);
      \`]);
      assert.fail("the in-flight command must reject cancellation");
    } catch (error) {
      assert.equal(error.code, "ABORT_ERR");
    }
    assert.equal(existsSync(root), true, "recovery files survive until the body settles");
    await assert.rejects(async () => execute(process.execPath, ["-e", "process.exit(73)"]), { name: "AbortError" });
    await assert.rejects(provider.route(root), { name: "AbortError" });
    mark("body-settled");
  });
});
`,
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(
    execute(process.execPath, ["--test", child], { env, timeout: 10_000 }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /cancelled 1/);
      return true;
    },
  );
  assert.deepEqual((await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse), [
    "command-started",
    "teardown-start",
    "process-settled",
    "body-settled",
    "teardown-end",
  ]);
  assert.equal(existsSync(root), false);
});

test("cleanup retries journal persistence without replaying completed removals", async (t) => {
  const { fixture, directory, objects, calls } = await scenario(t);
  await fixture.prepare();
  const journal = await readFile(join(directory, "resources.json"), "utf8");
  const temporary = join(directory, "resources.json.tmp");
  await mkdir(temporary);
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  assert.equal(objects.size, 0);
  assert.equal(await readFile(join(directory, "resources.json"), "utf8"), journal);
  const removals = calls.filter(({ args }) => args[1] === "rm").length;
  await rm(temporary, { recursive: true });
  await fixture.cleanup();
  assert.equal(calls.filter(({ args }) => args[1] === "rm").length, removals);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "resources.json"), "utf8")).resources,
    [],
  );
});

test("launcher case keeps recovery files after provider cleanup failure and permits cleanup retry", async (t) => {
  const { runDevUpModelProviderCase } = await import("../helpers/dev-up-model-provider.mjs");
  const { root, run, directory, environment, objects } = await scenario(t, {
    failRemove: "-registry",
  });
  environment.OCC_DEVELOPMENT_STATE_DIRECTORY = join(root, "state");
  let cleanup;
  const scope = {
    signal: new AbortController().signal,
    after: (operation) => {
      cleanup = operation;
    },
  };
  await runDevUpModelProviderCase(
    scope,
    { root, cluster: "owned-cluster", environment, run },
    async ({ provider }) => {
      await provider.prepare();
    },
  );
  await assert.rejects(cleanup(), /recovery journal retained/);
  assert.equal(existsSync(root), true);
  assert.equal(objects.size, 1);
  assert.equal(
    JSON.parse(await readFile(join(directory, "resources.json"), "utf8")).resources.length,
    1,
  );
  await cleanup();
  assert.equal(objects.size, 0);
  assert.equal(existsSync(root), false);
});

test("launcher case preserves recovery files after forced process termination", async (t) => {
  const { runDevUpModelProviderCase } = await import("../helpers/dev-up-model-provider.mjs");
  const root = await mkdtemp(join(tmpdir(), "oce-provider-forced-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let cleanup;
  const scope = {
    signal: new AbortController().signal,
    after: (operation) => {
      cleanup = operation;
    },
  };
  await assert.rejects(
    runDevUpModelProviderCase(
      scope,
      {
        root,
        cluster: "owned",
        environment: { OCC_DEVELOPMENT_STATE_DIRECTORY: join(root, "state") },
      },
      async ({ execute }) => {
        await execute(process.execPath, ["-e", 'process.kill(process.pid, "SIGKILL")']);
      },
    ),
    { signal: "SIGKILL" },
  );
  await assert.rejects(cleanup(), /forced termination; recovery state preserved/);
  assert.equal(existsSync(root), true);
});
