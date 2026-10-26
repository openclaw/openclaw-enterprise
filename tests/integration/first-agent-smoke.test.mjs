import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GATEWAY_STOP_TIMEOUT_MS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  STOP_PHASE_TIMEOUT_MS,
  agentStopDiagnostic,
  assertChatReply,
  bakeReferences,
  clusterEventLines,
  createApi,
  observeAgentStop,
  postgresImage,
  providerImageDockerfile,
  providerImageTag,
  publishPostgresImage,
  runtimeNodeBaseImage,
  smokeBakeDefinition,
  smokeImageEnvironment,
  smokeSlotNames,
  stoppedGatewaySummary,
  waitFor,
  watchCluster,
} from "../../scripts/ci/first-agent-smoke.mjs";
import { withEnvironment } from "../helpers/environment.mjs";
import { commandPath } from "../helpers/fake-commands.mjs";
import { listen } from "../helpers/listen.mjs";

const revision = "rev_00000000-0000-4000-8000-000000000001";
const chatNonce = "OCE_SMOKE_00000000-0000-4000-8000-000000000001";
const validChatReply = { status: 200, role: "assistant", content: chatNonce };

test("chat proof accepts the deterministic assistant answer", () => {
  for (const content of [chatNonce, ` \t${chatNonce}\r\n`]) {
    assertChatReply({ ...validChatReply, content }, chatNonce, "embedded");
  }
});

test("chat proof rejects a prompt echo, missing role, and other non-assistant replies", () => {
  const prompt = `Reply with exactly this nonce and no other text: ${chatNonce}`;
  for (const role of ["user", undefined, "tool"]) {
    assert.throws(
      () => assertChatReply({ ...validChatReply, role }, chatNonce, "embedded"),
      /reply was not an assistant message/,
    );
  }
  for (const content of [prompt, `Answer: ${chatNonce}`, `${chatNonce} extra`]) {
    assert.throws(
      () => assertChatReply({ ...validChatReply, content }, chatNonce, "embedded"),
      /assistant reply did not equal the nonce/,
    );
  }
});

test("chat proof still requires HTTP success and the current nonce as text", () => {
  assert.throws(() => assertChatReply({ ...validChatReply, status: 503 }, chatNonce, "embedded"), {
    actual: 503,
    expected: 200,
  });
  assert.throws(() => assertChatReply({}, chatNonce, "embedded"), /before an HTTP response/);
  assert.throws(
    () => assertChatReply({ status: 200, invalidResponse: true }, chatNonce, "embedded"),
    /unreadable response/,
  );
  for (const content of ["OCE_SMOKE_previous", undefined, [chatNonce]]) {
    assert.throws(
      () => assertChatReply({ ...validChatReply, content }, chatNonce, "embedded"),
      /assistant reply did not equal the nonce/,
    );
  }
});

test("smoke API sends its key only to the selected controller origin", async (t) => {
  const requests = [];
  const port = await listen(
    t,
    createServer((request, response) => {
      requests.push([request.url, request.headers["x-api-key"]]);
      response.end('{"data":"ok"}');
    }),
  );
  const host = "127.0.0.1:" + port;
  const key = "synthetic-smoke-key";
  assert.equal(await createApi("http://" + host, key)("GET", "/namespaces"), "ok");
  const other = createApi("http://127.0.0.1:1", key);
  await assert.rejects(other("GET", "//" + host + "/unexpected"), /outside the controller origin/);
  assert.deepEqual(requests, [["/namespaces", key]]);
});

test("smoke API refuses a redirect instead of resending its key", async (t) => {
  const requests = [];
  const serve = async (handler) => "http://127.0.0.1:" + (await listen(t, createServer(handler)));
  const elsewhere = await serve((request, response) => {
    requests.push([request.url, request.headers["x-api-key"]]);
    response.end('{"data":"ok"}');
  });
  const controller = await serve((request, response) => {
    response.writeHead(307, { location: elsewhere + "/collected" }).end();
  });
  await assert.rejects(
    createApi(controller, "synthetic-smoke-key")("GET", "/namespaces"),
    /^Error: GET \/namespaces: fetch failed: .*unexpected redirect$/,
  );
  assert.deepEqual(requests, []);
});

function virtualClock() {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
    advance: (ms) => {
      elapsed += ms;
    },
  };
}

function stoppedAt(clock, time) {
  return async () => ({
    desiredRuntimeState: "stopped",
    activeRevisionId: clock.now() < time ? revision : undefined,
    status: "active",
  });
}

test("stop observation accepts a fast shutdown and checks Pods afterward", async () => {
  const clock = virtualClock();
  let podReads = 0;
  await observeAgentStop(
    "embedded",
    stoppedAt(clock, 20_000),
    async () => {
      podReads += 1;
      return [];
    },
    clock,
  );
  assert.equal(clock.now(), 20_000);
  assert.equal(podReads, 1);
});

test("default stop observation covers the selected gateway grace", async () => {
  const clock = virtualClock();
  await observeAgentStop(
    "embedded",
    stoppedAt(clock, GATEWAY_STOP_TIMEOUT_MS - 15_000),
    async () => [],
    clock,
  );
  assert.ok(clock.now() > 300_000);
  assert.ok(clock.now() < GATEWAY_STOP_TIMEOUT_MS);
});

test("the second stop can wait behind the serial worker's first gateway drain", async () => {
  const clock = virtualClock();
  const activeClears = 2 * (GATEWAY_STOP_TIMEOUT_MS - 15_000);
  let observedPods = false;
  await observeAgentStop(
    "codex",
    stoppedAt(clock, activeClears),
    async () => {
      observedPods = true;
      return clock.now() < activeClears + 8_000 ? [{}] : [];
    },
    clock,
  );
  assert.equal(clock.now(), activeClears + 8_000);
  assert.ok(observedPods);
  assert.ok(clock.now() < STOP_PHASE_TIMEOUT_MS);
});

test("an explicit shorter deadline is authoritative and does not start a later Pod read", async () => {
  const clock = virtualClock();
  let podReads = 0;
  await assert.rejects(
    observeAgentStop(
      "embedded",
      stoppedAt(clock, 1_500),
      async () => {
        podReads += 1;
        return [];
      },
      { ...clock, timeout: 1_000 },
    ),
    /Timed out waiting for embedded to stop/,
  );
  assert.equal(clock.now(), 1_000);
  assert.equal(podReads, 0);
});

test("permanent nonconvergence retains the active-pointer assertion and bounded state", async () => {
  const clock = virtualClock();
  await assert.rejects(
    observeAgentStop("embedded", stoppedAt(clock, Infinity), async () => [], clock),
    (error) => {
      assert.match(error.message, /active-revision/);
      assert.match(error.message, /elapsedMs/);
      assert.ok(error.message.includes(revision));
      return true;
    },
  );
  assert.equal(clock.now(), STOP_PHASE_TIMEOUT_MS);
});

test("a desired-state reversal fails without accepting an empty active pointer", async () => {
  const clock = virtualClock();
  let podReads = 0;
  await assert.rejects(
    observeAgentStop(
      "embedded",
      async () => ({ desiredRuntimeState: "running" }),
      async () => {
        podReads += 1;
        return [];
      },
      clock,
    ),
    /desired state changed while stopping/,
  );
  assert.equal(podReads, 0);
});

test("an empty active pointer does not accept remaining Pods", async () => {
  const clock = virtualClock();
  await assert.rejects(
    observeAgentStop("embedded", stoppedAt(clock, 0), async () => [{}], {
      ...clock,
      timeout: 5_000,
    }),
    /"phase":"pods".*"remainingPods":1/,
  );
  assert.equal(clock.now(), 5_000);
});

test("both observation stages share the explicit deadline", async () => {
  const clock = virtualClock();
  await assert.rejects(
    observeAgentStop(
      "embedded",
      stoppedAt(clock, 8_000),
      async () => (clock.now() < 12_000 ? [{}] : []),
      { ...clock, timeout: 10_000 },
    ),
    /Pods to terminate/,
  );
  assert.equal(clock.now(), 10_000);
});

test("invalid bounds fail before any observation", async () => {
  for (const timeout of [0, -1, Infinity, NaN, 1.5, null]) {
    let reads = 0;
    await assert.rejects(
      observeAgentStop(
        "embedded",
        async () => {
          reads += 1;
        },
        async () => [],
        { timeout },
      ),
      /positive finite integer/,
    );
    await assert.rejects(
      waitFor(
        "invalid",
        async () => {
          reads += 1;
        },
        timeout,
      ),
      /positive finite integer/,
    );
    assert.equal(reads, 0);
  }
});

test("an observation that returns after its explicit deadline cannot report success", async () => {
  const clock = virtualClock();
  await assert.rejects(
    waitFor(
      "late",
      async () => {
        clock.advance(1_001);
        return { done: true };
      },
      1_000,
      clock,
    ),
    /Timed out waiting for late/,
  );
});

test("failed diagnostic reads return a fixed marker without exposing or throwing the error", async () => {
  const state = await agentStopDiagnostic(async () => {
    throw new Error("synthetic-private-value");
  });
  assert.deepEqual(state, { phase: "agent-state", unavailable: true });
  assert.ok(!JSON.stringify(state).includes("synthetic-private-value"));
});

test("diagnostics project only fixed lifecycle fields", async () => {
  assert.deepEqual(
    await agentStopDiagnostic(async () => ({
      desiredRuntimeState: "stopped",
      activeRevisionId: revision,
      status: "active",
      unrelated: "synthetic-private-value",
    })),
    {
      phase: "agent-state",
      desiredRuntimeState: "stopped",
      activeRevisionId: revision,
      status: "active",
    },
  );
  const invalid = await agentStopDiagnostic(async () => ({
    desiredRuntimeState: "synthetic-private-value",
    activeRevisionId: "synthetic-private-value",
    status: "synthetic-private-value",
  }));
  assert.deepEqual(invalid, {
    phase: "agent-state",
    desiredRuntimeState: "unknown",
    activeRevisionId: "invalid",
    status: "unknown",
  });
});

test("a stopped gateway summary names its shutdown outcome and every clean-close receipt", () => {
  // Raw container lines, as kubectl logs returns them.
  const line = (subsystem, message) => JSON.stringify({ level: "info", subsystem, message });
  assert.equal(
    stoppedGatewaySummary(
      [
        line("gateway", "received SIGTERM; shutting down"),
        line("state/agent-db", "agent database clean-close receipt: active-leases"),
        line("state/agent-db", "agent database clean-close receipt: written"),
        line("gateway/shutdown", "shutdown completed cleanly in 513ms"),
      ].join("\n"),
    ),
    "shutdown completed cleanly; clean-close receipts: active-leases, written",
  );
  assert.equal(
    stoppedGatewaySummary(
      [
        line("plugins", "Local model service shutdown failed: synthetic"),
        line("gateway/shutdown", "shutdown completed in 900ms with warnings: memory-managers"),
      ].join("\n"),
    ),
    "shutdown completed with warnings; clean-close receipts: none",
  );
  assert.equal(
    stoppedGatewaySummary(line("gateway/shutdown", "shutdown failed in 12ms: plugin-registry")),
    "shutdown failed; clean-close receipts: none",
  );
  // Finding 2198's shape: the Gateway stopped, but no receipt was logged.
  assert.equal(
    stoppedGatewaySummary(line("gateway", "received SIGTERM; shutting down")),
    "shutdown not logged; clean-close receipts: none",
  );
});

// Run the real watcher with real timers and no cluster. A `k3d` stand-in on PATH
// records each lookup and fails, as it does once `occ dev up` deletes its cluster.
async function withRecordedK3d(operation) {
  const directory = await mkdtemp(join(tmpdir(), "first-agent-smoke-k3d-"));
  const calls = join(directory, "calls");
  await writeFile(join(directory, "k3d"), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 1\n`, {
    mode: 0o755,
  });
  try {
    const started = Date.now();
    await withEnvironment({ PATH: commandPath(directory) }, operation);
    return {
      seconds: (Date.now() - started) / 1000,
      calls: await readFile(calls, "utf8").catch(() => ""),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a successful setup stops an idle watcher at once without another capture", async () => {
  const { seconds, calls } = await withRecordedK3d(() => watchCluster()());
  // The watcher idles for 30 seconds between captures; stopping must not wait for one.
  assert.ok(seconds < 5, `stop took ${seconds}s`);
  assert.equal(calls, "");
});

test("a failed setup stops the watcher at once with one final capture", async () => {
  const { seconds, calls } = await withRecordedK3d(() => watchCluster()({ finalCapture: true }));
  // The final snapshot keeps diagnostics for the failure without the idle wait.
  assert.ok(seconds < 5, `stop took ${seconds}s`);
  const { cluster } = smokeSlotNames(process.env.OCC_FIRST_AGENT_SMOKE_SLOT);
  assert.equal(calls, `kubeconfig get ${cluster}\n`);
});

test("smoke slots keep CI's names at slot 0 and give other slots distinct host resources", () => {
  const ci = {
    cluster: "occ-dev-first-agent-smoke",
    registryContainer: "oce-first-agent-smoke-registry",
    registry: "127.0.0.1:5000",
    model: "oce-first-agent-smoke-model",
    subnet: "11.111.0.0/29",
    modelAddress: "11.111.0.2",
    nodeModelAddress: "11.111.0.3",
  };
  for (const unset of [undefined, "", "0"]) {
    assert.deepEqual(smokeSlotNames(unset), ci);
  }
  assert.deepEqual(smokeSlotNames("2"), {
    cluster: "occ-dev-smoke-s2",
    registryContainer: "oce-smoke-s2-registry",
    registry: "127.0.0.1:15002",
    model: "oce-smoke-s2-model",
    subnet: "11.111.0.16/29",
    modelAddress: "11.111.0.18",
    nodeModelAddress: "11.111.0.19",
  });
  assert.equal(smokeSlotNames("31").subnet, "11.111.0.248/29");
  const slots = Array.from({ length: 32 }, (_, slot) => smokeSlotNames(String(slot)));
  for (const field of Object.keys(ci)) {
    assert.equal(new Set(slots.map((names) => names[field])).size, 32, field);
  }
});

test("a malformed or out-of-range smoke slot fails with the setting's name", () => {
  for (const value of ["-1", "32", "100", "01", "1.5", " 1", "1 ", "0x1", "one"]) {
    assert.throws(
      () => smokeSlotNames(value),
      /^Error: OCC_FIRST_AGENT_SMOKE_SLOT must be an integer from 0 to 31, got /,
      value,
    );
  }
});

test("cluster events print oldest to newest by observed instant, whatever field carries it", () => {
  const event = (name, times, count) => ({
    metadata: { namespace: "occ-agent", name: `${name}.1` },
    involvedObject: { kind: "Pod", name: "harness-0" },
    type: "Normal",
    reason: name,
    message: `${name} message`,
    ...(count && { count }),
    ...times,
  });
  const second = "2026-10-23T00:00:10";
  const lines = clusterEventLines({
    items: [
      // eventTime-only writers have no lastTimestamp; --sort-by=.lastTimestamp printed them first.
      event("Newest", { eventTime: "2026-10-23T00:00:12.000001Z" }),
      event("SeriesLatest", {
        eventTime: "2026-10-23T00:00:01.000000Z",
        series: { lastObservedTime: "2026-10-23T00:00:11.500000Z", count: 4 },
      }),
      // Text order puts "10.100000Z" before "10Z"; the whole-second event is the older one.
      event("FractionalSameSecond", { eventTime: `${second}.100000Z` }),
      event(
        "WholeSecond",
        { firstTimestamp: "2026-10-23T00:00:00Z", lastTimestamp: `${second}Z` },
        3,
      ),
      event("Undated", {}),
    ],
  }).split("\n");
  assert.deepEqual(lines, [
    "unknown-time occ-agent Normal Undated Pod/harness-0: Undated message",
    `${second}Z occ-agent Normal WholeSecond Pod/harness-0 x3: WholeSecond message`,
    `${second}.100000Z occ-agent Normal FractionalSameSecond Pod/harness-0: FractionalSameSecond message`,
    "2026-10-23T00:00:11.500000Z occ-agent Normal SeriesLatest Pod/harness-0 x4: SeriesLatest message",
    "2026-10-23T00:00:12.000001Z occ-agent Normal Newest Pod/harness-0: Newest message",
  ]);
});

const bakeInput = {
  revision: "0123456789abcdef0123456789abcdef01234567",
  controllerTag: "127.0.0.1:5000/oce-smoke/controller:0123456789abcdef0123456789abcdef01234567",
  smokeRuntimeTag: "127.0.0.1:5000/oce-smoke/runtime:0123456789abcdef0123456789abcdef01234567",
  context: "/work/runtime-trust",
  providerContext: "/work/provider-image",
  nodeRuntimeBaseImage: `docker.io/library/node:24-bookworm-slim@sha256:${"a".repeat(64)}`,
  openclawSource: {
    commit: "b".repeat(40),
    sourceArchiveSha256: "c".repeat(64),
    buildTimestamp: "2026-01-02T03:04:05Z",
  },
  registryAddress: "172.17.0.3:5000",
  caches: (role) => [`cache-${role}`],
};
const pushOutput = (name) =>
  `type=image,name=172.17.0.3:5000/oce-smoke/${name}:${bakeInput.revision},push=true,registry.insecure=true`;

test("the smoke bake only pushes the controller and runtime images, and loads the provider image", () => {
  const { target } = smokeBakeDefinition({ ...bakeInput, load: false });
  assert.deepEqual(target["smoke-controller"].output, [pushOutput("controller")]);
  assert.deepEqual(target["smoke-runtime"].output, [pushOutput("runtime")]);
  assert.deepEqual(target["smoke-controller"].labels, {
    "org.opencontainers.image.revision": bakeInput.revision,
  });
  // The upstream source identity must remain distinct from the OCE revision.
  assert.deepEqual(target["smoke-runtime-base"].args, {
    OPENCLAW_COMMIT: bakeInput.openclawSource.commit,
    OPENCLAW_SOURCE_SHA256: bakeInput.openclawSource.sourceArchiveSha256,
    OPENCLAW_BUILD_TIMESTAMP: bakeInput.openclawSource.buildTimestamp,
    OCC_BUILD_REVISION: bakeInput.revision,
    SOURCE_DATE_EPOCH: "0",
  });
  assert.deepEqual(target["smoke-provider"], {
    context: "/work/provider-image",
    contexts: { "smoke-runtime-base": "target:smoke-runtime-base" },
    args: { NODE_RUNTIME_BASE_IMAGE: bakeInput.nodeRuntimeBaseImage },
    output: [`type=docker,name=oce-first-agent-smoke-model-provider:${bakeInput.revision}`],
  });
  for (const definition of Object.values(target)) {
    for (const output of definition.output ?? []) {
      assert.ok(
        !output.startsWith("type=docker") || definition === target["smoke-provider"],
        output,
      );
    }
  }
});

test("the prepared-Git bake still loads both images and builds no provider image", () => {
  const { target } = smokeBakeDefinition({ ...bakeInput, load: true });
  assert.deepEqual(target["smoke-controller"].output, [
    `type=docker,name=${bakeInput.controllerTag}`,
    pushOutput("controller"),
  ]);
  assert.deepEqual(target["smoke-runtime"].output, [
    `type=docker,name=${bakeInput.smokeRuntimeTag}`,
    pushOutput("runtime"),
  ]);
  assert.equal(target["smoke-provider"], undefined);
});

test("only the registry acceptance selects the loopback registry and the PostgreSQL copy", () => {
  const images = {
    registryContainer: "oce-first-agent-smoke-registry",
    controller: `127.0.0.1:5000/oce-smoke/controller@sha256:${"1".repeat(64)}`,
    runtime: `127.0.0.1:5000/oce-smoke/runtime@sha256:${"2".repeat(64)}`,
    postgres: `127.0.0.1:5000/oce-smoke/postgres@sha256:${"3".repeat(64)}`,
    modelDirectory: "/work/model",
  };
  const common = {
    OCC_DEVELOPMENT_CONTROLLER_IMAGE: images.controller,
    OCC_KUBERNETES_RUNTIME_IMAGE: images.runtime,
    OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY: images.modelDirectory,
  };
  assert.deepEqual(smokeImageEnvironment({ ...images, preparedGit: false }), {
    ...common,
    OCC_DEVELOPMENT_IMAGE_REGISTRY_CONTAINER: images.registryContainer,
    OCC_DEVELOPMENT_POSTGRES_IMAGE: images.postgres,
  });
  // The prepared-Git acceptance imports every image from an archive: neither
  // setting may reach Local Setup, even when a PostgreSQL copy exists.
  const repository = {
    OCC_DEVELOPMENT_REPOSITORY_IMAGE: `127.0.0.1:5000/oce-smoke/repository@sha256:${"4".repeat(64)}`,
    OCC_SKIPPER_IMAGE_REGISTRY_CONTAINER: images.registryContainer,
  };
  assert.deepEqual(smokeImageEnvironment({ ...images, preparedGit: true, repository }), {
    ...repository,
    ...common,
  });
});

test("bake metadata selects both pushed images by registry digest", () => {
  const digest = (character) => `sha256:${character.repeat(64)}`;
  const metadata = {
    "smoke-controller": { "containerimage.digest": digest("1") },
    "smoke-runtime": { "containerimage.digest": digest("2") },
    "smoke-provider": { "containerimage.config.digest": digest("3") },
  };
  assert.deepEqual(bakeReferences(metadata, bakeInput), [
    `127.0.0.1:5000/oce-smoke/controller@${digest("1")}`,
    `127.0.0.1:5000/oce-smoke/runtime@${digest("2")}`,
  ]);
  for (const name of ["smoke-controller", "smoke-runtime"]) {
    const incomplete = structuredClone(metadata);
    // A non-hex value, and hex digests one character short and one too long.
    for (const value of ["sha256:short", `sha256:${"1".repeat(63)}`, `sha256:${"1".repeat(65)}`]) {
      incomplete[name]["containerimage.digest"] = value;
      assert.throws(
        () => bakeReferences(incomplete, bakeInput),
        new RegExp(`no containerimage.digest for ${name}`),
      );
    }
  }
  // The provider runs by its per-slot, per-revision name, in either engine image store.
  assert.equal(
    providerImageTag(bakeInput.revision),
    `oce-first-agent-smoke-model-provider:${bakeInput.revision}`,
  );
});

test("the provider image is the runtime's pinned Node base with only the runtime's ws package", async () => {
  const dockerfile = await readFile(
    new URL("../../deploy/runtime/Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(
    runtimeNodeBaseImage(dockerfile),
    /^docker\.io\/library\/node:24-[^@]+@sha256:[a-f0-9]{64}$/,
  );
  assert.throws(
    () => runtimeNodeBaseImage("ARG NODE_RUNTIME_BASE_IMAGE=node:24-bookworm-slim\n"),
    /pins no/,
  );
  assert.deepEqual(providerImageDockerfile.trim().split("\n"), [
    "ARG NODE_RUNTIME_BASE_IMAGE",
    "FROM ${NODE_RUNTIME_BASE_IMAGE}",
    "COPY --from=smoke-runtime-base /app/node_modules/ws/ /app/node_modules/ws/",
    `RUN node -e 'if (typeof require("/app/node_modules/ws").WebSocketServer !== "function") process.exit(1)'`,
    "USER node",
  ]);
  // The stand-in loads ws from that path.
  const endpoint = await readFile(
    new URL("../fixtures/runtime-model-probe-endpoint.mjs", import.meta.url),
    "utf8",
  );
  assert.match(endpoint, /createRequire\("\/app\/node_modules\/ws\/package\.json"\)\("ws"\)/);
});

test("the smoke copies Local Setup's PostgreSQL pin, not another image", async () => {
  const source = await readFile(
    new URL("../../internal/occdev/openshell_k3d.go", import.meta.url),
    "utf8",
  );
  assert.equal(postgresImage, /developmentPostgres\s*=\s*"([^"]+)"/.exec(source)?.[1]);
  assert.match(postgresImage, /@sha256:[a-f0-9]{64}$/);
});

const pinnedPostgresId = `sha256:${"c".repeat(64)}`;

// A fake engine and registry for publishPostgresImage. The registry serves
// `manifest` under the digest the push reports, unless `servedDigest` differs.
function postgresCopyFixture({
  config = pinnedPostgresId,
  servedDigest,
  status = 200,
  driverStatus = '[["Backing Filesystem","extfs"]]',
} = {}) {
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: { digest: config },
      layers: [],
    }),
  );
  const digest = servedDigest ?? `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  const commands = [];
  const pulls = [];
  const fetches = [];
  return {
    commands,
    pulls,
    fetches,
    digest,
    pull: async (image) => {
      pulls.push(image);
    },
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      const joined = args.join(" ");
      if (joined === "info --format {{json .DriverStatus}}") {
        return { stdout: `${driverStatus}\n` };
      }
      if (joined === `image inspect --format {{.Id}} ${postgresImage}`) {
        return { stdout: `${pinnedPostgresId}\n` };
      }
      if (joined.startsWith("push ")) {
        return {
          stdout: `The push refers to repository [127.0.0.1:5000/oce-smoke/postgres]\n18.6: digest: ${digest} size: 3036\n`,
        };
      }
      return { stdout: "" };
    },
    fetchRegistry: async (url, init) => {
      fetches.push({ url, accept: init.headers.accept, redirect: init.redirect });
      return new Response(manifest, { status });
    },
  };
}

test("the PostgreSQL copy pulls the pin and returns the loopback registry digest", async () => {
  const fixture = postgresCopyFixture();
  const reference = await publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture });
  assert.equal(reference, `127.0.0.1:5000/oce-smoke/postgres@${fixture.digest}`);
  assert.deepEqual(fixture.pulls, [postgresImage]);
  assert.deepEqual(fixture.commands, [
    ["docker", "info", "--format", "{{json .DriverStatus}}"],
    ["docker", "image", "inspect", "--format", "{{.Id}}", postgresImage],
    // Tagged by the verified image ID, never by a name that could resolve elsewhere.
    ["docker", "tag", pinnedPostgresId, "127.0.0.1:5000/oce-smoke/postgres:18.6"],
    ["docker", "push", "127.0.0.1:5000/oce-smoke/postgres:18.6"],
  ]);
  assert.deepEqual(fixture.fetches, [
    {
      url: `http://127.0.0.1:5000/v2/oce-smoke/postgres/manifests/${fixture.digest}`,
      accept:
        "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
      redirect: "error",
    },
  ]);
});

test("the PostgreSQL copy refuses a registry manifest that names another image", async () => {
  const fixture = postgresCopyFixture({ config: `sha256:${"e".repeat(64)}` });
  await assert.rejects(
    publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture }),
    /the registry copy of PostgreSQL is not the pinned image/,
  );
});

test("the PostgreSQL copy refuses manifest bytes that do not match the recorded digest", async () => {
  const fixture = postgresCopyFixture({ servedDigest: `sha256:${"f".repeat(64)}` });
  await assert.rejects(
    publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture }),
    /the registry manifest does not match/,
  );
});

test("the PostgreSQL copy needs a loopback registry and touches nothing otherwise", async () => {
  for (const registry of ["0.0.0.0:5000", "registry.example:5000", "127.0.0.1", "localhost:5000"]) {
    const fixture = postgresCopyFixture();
    await assert.rejects(
      publishPostgresImage({ registry, ...fixture }),
      /the PostgreSQL copy needs a loopback registry/,
      registry,
    );
    assert.deepEqual([fixture.pulls, fixture.commands, fixture.fetches], [[], [], []], registry);
  }
});

test("the PostgreSQL copy refuses a registry that does not serve the pushed manifest", async () => {
  const fixture = postgresCopyFixture({ status: 404 });
  await assert.rejects(
    publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture }),
    /registry manifest 127\.0\.0\.1:5000\/oce-smoke\/postgres@sha256:[a-f0-9]{64}: HTTP 404/,
  );
});

test("the PostgreSQL copy needs the digest docker push reports", async () => {
  const fixture = postgresCopyFixture();
  const runCommand = fixture.runCommand;
  fixture.runCommand = async (command, args) =>
    args[0] === "push" ? { stdout: "pushed\n" } : runCommand(command, args);
  await assert.rejects(
    publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture }),
    /docker push reported no digest/,
  );
  assert.deepEqual(fixture.fetches, []);
});

test("with the containerd image store PostgreSQL keeps the archive path", async () => {
  const fixture = postgresCopyFixture({
    driverStatus: '[["driver-type","io.containerd.snapshotter.v1"]]',
  });
  assert.equal(await publishPostgresImage({ registry: "127.0.0.1:5000", ...fixture }), undefined);
  assert.deepEqual(fixture.pulls, []);
  assert.deepEqual(fixture.commands, [["docker", "info", "--format", "{{json .DriverStatus}}"]]);
});
