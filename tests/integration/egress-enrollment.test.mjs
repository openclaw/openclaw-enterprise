import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { json } from "node:stream/consumers";
import test from "node:test";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  HARNESS_EGRESS_ENROLLMENT_PATH,
  COMPUTE_RELEASE_PUBLIC_KEY,
  computeReleasePublicKey,
  signComputeExecutionRelease,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import {
  pluginRuntimeEnvironment,
  pluginRuntimeSpecForRevision,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

import { reservePort, reservedPortArgs } from "../helpers/available-port.mjs";
import { waitFor } from "../helpers/qa-utils.mjs";
import { listen } from "../helpers/listen.mjs";
import { writeCommand } from "../helpers/fake-commands.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const token = "synthetic-harness-transport";
const serviceUrl = "http://fixture-harness.example.test/";
const path = HARNESS_EGRESS_ENROLLMENT_PATH;
// The native CLI is the only substituted process. Its exec command sends one
// local HTTP request through the real authority fixture, and its app-server
// implements only the authenticated transport handshake. This proves generated
// startup coordination, not packaged Codex or installed supervisor enforcement.
function nativeCli(callsPath, modelUrl) {
  return `const fs = require("node:fs");
const { createHash } = require("node:crypto");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args.includes("login")) {
  fs.readFileSync(0, "utf8");
} else if (args.includes("exec")) {
  fetch(${JSON.stringify(modelUrl)}, { method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({ model: "fixture-model", input: "READY", store: false }) }).then(async (response) => {
      if (response.status !== 200) throw new Error("fixture request refused");
      await response.arrayBuffer();
      console.log(JSON.stringify({ type: "turn.started" }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "READY" } }));
      console.log(JSON.stringify({ type: "turn.completed" }));
    }).catch(() => { process.exitCode = 1; });
} else if (args.includes("app-server")) {
  const verifier = args[args.indexOf("--ws-token-sha256") + 1];
  const server = require("node:http").createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, socket) => {
    if (createHash("sha256").update((request.headers.authorization ?? "").slice(7)).digest("hex") !== verifier) {
      socket.end("HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n");
      return;
    }
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.end("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
  });
  server.listen(Number(new URL(args[args.indexOf("--listen") + 1]).port), "127.0.0.1");
} else {
  process.exitCode = 1;
}
`;
}

test(
  "protected Harness waits for committed installation and rejects stale startup releases before its first model request",
  { timeout: 30000 },
  async (t) => {
    const directory = await temporaryDirectory(t, "egress-enrollment-");
    let reservation = await reservePort({ host: "0.0.0.0" });
    t.after(() => reservation.release());
    const { port } = reservation;
    const transport = new GrpcOpenShellGatewayClient({ endpoint: `http://127.0.0.1:${port}` });
    t.after(() => transport.close());
    const compute = createTestKubernetesComputeDriver("launch-compute", { channelRuntime: true });
    const f = await staticEgressFixture(t, {
      // Keep local lifecycle observations, but run the actual Compute admission at
      // the normal deploy route and read its immutable result back from State.
      appFactory: (t, options) =>
        createConsoleAppFixture(t, {
          ...options,
          computeDriver: {
            ...options.computeDriver,
            id: compute.id,
            implementation: compute.implementation,
            admitRevision: compute.admitRevision.bind(compute),
          },
        }),
      recordInstallation: false,
      physicalPlacement: true,
      serviceTransport: transport,
    });
    f.observed.service = {
      url: serviceUrl,
      endpoint: {
        sandbox: f.observed.sandbox.name,
        name: "",
        target_port: port,
        authorization_mode: 2,
      },
    };
    let businessRequests = 0;
    let businessError;
    const model = createServer(async (request, response) => {
      businessRequests++;
      try {
        const captured = f.capture(await json(request));
        const resolved = await f.resolve(captured);
        assert.ok(
          resolved.ready,
          "the first business request must find genuine committed enrollment",
        );
        const permit = await f.authorize(f.permitRequest(captured, resolved.ready));
        assert.ok(permit.allowed);
        const protectedResponse = await f.protect(captured, await f.send(captured, resolved.ready));
        assert.ok(protectedResponse.body);
        response.writeHead(200).end(protectedResponse.body);
      } catch (error) {
        businessError = error.message;
        response.writeHead(503).end();
      }
    });
    await listen(t, model);
    const modelPort = model.address().port;
    const callsPath = join(directory, "calls.jsonl");
    const script = join(directory, "entrypoint.cjs");
    assert.equal(f.revision.compute.admission, "protected-codex-no-connection-retry:v1");
    const legacy = { ...f.revision, compute: { ...f.revision.compute, admission: undefined } };
    assert.equal(compute.pluginRuntimeSnapshot(legacy).entrypoint, AGENT_RUNTIME_ENTRYPOINT);
    const ordinary = {
      ...legacy,
      executionAdmission: { version: 2, mode: "unprotected" },
      egressPlan: undefined,
      sandboxDriverId: undefined,
    };
    assert.equal(compute.admitRevision(ordinary), undefined);
    for (const revision of [
      { ...ordinary, compute: f.revision.compute },
      { ...legacy, compute: { ...legacy.compute, admission: "unknown:v1" } },
    ]) {
      assert.throws(() => compute.pluginRuntimeSnapshot(revision), /Compute admission is invalid/);
    }
    await writeFile(script, compute.pluginRuntimeSnapshot(f.revision).entrypoint);
    await writeFile(callsPath, "");
    await writeCommand(
      directory,
      "codex",
      nativeCli(callsPath, `http://127.0.0.1:${modelPort}/v1/responses`),
      { interpreter: process.execPath },
    );
    const runtime = pluginRuntimeSpecForRevision(
      f.revision,
      undefined,
      "https://provider.example.test/v1",
    );
    const { privateKey } = generateKeyPairSync("ed25519");
    const environment = {
      [COMPUTE_RELEASE_PUBLIC_KEY]: computeReleasePublicKey(privateKey),
      PATH: `${directory}:${dirname(process.execPath)}`,
      HOME: directory,
      TMPDIR: directory,
      CODEX_HOME: join(directory, "home"),
      CODEX_LOGIN_MODE: "api_key",
      OPENAI_API_KEY: "nonsecret-client-marker",
      OPENCLAW_HARNESS_MODEL: "codex/fixture-model",
      OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
      OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: f.revision.id,
      APP_SERVER_PORT: String(port),
      APP_TOKEN_SHA: createHash("sha256").update(token).digest("hex"),
      // The Node fixture CLI inherits this preload through the generated Harness.
      NODE_OPTIONS: reservedPortArgs(reservation).join(" "),
      ...pluginRuntimeEnvironment(runtime),
    };
    const start = () => {
      const child = spawn(process.execPath, [script], {
        env: environment,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const exited = once(child, "exit");
      let diagnostics = "";
      child.stderr.on("data", (chunk) => {
        diagnostics += chunk;
      });
      const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await exited;
        }
      };
      t.after(stop);
      return { stop, diagnostics: () => diagnostics };
    };
    const getChallenge = async () =>
      waitFor(
        "authenticated enrollment challenge",
        async () => {
          assert.equal(
            businessRequests,
            0,
            "startup must not send a business request before enrollment",
          );
          try {
            const document = await transport.getServiceDocument(
              serviceUrl,
              path,
              token,
              AbortSignal.timeout(1000),
            );
            return document.status === 200 && document.json;
          } catch {
            return undefined;
          }
        },
        10000,
        { interval: 20 },
      );
    const calls = async () =>
      (await readFile(callsPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    const first = start();
    const oldChallenge = await getChallenge();
    await reservation.release();
    assert.equal(oldChallenge.execution.executionId, f.revision.egressPlan.execution.executionId);
    assert.equal(businessRequests, 0);
    assert.equal((await calls()).length, 0, "no Codex, login or probe is started before release");
    assert.equal(f.providerRequests.length, 0);
    assert.equal(
      await f.controller.transact((unit) =>
        unit.credentialSources.findEgressInstallation(
          f.installation.sender.id,
          f.installation.sandboxId,
        ),
      ),
      undefined,
    );

    const post = (body, bearer = token) =>
      transport.postServiceDocument(serviceUrl, path, bearer, body, AbortSignal.timeout(2000));
    assert.equal((await post(oldChallenge, "wrong-token")).status, 401);
    for (const change of [
      {}, // An Agent bearer cannot echo a challenge to release the Harness.
      { execution: { ...oldChallenge.execution, executionId: "wrong-execution" } },
      { plan: { ...oldChallenge.plan, generation: 2 } },
    ]) {
      assert.equal((await post({ ...oldChallenge, ...change })).status, 409);
    }
    assert.equal(businessRequests, 0);

    // Restart creates a new challenge even for the same admitted plan. A response
    // held by an earlier controller request cannot release the replacement process.
    // Reacquire the hold before stopping the listener, then release only after its successor binds.
    reservation = await reservePort({ host: "0.0.0.0", port });
    await first.stop();
    const second = start();
    const currentChallenge = await getChallenge();
    await reservation.release();
    assert.notEqual(currentChallenge.startupId, oldChallenge.startupId);
    assert.equal((await post(oldChallenge)).status, 409);
    assert.equal(businessRequests, 0);

    const signal = AbortSignal.timeout(10000);
    const enrollmentContext = {
      ...f.context,
      kubernetes: {},
      signal,
      transportToken: token,
      requirements: {
        loginMode: "api_key",
        image: "harness-fixture:local",
        command: ["node", script],
        workspaceMounts: [],
        credentialAttachments: [],
        // Provision takes the Proxy's wiring. Observation below takes the full installed policy.
        proxyWiring: await f.egress.configureRevision({ ...f.context, signal }),
        labels: { "openclaw.dev/revision": f.revision.id },
        files: [],
        environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
      },
    };
    // Unsupported Harnesses must refuse before provisioning starts a process that
    // lacks this enrollment gate. The legacy unprotected path remains separate.
    await assert.rejects(
      f.sandboxDriver.provisionHarness({
        ...enrollmentContext,
        revision: { ...f.revision, harness: { ...f.revision.harness, id: "openclaw" } },
      }),
      {
        code: "SANDBOX_HARNESS_UNSUPPORTED",
        message: "Protected inference startup enrollment requires the dedicated Codex Harness.",
      },
    );
    // Consume the same independently verified adapter observation that Compute
    // commits. State is real; this test does not manufacture an installation receipt.
    const installed = await f.egress.wiringStatus({ ...f.context, signal }, f.attachment);
    assert.ok(installed);
    await f.controller.transact((unit) =>
      unit.credentialSources.recordEgressInstallation(installed),
    );
    assert.equal(businessRequests, 0, "committing alone must not start a model request");
    await assert.rejects(
      f.sandboxDriver.enrollHarness(enrollmentContext, {
        ...installed,
        sandboxId: "another-sandbox-instance",
      }),
      /installed Sandbox/,
    );
    const wrongExecutionPlan = {
      ...installed.plan,
      execution: { ...installed.plan.execution, executionId: "another-execution" },
    };
    await assert.rejects(
      f.sandboxDriver.enrollHarness(
        { ...enrollmentContext, revision: { ...f.revision, egressPlan: wrongExecutionPlan } },
        { ...installed, plan: wrongExecutionPlan },
      ),
      /admitted execution/,
    );
    assert.equal(
      businessRequests,
      0,
      "a different installed instance or execution cannot release startup",
    );
    const release = async (startupId) => {
      const current = await f.controller.transact((state) =>
        state.credentialSources.findRevisionEgressInstallation(f.namespace.id, f.revision.id),
      );
      assert.deepEqual(current, installed);
      assert.equal(await f.egress.verifyInstallation(f.context, current), true);
      return signComputeExecutionRelease(privateKey, startupId, current);
    };
    assert.equal(
      (await post(await release(oldChallenge.startupId))).status,
      409,
      "signed old startup cannot release its replacement",
    );
    await f.sandboxDriver.enrollHarness(enrollmentContext, installed, release);
    await waitFor(
      "authenticated app-server",
      () =>
        transport
          .serviceWebSocketHandshake(serviceUrl, token, AbortSignal.timeout(1000))
          .catch(() => false),
      10000,
      {
        interval: 20,
        describe: () => [businessError, second.diagnostics()].filter(Boolean).join("\n"),
      },
    );
    assert.equal(businessRequests, 1, second.diagnostics());
    assert.equal(f.providerRequests.length, 1);
    const probes = (await calls()).filter((args) => args.includes("exec"));
    assert.equal(probes.length, 1);
    assert.ok(probes[0].includes("model_providers.openai-compatible.request_max_retries=0"));
    assert.ok(probes[0].includes("model_providers.openai-compatible.stream_max_retries=0"));
    const servers = (await calls()).filter((args) => args.includes("app-server"));
    assert.equal(servers.length, 1);
    for (const args of [probes[0], servers[0]]) {
      const feature = args.indexOf("unbounded_connection_retries");
      assert.ok(feature > 0);
      assert.equal(args[feature - 1], "--disable");
    }
    // A repeated reconciliation observes the already-serving Harness and cannot
    // replay either the release or the first model request.
    await f.sandboxDriver.enrollHarness(enrollmentContext, installed, () =>
      assert.fail("already serving; no release requested"),
    );
    assert.equal(businessRequests, 1);
    assert.equal((await calls()).filter((args) => args.includes("exec")).length, 1);
  },
);

test("zero-route admission has no business allow and an older supplier cannot claim its execution authority", async (t) => {
  const f = await staticEgressFixture(t, { recordInstallation: false });
  const plan = { ...f.context.plan, routes: [] };
  const context = { ...f.context, plan, revision: { ...f.revision, egressPlan: plan } };
  const { configuration } = await f.egress.configureRevision(context);
  assert.deepEqual(
    configuration.network_policies,
    {},
    "empty protected routes do not select an unprotected default",
  );
  const middleware = configuration.network_middlewares["oce-egress"];
  assert.equal(middleware.execution_authority, true);
  assert.deepEqual(middleware.endpoints.include, ["deny-egress.invalid"]);
  const policy = { ...f.attachment.configuration, ...configuration };
  const attachment = { plan, configuration: policy };
  const observed = f.observed;
  observed.policy = policy;
  observed.observation.effective_policy = policy;
  const installed = await f.egress.wiringStatus(context, attachment);
  assert.equal(installed?.enforcement.authorityScope, "execution");
  assert.ok(await f.egress.verifyInstallation(context, installed));
  const current = observed.evidence.enforced_capabilities;
  const old = current.filter((cap) => !cap.endsWith(".protected-no-material.v1"));
  observed.evidence.enforced_capabilities = old;
  assert.equal(
    await f.egress.wiringStatus(context, attachment),
    undefined,
    "fresh gateway, old loaded supervisor",
  );
  assert.equal(await f.egress.verifyInstallation(context, installed), false);
  observed.evidence.enforced_capabilities = [...current].sort();
  assert.equal(
    await f.egress.wiringStatus(context, attachment),
    undefined,
    "loaded enforcement evidence must retain its canonical order",
  );
  observed.evidence.enforced_capabilities = current;
  const widened = {
    ...policy,
    network_policies: { unexpected: { endpoints: [{ host: "deny-egress.invalid" }] } },
  };
  await assert.rejects(
    f.egress.wiringStatus(context, { plan, configuration: widened }),
    /changed protected egress routes/,
  );
  const assertAvailable = () => f.egress.sourceControl.assertAvailable(AbortSignal.timeout(5000));
  await assertAvailable();
  const unavailable = /no negotiated protected egress authority/;
  observed.requiredCapabilities = old;
  await assert.rejects(assertAvailable, unavailable, "complete supported, incomplete required");
  delete observed.requiredCapabilities;
  observed.supportedCapabilities = [...current, current[0]];
  await assert.rejects(assertAvailable, unavailable, "complete required, duplicate in supported");
});
