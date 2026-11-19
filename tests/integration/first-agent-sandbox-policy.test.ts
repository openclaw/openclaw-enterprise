import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { verifyFirstAgentSandboxPolicy } from "../helpers/first-agent-sandbox-policy.ts";
import { within } from "../helpers/wait-for.ts";

const gatewayModule = new URL(
  "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts",
  import.meta.url,
);

const sandbox = { name: "sandbox", workspace: "workspace" };
const observed: OpenShellSandboxResponse = {
  ...sandbox,
  labels: {},
  annotations: {},
  serviceUrls: {},
};

function inertForward(fragmented = false) {
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { createServer } from "node:net";
        const server = createServer((socket) => socket.end("owned child"));
        server.listen(0, "127.0.0.1", () => {
          const line = "Forwarding from 127.0.0.1:" + server.address().port + " -> 8443";
          if (process.argv[1] === "fragmented") {
            process.stdout.write(line);
            process.stdin.once("data", () => process.stdout.write("\\n"));
          } else {
            console.log(line);
          }
        });
      `,
      fragmented ? "fragmented" : "complete",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
}

test("cancelled installer identity preparation cannot launch a port-forward", async () => {
  const parent = new AbortController();
  const prepared = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let spawns = 0;
  const result = verifyFirstAgentSandboxPolicy({
    sandbox,
    parentSignal: parent.signal,
    readTlsIdentity: async (signal) => {
      assert.equal(signal, parent.signal);
      entered.resolve();
      await prepared.promise;
      return { auth: { mode: "mtls", certificatePath: "unused", privateKeyPath: "unused" } };
    },
    startForward() {
      spawns++;
      assert.fail("cancelled setup must not open a listener");
    },
    createClient() {
      assert.fail("cancelled setup must not open a client");
    },
    checkPolicy() {
      assert.fail("cancelled setup must not accept policy");
    },
  });
  await entered.promise;
  const reason = new Error("cancelled during identity preparation");
  parent.abort(reason);
  assert.equal(spawns, 0);
  prepared.resolve();
  await assert.rejects(result, (error) => error === reason);
  assert.equal(spawns, 0);
});

test(
  "the installer reads policy through the child port announced on a complete line",
  {
    timeout: 5_000,
  },
  async (context) => {
    const occupied = createServer((socket) => socket.end("independent listener"));
    context.after(() => occupied.close());
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const address = occupied.address();
    assert.ok(address && typeof address !== "string");

    const forward = inertForward(true);
    let closed = false;
    forward.once("close", () => {
      closed = true;
    });
    let opened = false;
    let clientClosed = false;
    let checked = false;
    const expectedSandbox = { name: "sandbox", workspace: "workspace" };
    const requests: (typeof expectedSandbox)[] = [];
    const readback = verifyFirstAgentSandboxPolicy({
      startForward: () => forward,
      parentSignal: context.signal,
      sandbox,
      createClient(options) {
        opened = true;
        const endpoint = new URL(options.endpoint);
        assert.equal(endpoint.protocol, "http:");
        assert.deepEqual(options.auth, { mode: "unauthenticated" });
        assert.notEqual(Number(endpoint.port), address.port);
        return {
          async getSandbox(request) {
            requests.push({ ...request });
            assert.deepEqual(request, expectedSandbox);
            if (requests.length === 1) {
              throw new Error("Gateway listener is still starting");
            }
            const socket = createConnection({
              host: endpoint.hostname,
              port: Number(endpoint.port),
            });
            try {
              const chunks: Buffer[] = [];
              for await (const chunk of socket) {
                chunks.push(chunk as Buffer);
              }
              assert.equal(Buffer.concat(chunks).toString(), "owned child");
            } finally {
              socket.destroy();
            }
            return observed;
          },
          close() {
            clientClosed = true;
          },
        };
      },
      checkPolicy(response) {
        assert.equal(response, observed);
        checked = true;
      },
    });
    // The child cannot write the newline until the test observes the prefix.
    const [partial] = await once(forward.stdout, "data", { signal: context.signal });
    assert.match(String(partial), /^Forwarding from 127\.0\.0\.1:\d+ -> 8443$/);
    await nextTurn();
    try {
      assert.equal(opened, false);
    } finally {
      forward.stdin.end("finish the frame");
      await readback;
    }
    assert.equal(checked, true);
    assert.deepEqual(requests, [expectedSandbox, expectedSandbox]);
    assert.equal(clientClosed, true);
    assert.equal(closed, true);
  },
);

test(
  "a Sandbox returned after the policy deadline cannot satisfy the assertion",
  {
    timeout: 5_000,
  },
  async (context) => {
    let now = 0;
    context.mock.method(performance, "now", () => now);
    const forward = inertForward();
    let callSignal: AbortSignal | undefined;
    let checked = false;
    let clientClosed = false;
    await assert.rejects(
      verifyFirstAgentSandboxPolicy({
        startForward: () => forward,
        parentSignal: context.signal,
        sandbox,
        createClient() {
          now = 29_999;
          return {
            async getSandbox(_request, signal) {
              callSignal = signal;
              now += 1_000;
              return observed;
            },
            close() {
              clientClosed = true;
            },
          };
        },
        checkPolicy() {
          checked = true;
        },
      }),
      /Timed out reading the deployed Agent's OpenShell Sandbox policy/,
    );
    assert.equal(callSignal?.aborted, true);
    assert.equal(checked, false);
    assert.equal(clientClosed, true);
    assert.equal(forward.signalCode, "SIGTERM");
  },
);

test(
  "parent abort reaches an in-flight Sandbox read and rejects its late result",
  {
    timeout: 5_000,
  },
  async (context) => {
    const parent = new AbortController();
    const cancelled = new Error("parent cancelled the installer");
    const started = Promise.withResolvers<AbortSignal>();
    const reply = Promise.withResolvers<OpenShellSandboxResponse>();
    const forward = inertForward();
    let checked = false;
    const readback = verifyFirstAgentSandboxPolicy({
      startForward: () => forward,
      parentSignal: AbortSignal.any([parent.signal, context.signal]),
      sandbox,
      createClient: () => ({
        getSandbox(_request, signal) {
          started.resolve(signal);
          return reply.promise;
        },
        close() {},
      }),
      checkPolicy() {
        checked = true;
      },
    });
    const checkedFailure = assert.rejects(readback, (error: unknown) => error === cancelled);
    const callSignal = await started.promise;
    parent.abort(cancelled);
    reply.resolve(observed);
    await checkedFailure;
    assert.equal(callSignal.reason, cancelled);
    assert.equal(checked, false);
    assert.equal(forward.signalCode, "SIGTERM");
  },
);

test(
  "parent cancellation closes the forward before lazy gRPC setup settles and closes its late transport",
  { timeout: 8_000 },
  async (context) => {
    const require = createRequire(gatewayModule);
    const protoLoader =
      require("@grpc/proto-loader") as typeof import("../../apps/controller/node_modules/@grpc/proto-loader/build/src/index.js");
    const grpc =
      require("@grpc/grpc-js") as typeof import("../../apps/controller/node_modules/@grpc/grpc-js/build/src/index.js");
    type GrpcClient = InstanceType<typeof grpc.Client>;
    const releaseLoad = Promise.withResolvers<void>();
    const releaseClassificationLoad = Promise.withResolvers<void>();
    const loading = Promise.withResolvers<void>();
    const classifying = Promise.withResolvers<void>();
    const transportClosed = Promise.withResolvers<GrpcClient>();
    const load = protoLoader.load;
    const close = grpc.Client.prototype.close;
    let loads = 0;
    context.mock.method(protoLoader, "load", async (...args: Parameters<typeof load>) => {
      if (++loads === 1) {
        loading.resolve();
        await releaseLoad.promise;
        throw new Error("delayed proto load failed");
      }
      classifying.resolve();
      await releaseClassificationLoad.promise;
      return load(...args);
    });
    context.mock.method(grpc.Client.prototype, "close", function (this: GrpcClient) {
      close.call(this);
      transportClosed.resolve(this);
    });
    const wire = context.mock.method(grpc.Client.prototype, "makeUnaryRequest", () =>
      assert.fail("a retired attempt reached the gRPC wire"),
    );
    const parent = new AbortController();
    const cancelled = new Error("parent cancelled while the proto was loading");
    const started = Promise.withResolvers<AbortSignal>();
    const forward = inertForward();
    const forwardClosed = once(forward, "close");
    let calls = 0;
    const result = verifyFirstAgentSandboxPolicy({
      startForward: () => forward,
      parentSignal: AbortSignal.any([parent.signal, context.signal]),
      sandbox,
      createClient(options) {
        const gateway = new GrpcOpenShellGatewayClient(options);
        return {
          getSandbox(request, signal) {
            calls++;
            started.resolve(signal);
            return gateway.getSandbox(request, signal);
          },
          close: () => gateway.close(),
        };
      },
      checkPolicy: () => assert.fail("an expired read reached the policy assertion"),
    }).catch((error: unknown) => error);

    try {
      const rpcSignal = await within(started.promise, "start the Sandbox read", 1_000);
      await within(loading.promise, "enter lazy proto setup", 1_000);
      if (!rpcSignal.aborted) {
        await once(rpcSignal, "abort", { signal: context.signal });
      }
      assert.equal(rpcSignal.reason.name, "TimeoutError");
      // Leave the gate shut past the retry interval to detect overlapping attempts.
      await sleep(150, undefined, { signal: context.signal });
      assert.equal(calls, 1);
      parent.abort(cancelled);
      assert.equal(
        await within(result, "cancel the readback before proto load finishes", 1_000),
        cancelled,
      );
      assert.deepEqual(await forwardClosed, [null, "SIGTERM"]);

      // A late setup error takes getSandbox through isStatus and a second lazy load.
      releaseLoad.resolve();
      await within(classifying.promise, "classify the late setup error", 1_000);
      releaseClassificationLoad.resolve();
      const transport = await within(transportClosed.promise, "close the late transport", 1_000);
      assert.equal(
        transport.getChannel().getConnectivityState(false),
        grpc.connectivityState.SHUTDOWN,
      );
      assert.equal(loads, 2);
      assert.equal(wire.mock.callCount(), 0);
    } finally {
      parent.abort(cancelled);
      releaseLoad.resolve();
      releaseClassificationLoad.resolve();
      await result;
    }
  },
);

test(
  "the shared policy timer closes the forward while a read stays pending",
  { timeout: 5_000 },
  async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<OpenShellSandboxResponse>();
    const clientClosed = Promise.withResolvers<void>();
    const forward = inertForward();
    const result = verifyFirstAgentSandboxPolicy({
      startForward: () => forward,
      parentSignal: context.signal,
      sandbox,
      createClient: () => ({
        getSandbox() {
          started.resolve();
          return reply.promise;
        },
        close: () => clientClosed.resolve(),
      }),
      checkPolicy: () => assert.fail("the policy result must arrive within the shared deadline"),
    }).catch((error: unknown) => error);

    try {
      await started.promise;
      context.mock.timers.tick(30_000);
      context.mock.timers.reset();
      const error = await within(result, "close the forward at the shared deadline", 1_000);
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Timed out reading the deployed Agent's OpenShell Sandbox policy/,
      );
      assert.equal(forward.signalCode, "SIGTERM");
      reply.resolve(observed);
      await clientClosed.promise;
    } finally {
      reply.resolve(observed);
      await result;
    }
  },
);

test(
  "parent abort during Sandbox retry sleep preserves the abort reason",
  {
    timeout: 5_000,
  },
  async (context) => {
    const parent = new AbortController();
    const cancelled = new Error("parent cancelled the retry");
    const forward = inertForward();
    let calls = 0;
    await assert.rejects(
      verifyFirstAgentSandboxPolicy({
        startForward: () => forward,
        parentSignal: AbortSignal.any([parent.signal, context.signal]),
        sandbox,
        createClient: () => ({
          async getSandbox() {
            calls++;
            setImmediate(() => parent.abort(cancelled));
            return undefined;
          },
          close() {},
        }),
        checkPolicy() {
          assert.fail("no response was returned");
        },
      }),
      (error: unknown) => error === cancelled,
    );
    assert.equal(calls, 1);
    assert.equal(forward.signalCode, "SIGTERM");
  },
);

test(
  "the installer reports fixed forward startup errors and closes each child",
  {
    timeout: 5_000,
  },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-policy-forward-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    const cases = [
      {
        executable: join(directory, "missing"),
        args: [],
        message: "Cannot launch the owned OpenShell policy port-forward (ENOENT)",
      },
      {
        executable: process.execPath,
        args: ["-e", "console.log('untrusted output');process.exitCode=17"],
        message: "The owned OpenShell policy port-forward exited (17)",
      },
    ];
    for (const { executable, args, message } of cases) {
      const forward = spawn(executable, args, { stdio: ["ignore", "pipe", "ignore"] });
      let closed = false;
      forward.once("close", () => {
        closed = true;
      });
      await assert.rejects(
        verifyFirstAgentSandboxPolicy({
          startForward: () => forward,
          parentSignal: context.signal,
          sandbox,
          createClient() {
            assert.fail("child did not become ready");
          },
          checkPolicy() {
            assert.fail("child did not become ready");
          },
        }),
        { message },
      );
      assert.equal(closed, true);
    }
  },
);

test(
  "policy failure remains the cause when Gateway client cleanup fails",
  {
    timeout: 5_000,
  },
  async (context) => {
    const forward = inertForward();
    const policyFailure = new Error("policy assertion failed");
    const cleanupFailure = new Error("client close failed");
    await assert.rejects(
      verifyFirstAgentSandboxPolicy({
        startForward: () => forward,
        parentSignal: context.signal,
        sandbox,
        createClient: () => ({
          async getSandbox() {
            return observed;
          },
          close() {
            throw cleanupFailure;
          },
        }),
        checkPolicy() {
          throw policyFailure;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, policyFailure);
        assert.deepEqual(error.errors, [policyFailure, cleanupFailure]);
        return true;
      },
    );
    assert.equal(forward.signalCode, "SIGTERM");
  },
);
