import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { asRecord } from "../../packages/utils/src/objects.ts";
import { runDevUpModelProviderCase } from "../helpers/dev-up-model-provider.mjs";
import type { LauncherScope } from "../helpers/dev-up-model-provider.mjs";
import { configureModelProviderDNS } from "../helpers/runtime-model-provider.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { ownerLabel, providerScenario, revision } from "./dev-up-model-provider-fixture.ts";
import type { Creation, InspectDiagnostic } from "./dev-up-model-provider-fixture.ts";

const execute = promisify(execFile);

function processErrors(error: AggregateError): readonly unknown[] {
  return error.errors;
}

function captureTeardown(): { scope: LauncherScope; cleanup: () => Promise<void> } {
  let teardown: (() => Promise<void>) | undefined;
  return {
    scope: {
      signal: new AbortController().signal,
      after: (operation) => {
        teardown = operation;
      },
    },
    cleanup: () => {
      assert.ok(teardown, "launcher case must register teardown");
      return teardown();
    },
  };
}

test("provider prepares a scoped immutable image pair and requires a completed turn receipt", async (t) => {
  const { fixture, directory, readJournal, environment, calls, objects, events } =
    await providerScenario(t);
  const before = { ...environment };
  const images = await fixture.prepare();
  assert.deepEqual(environment, before, "caller and global environment must not be mutated");
  const ca = join(directory, "model", "ca.pem");
  const leaf = join(directory, "model", "cert.pem");
  await execute("openssl", ["verify", "-CAfile", ca, "-verify_hostname", "api.openai.com", leaf]);
  await assert.rejects(
    execute("openssl", ["verify", "-CAfile", ca, "-verify_hostname", "unrelated.test", leaf]),
    { code: 2, message: /hostname mismatch/i },
  );
  assert.match(images.OCC_DEVELOPMENT_CONTROLLER_IMAGE, /\/controller@sha256:[a-f0-9]{64}$/);
  assert.match(images.OCC_KUBERNETES_RUNTIME_IMAGE, /\/runtime@sha256:[a-f0-9]{64}$/);
  const provider = calls.find(({ args }) => args.includes("PROBE_ENDPOINT_MODE=answer"));
  assert.ok(provider, "expected a launch of the model endpoint");
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
  assert.deepEqual((await readJournal()).resources, []);
  assert.ok(
    calls
      .filter(({ args }) => args[0] === "image" && args[1] === "rm")
      .every(({ args }) => !args.includes("--force")),
  );
});

test("provider builds checkout images with the selected installer builder", async (t) => {
  const { fixture, calls } = await providerScenario(t, { builder: "owned-installer-builder" });
  await fixture.prepare();
  const builds = calls.filter(({ args }) => args[0] === "buildx");
  assert.equal(builds.length, 3);
  for (const { args } of builds.slice(0, 2)) {
    assert.equal(args[args.indexOf("--builder") + 1], "owned-installer-builder");
  }
  // The trust layer intentionally consumes the just-loaded base image in the host engine.
  const trust = builds[2];
  assert.ok(trust, "expected a runtime trust build");
  assert.equal(trust.args[trust.args.indexOf("--builder") + 1], "default");
  await fixture.cleanup();
});

test("checkout build failures identify failed roles without exposing child output", async (t) => {
  const privateOutput = "private-build-output-canary";
  const controllerError = Object.assign(new Error(privateOutput), {
    code: 23,
    signal: null,
    killed: false,
    stdout: privateOutput,
    stderr: privateOutput,
  });
  const runtimeError = Object.assign(new Error(privateOutput), {
    code: null,
    signal: "SIGKILL",
    killed: true,
  });
  const malformedError = Object.assign(new Error(privateOutput), {
    code: privateOutput,
    signal: privateOutput,
    killed: privateOutput,
  });
  let accessorReads = 0;
  const throwingAccessor = Object.defineProperty(new Error(privateOutput), "code", {
    get() {
      accessorReads += 1;
      throw new Error(privateOutput);
    },
  });
  const changingAccessor = Object.defineProperty(new Error(privateOutput), "signal", {
    get() {
      accessorReads += 1;
      return accessorReads === 1 ? "SIGTERM" : privateOutput;
    },
  });
  const cases: Array<[string, Partial<Record<"controller" | "runtime", Error>>, string[]]> = [
    [
      "controller only",
      { controller: controllerError },
      ["controller: exit=23 code=unknown signal=unknown killed=false"],
    ],
    [
      "both builds",
      { controller: controllerError, runtime: runtimeError },
      [
        "controller: exit=23 code=unknown signal=unknown killed=false",
        "runtime: exit=unknown code=unknown signal=SIGKILL killed=true",
      ],
    ],
    [
      "unrecognized metadata",
      { runtime: malformedError },
      ["runtime: exit=unknown code=unknown signal=unknown killed=unknown"],
    ],
    [
      "throwing metadata accessor",
      { controller: throwingAccessor },
      ["controller: exit=unknown code=unknown signal=unknown killed=unknown"],
    ],
    [
      "changing metadata accessor",
      { runtime: changingAccessor },
      ["runtime: exit=unknown code=unknown signal=unknown killed=unknown"],
    ],
  ];
  for (const [name, failures, expected] of cases) {
    await t.test(name, async (t) => {
      accessorReads = 0;
      const { fixture } = await providerScenario(t, {
        beforeBuild: ({ name }) => {
          const role = name.includes("/controller:") ? "controller" : "runtime";
          if (failures[role]) {
            throw failures[role];
          }
        },
      });
      await assert.rejects(fixture.prepare(), (error) => {
        assert.ok(error instanceof AggregateError);
        // Local callers keep the original errors; the CI message keeps only
        // failed roles and known process metadata, even with hostile fields.
        const expectedCauses = Object.values(failures);
        const causes = processErrors(error);
        assert.deepEqual(causes, expectedCauses);
        causes.forEach((cause, index) => assert.equal(cause, expectedCauses[index]));
        assert.deepEqual(
          error.message
            .replace(/^Checkout image builds failed: /, "")
            .split("; ")
            .map((message) => message.replace(/ elapsedMs=\d+ budgetMs=600000$/, "")),
          expected,
        );
        assert.equal(error.message.includes(privateOutput), false);
        assert.equal(accessorReads, 0, "error accessors must not execute during reporting");
        return true;
      });
    });
  }
});

test("checkout build cancellation before dispatch has no child process metadata", async (t) => {
  const controller = new AbortController();
  const { fixture, calls } = await providerScenario(t, {
    signal: controller.signal,
    // The other build is waiting for its serialized journal write. Abort now
    // so that its post-write cancellation check refuses dispatch to Docker.
    beforeBuild: () => controller.abort(),
  });
  await assert.rejects(fixture.prepare(), (error) => {
    assert.ok(error instanceof AggregateError);
    const causes = processErrors(error);
    const reason: unknown = controller.signal.reason;
    assert.equal(causes.length, 1);
    assert.equal(causes[0], reason);
    assert.equal(
      asRecord(causes[0])?.code,
      20,
      "the cancellation has a DOM code, not an exit code",
    );
    assert.match(error.message, /runtime: exit=unknown code=unknown signal=unknown killed=unknown/);
    return true;
  });
  assert.equal(calls.filter(({ args }) => args[0] === "buildx").length, 1);
});

test("checkout build journal failures have no child process metadata", async (t) => {
  const release = Promise.withResolvers<void>();
  let started = 0;
  const { fixture, directory } = await providerScenario(t, {
    beforeBuild: async () => {
      if (++started === 2) {
        // Both pre-dispatch writes have completed. Move the journal directory
        // so successful commands encounter a real ENOENT in the final write.
        try {
          await rename(directory, `${directory}.moved`);
        } finally {
          release.resolve();
        }
      }
      await release.promise;
    },
  });
  try {
    await assert.rejects(fixture.prepare(), (error) => {
      assert.ok(error instanceof AggregateError);
      const causes = processErrors(error);
      assert.equal(causes.length, 2);
      assert.ok(causes.every((cause) => asRecord(cause)?.code === "ENOENT"));
      for (const role of ["controller", "runtime"]) {
        assert.ok(
          error.message.includes(
            `${role}: exit=unknown code=unknown signal=unknown killed=unknown`,
          ),
        );
      }
      return true;
    });
  } finally {
    await rename(`${directory}.moved`, directory);
  }
  await fixture.cleanup();
});

test("provider reconciles a creation whose acknowledgement was lost", async (t) => {
  const { fixture, readJournal, objects } = await providerScenario(t, {
    failAfterCreate: true,
    failAfterRemove: true,
  });
  await assert.rejects(fixture.prepare(), /acknowledgement lost/);
  assert.equal(objects.size, 1);
  assert.equal((await readJournal()).resources.length, 1);
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  assert.equal(objects.size, 0);
  await fixture.cleanup();
  assert.deepEqual((await readJournal()).resources, []);
});

test("provider leaves pre-existing resources untouched", async (t) => {
  const { fixture, calls } = await providerScenario(t, { existingRegistry: true });
  await assert.rejects(fixture.prepare(), /already exists/);
  await fixture.cleanup();
  assert.equal(
    calls.some(({ args }) => args[0] === "run" || args[1] === "rm"),
    false,
  );
});

test("provider retains failed cleanup obligations and retries only the remainder", async (t) => {
  const { fixture, readJournal, objects } = await providerScenario(t, { failRemove: true });
  await fixture.prepare();
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  const remaining = (await readJournal()).resources;
  assert.equal(remaining.length, 1);
  assert.equal(objects.size, 1);
  await fixture.cleanup();
  assert.equal(objects.size, 0);
  assert.deepEqual((await readJournal()).resources, []);
});

test("provider retains the registry recovery obligation until removal succeeds", async (t) => {
  const { fixture, readJournal, objects } = await providerScenario(t, {
    failRemove: "-registry",
  });
  await fixture.prepare();
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  const remaining = (await readJournal()).resources;
  assert.equal(remaining.length, 1);
  const registry = asRecord(remaining[0]);
  assert.equal(registry?.kind, "container");
  const name = registry?.name;
  assert.ok(typeof name === "string");
  assert.match(name, /-registry$/);
  assert.equal(objects.size, 1);
  await fixture.cleanup();
  assert.equal(objects.size, 0);
  assert.deepEqual((await readJournal()).resources, []);
});

test("provider refuses changed ownership and unrelated cluster routing", async (t) => {
  const { fixture, directory, objects, calls } = await providerScenario(t);
  await fixture.prepare();
  await writeFile(join(directory, "state.json"), JSON.stringify({ cluster: "other-cluster" }));
  await assert.rejects(fixture.route(directory), /other-cluster/);
  assert.equal(
    calls.some(({ command }) => command === "kubectl"),
    false,
  );
  const provider = [...objects.values()].find(({ Id }) => Id.endsWith("-endpoint"));
  assert.ok(provider, "expected an owned provider endpoint");
  provider.Config.Labels[ownerLabel] = "another-owner";
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  assert.ok([...objects.values()].includes(provider), "unowned endpoint must survive cleanup");
});

test("provider DNS readiness requires the mapped provider, API Service and settled resolver", async () => {
  let observation = 0;
  const writes: unknown[] = [];
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
        const input = options?.input;
        assert.ok(typeof input === "string", "apply must receive the ConfigMap");
        const manifest: unknown = JSON.parse(input);
        writes.push(manifest);
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
        const lookup = lookups.shift();
        assert.ok(lookup, "unexpected lookup after readiness");
        return { stdout: JSON.stringify(lookup) };
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
  const { fixture, readJournal, objects, faults } = await providerScenario(t);
  await fixture.prepare();
  const before = await readJournal();
  const diagnostics: InspectDiagnostic[] = [
    () => "permission denied while connecting to the Docker API",
    (kind, name) => `Error response from daemon: No such ${kind}: ${name}-other`,
    (kind, name) =>
      `Error response from daemon: permission denied; last error: No such ${kind}: ${name}`,
  ];
  for (const diagnostic of diagnostics) {
    faults.inspectError = diagnostic;
    await assert.rejects(fixture.cleanup(), /recovery journal retained/);
    assert.deepEqual(await readJournal(), before);
    assert.equal(objects.size, before.resources.length);
  }
  faults.inspectError = undefined;
  await fixture.cleanup();
  assert.equal(objects.size, 0);
});

test("cleanup drains admitted image builds before reconciling their reservations", async (t) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const signals: Array<AbortSignal | undefined> = [];
  const { fixture, objects, directory, readJournal, calls } = await providerScenario(t, {
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
  const preparing = fixture.prepare().catch((error: unknown) => error);
  await started.promise;
  const cleaning = fixture.cleanup().catch((error: unknown) => error);
  const early = await Promise.race([cleaning.then(() => true), delay(40).then(() => false)]);
  const reserved = await readJournal();
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
  assert.ok(cleanupError instanceof Error, "cleanup must report the failed registry removal");
  assert.match(cleanupError.message, /recovery journal retained/);
  assert.equal(objects.size, 1, "only the failed registry removal remains");
  const remaining = await readJournal();
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
  let late: Creation | undefined;
  const { fixture, objects, directory, readJournal, calls } = await providerScenario(t, {
    signal: controller.signal,
    beforeCreate: async (creation) => {
      late = creation;
      controller.abort();
      throw new Error("creation response lost during cancellation");
    },
  });
  await assert.rejects(fixture.prepare(), /response lost/);
  await assert.rejects(fixture.cleanup(), /recovery journal retained/);
  const journal = await readJournal();
  assert.ok(late, "expected a create whose outcome remains uncertain");
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
  assert.deepEqual((await readJournal()).resources, []);
  assert.equal(calls.filter(({ args }) => args[0] === "run").length, 1);
});

test("cleanup before prepare permanently closes provider admission", async (t) => {
  const { fixture, directory, calls } = await providerScenario(t);
  await fixture.cleanup();
  await assert.rejects(fixture.prepare(), { name: "AbortError" });
  await assert.rejects(fixture.route(directory), { name: "AbortError" });
  assert.equal(calls.length, 0);
});

test("Node timeout teardown joins the actual launcher case owner and rejects later work", async (t) => {
  const directory = await temporaryDirectory(t, "oce-provider-timeout-");
  const trace = join(directory, "trace.jsonl");
  const root = join(directory, "case");
  const child = join(import.meta.dirname, "../fixtures/dev-up-model-provider-timeout.ts");
  // A separate node:test process must time out for real so its cancellation
  // cannot cancel this suite. The child uses the launcher owner and executor.
  const env: NodeJS.ProcessEnv = { ...process.env, OCC_TEST_PROVIDER_TIMEOUT_DIRECTORY: directory };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(
    execute(process.execPath, ["--test", child], { env, timeout: 10_000 }),
    (error: unknown) => {
      const result = asRecord(error);
      assert.equal(result?.code, 1);
      const stdout = result?.stdout;
      assert.ok(typeof stdout === "string");
      assert.match(stdout, /cancelled 1/);
      return true;
    },
  );
  const events: unknown[] = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  assert.deepEqual(events, [
    "command-started",
    "teardown-start",
    "process-settled",
    "body-settled",
    "teardown-end",
  ]);
  assert.equal(existsSync(root), false);
});

test("cleanup retries journal persistence without replaying completed removals", async (t) => {
  const { fixture, directory, readJournal, objects, calls } = await providerScenario(t);
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
  assert.deepEqual((await readJournal()).resources, []);
});

test("launcher case keeps recovery files after provider cleanup failure and permits cleanup retry", async (t) => {
  const { root, run, readJournal, environment, objects } = await providerScenario(t, {
    failRemove: "-registry",
  });
  environment.OCC_DEVELOPMENT_STATE_DIRECTORY = join(root, "state");
  const { scope, cleanup } = captureTeardown();
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
  assert.equal((await readJournal()).resources.length, 1);
  await cleanup();
  assert.equal(objects.size, 0);
  assert.equal(existsSync(root), false);
});

test("launcher case preserves recovery files after forced process termination", async (t) => {
  const root = await temporaryDirectory(t, "oce-provider-forced-");
  const { scope, cleanup } = captureTeardown();
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
