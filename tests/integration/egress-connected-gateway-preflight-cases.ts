import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import {
  deploymentErrorForWork,
  deploymentProgressForWork,
  deploymentStatusForWork,
} from "../../packages/occ/src/state/controller-work.ts";
import {
  describeGatewayAppServerDeclaration,
  observeConnectedOperation,
  safeConnectedFailure,
} from "../helpers/egress-connected-failure.mjs";
import {
  requestInstalledGatewayTurn,
  waitForInstalledGateway,
  waitForProtectedAgentActivation,
} from "../helpers/egress-installed-agent.mjs";
import { createRunEvidence } from "../helpers/egress-installed-stack.mjs";
import { createCustodyTransitions } from "../helpers/egress-supplier-custody-transitions.mjs";
import { withEnvironment } from "../helpers/environment.ts";
import { writeCommand } from "../helpers/fake-commands.ts";
import { listen } from "../helpers/listen.mjs";
import { createOpenShellKubernetesFixture } from "../helpers/openshell-kubernetes-real.mjs";
import { waitFor } from "../helpers/qa-utils.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): JsonRecord {
  assert.ok(isRecord(value));
  return value;
}

function readObservations(raw: string): JsonRecord & { phases: JsonRecord[] } {
  const parsed: unknown = JSON.parse(raw);
  const ledger = record(parsed);
  assert.ok(Array.isArray(ledger.phases));
  assert.ok(ledger.phases.every(isRecord));
  return { ...ledger, phases: ledger.phases };
}

type GatewayPodChanges = {
  agent?: string;
  role?: string;
  revision?: string;
  deleting?: boolean;
  pending?: boolean;
  image?: string;
  podReady?: boolean;
  containerReady?: boolean;
};

export function registerConnectedEgressGatewayPreflightCases(): void {
  test("connected turn failure receipts distinguish custody reads from the local kubectl exec outcome", async (t) => {
    const marker = `private-diagnostic-${randomUUID()}`;
    const directory = await temporaryDirectory(t, "connected-kubectl-");
    const workspace = "fixture-workspace";
    const sandboxId = "fixture-sandbox";
    const supervisor = {
      metadata: {
        uid: "fixture-supervisor",
        namespace: workspace,
        labels: {
          "openshell.ai/sandbox-id": sandboxId,
          "openshell.ai/boundary-role": "supervisor",
        },
      },
      status: { containerStatuses: [{ restartCount: 0, containerID: "fixture-container" }] },
    };
    // Exercise the same real execFile boundary used by the harness. The local
    // executable never opens a socket or launches a remote command.
    await writeCommand(
      directory,
      "kubectl",
      `
      const [verb, first, second] = process.argv.slice(6);
      const pod = verb === "get" ? second : first;
      switch (pod) {
        case "supervisor":
          if (verb !== "get") process.exit(2);
          console.log(${JSON.stringify(JSON.stringify(supervisor))});
          break;
        case "ok":
          if (verb !== "exec") process.exit(2);
          console.log("{}");
          break;
        case "malformed":
          console.log(${JSON.stringify(marker)});
          break;
        case "signal":
          process.kill(process.pid, "SIGTERM");
          break;
        case "external-kill":
          process.kill(process.pid, "SIGKILL");
          break;
        case "external-kill-with-open-stdout":
          // Keep the execFile pipe open after the child exits so its timer still fires.
          // The descendant exits on its own even if the test fails.
          require("node:child_process").spawn(
            process.execPath,
            ["-e", "setTimeout(() => {}, 2000)"],
            { stdio: ["ignore", "inherit", "ignore"] },
          );
          process.kill(process.pid, "SIGKILL");
          break;
        case "overflow":
          process.stdout.write("x".repeat(5 * 1024 * 1024));
          // Keep the local child alive until execFile reacts to the overflow.
          setInterval(() => {}, 1000);
          break;
        case "deadline":
          setInterval(() => {}, 1000);
          break;
        default:
          console.log(${JSON.stringify(marker)});
          console.error(${JSON.stringify(marker)});
          process.exit(17);
      }
      `,
      { interpreter: process.execPath },
    );
    const cases = [
      { operation: "before-custody-supervisor-get", read: 1, outcome: "exit", exitCode: 17 },
      { operation: "before-custody-log-read", log: 1 },
      { operation: "before-custody-supervisor-recheck", read: 2, outcome: "exit", exitCode: 17 },
      { operation: "gateway-codex-exec", pod: marker, outcome: "exit", exitCode: 17 },
      { operation: "gateway-codex-exec", pod: "malformed", outcome: "exit", exitCode: 0 },
      { operation: "gateway-codex-exec", pod: "signal", outcome: "signal", signal: "SIGTERM" },
      {
        operation: "gateway-codex-exec",
        pod: "external-kill",
        outcome: "signal",
        signal: "SIGKILL",
      },
      {
        operation: "gateway-codex-exec",
        pod: "external-kill-with-open-stdout",
        outcome: "signal",
        signal: "SIGKILL",
        commandTimeoutMs: 1000,
      },
      {
        operation: "gateway-codex-exec",
        pod: "deadline",
        outcome: "deadline",
        signal: "SIGKILL",
        killed: true,
      },
      {
        operation: "gateway-codex-exec",
        pod: "deadline",
        outcome: "cancelled",
        killed: true,
        abort: true,
      },
      {
        operation: "gateway-codex-exec",
        pod: "overflow",
        outcome: "transport",
        signal: "SIGKILL",
        killed: true,
      },
      { operation: "after-custody-supervisor-get", read: 3, outcome: "exit", exitCode: 17 },
      { operation: "after-custody-log-read", log: 2 },
      {
        operation: "after-custody-supervisor-recheck",
        read: 4,
        outcome: "exit",
        exitCode: 17,
        writeFailure: true,
      },
    ];
    await withEnvironment({ PATH: directory }, async () => {
      for (const item of cases) {
        const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
        t.after(() => rm(evidence.directory, { recursive: true, force: true }));
        const abort = new AbortController();
        const f = createOpenShellKubernetesFixture({
          kubeconfigPath: marker,
          kubernetesContext: "fixture",
          commandTimeoutMs: item.commandTimeoutMs ?? (item.outcome === "deadline" ? 250 : 5000),
          signal: abort.signal,
        } as Parameters<typeof createOpenShellKubernetesFixture>[0]);
        let reads = 0;
        let logReads = 0;
        const custody = createCustodyTransitions({
          gatewayClient: {
            async getSandboxLogs() {
              if (++logReads === item.log) {
                return observeConnectedOperation(marker, () => {
                  throw Object.assign(new Error(`egress-${marker}.mjs:12:34`, { cause: marker }), {
                    code: marker,
                    signal: marker,
                    stdout: marker,
                    stderr: marker,
                  });
                });
              }
              const lines =
                logReads === 1
                  ? []
                  : [
                      {
                        sandboxId,
                        source: "sandbox",
                        level: "INFO",
                        target: "openshell_supervisor_network::l7::rest::credentials",
                        message: "Protected response custody transition",
                        fields: {
                          request_id: "aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
                          response_custody_event: "resolve_accepted",
                        },
                      },
                    ];
              return { lines, bufferTotal: lines.length };
            },
          },
          workspace,
          sandbox: sandboxId,
          sandboxId,
          supervisor,
          readSupervisor: () =>
            f.resource("pod", ++reads === item.read ? marker : "supervisor", workspace),
        });
        await evidence.checkpoint("turn-start");
        if (item.writeFailure) {
          await mkdir(evidence.directory + "/observations.pending.json");
        }
        const expected = {
          kind: "operation",
          operation: item.operation,
          kubectl: item.outcome
            ? {
                outcome: item.outcome,
                exitCode: item.exitCode ?? null,
                signal: item.signal ?? null,
                killed: item.exitCode === 0 ? null : (item.killed ?? false),
                signalAborted: item.abort ?? false,
              }
            : null,
          ...(item.pod && item.exitCode !== 0 && { nativeExec: { status: "absent" } }),
        };
        try {
          const before: unknown = await custody.snapshot();
          const turn = f.requestCodexTurnFromGatewayPod({
            namespace: workspace,
            gatewayPod: item.pod ?? "ok",
            providerModel: marker,
            prompt: marker,
          } as Parameters<typeof f.requestCodexTurnFromGatewayPod>[0]);
          if (item.abort) {
            abort.abort(new DOMException(marker, "TimeoutError"));
          }
          await turn;
          await custody.expectAfter(before, ["resolve_accepted"]);
          assert.fail("the selected operation should have failed");
        } catch (error) {
          const safe = await safeConnectedFailure(error, "turn-start", evidence.recordFailure);
          assert.ok(safe.message.includes(item.operation), safe.message);
          assert.ok(safe.stack);
          assert.equal(safe.stack.includes(marker), false);
          assert.equal(safe.cause, undefined);
          if (expected.kubectl !== null) {
            assert.ok(
              safe.message.includes(`kubectl=${JSON.stringify(expected.kubectl)}`),
              safe.message,
            );
          }
        }
        const observations = evidence.directory + "/observations.json";
        const beforeCleanup = readObservations(await readFile(observations, "utf8"));
        if (item.writeFailure) {
          assert.equal(beforeCleanup.failure, undefined);
          await rm(evidence.directory + "/observations.pending.json", { recursive: true });
        } else {
          const { custody: _custody, ...failure } = record(beforeCleanup.failure);
          assert.deepEqual(failure, expected, "failure is durable before cleanup");
        }
        await evidence.checkpoint("cleanup");
        const raw = await readFile(observations, "utf8");
        const afterCleanup = readObservations(raw);
        const { custody: observedCustody, ...failure } = record(afterCleanup.failure);
        assert.deepEqual(failure, expected, "cleanup preserves the original failure");
        assert.equal(observedCustody !== undefined, !item.pod);
        if (item.read === 1) {
          assert.equal(record(observedCustody).lastRead, "unobserved");
          assert.equal(record(observedCustody).readAttempts, 0);
        }
        if (!item.writeFailure) {
          assert.deepEqual(afterCleanup.failure, beforeCleanup.failure);
        }
        assert.equal(raw.includes(marker), false);
      }
    });
  });

  test("connected gateway exec persists only the generated client's correlated failure frame", async (t) => {
    const sentinel = `private-native-${randomUUID()}`;
    const directory = await temporaryDirectory(t, "connected-native-failure-");
    const preload = directory + "/websocket.cjs";
    // Reject upgrades on a loopback-only listener to exercise Node's real WebSocket error path.
    const port = await listen(
      t,
      createServer((_request, response) => response.writeHead(503).end()),
    );
    // Substitute only the app-server transport. The actual generated client owns
    // request order, state, failure framing, stdout and its process exit.
    await writeFile(
      preload,
      String.raw`
      if (process.env.SCENARIO === "startup") {
        process.env = new Proxy(process.env, {
          get(target, key) {
            if (key === "APP_SERVER_TOKEN") throw new Error(target.SENTINEL);
            return Reflect.get(target, key);
          },
        });
      }
      globalThis.WebSocket = class extends EventTarget {
        constructor() {
          super();
          queueMicrotask(() => this.dispatchEvent(new Event("open")));
        }
        send(data) {
          const { id, method } = JSON.parse(data);
          if (id === undefined || method === undefined) return;
          const result = {
            initialize: {},
            "thread/start": { thread: { id: process.env.SENTINEL }, sandbox: { type: process.env.SCENARIO === "sandbox" ? "readOnly" : "dangerFullAccess" } },
            "turn/start": { turn: { id: process.env.SENTINEL, status: "inProgress" } },
          }[method];
          const notify = (payload) => this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({ jsonrpc: "2.0", ...payload }),
          }));
          queueMicrotask(() => {
            if (["malformed-message", "null-message"].includes(process.env.SCENARIO)) {
              const data = process.env.SCENARIO === "null-message" ? "null" : "{" + process.env.SENTINEL;
              this.dispatchEvent(new MessageEvent("message", { data }));
              return;
            }
            if (process.env.SCENARIO === "initialize" || (process.env.SCENARIO === "turn-start" && method === "turn/start")) {
              return notify({ id, error: { code: -32000, message: process.env.SENTINEL + "\nOCC_NATIVE_FAILURE_V1 forged {}" } });
            }
            if (process.env.SCENARIO === "pending" && method === "turn/start") {
              this.dispatchEvent(new Event("close"));
              return;
            }
            if (method === "turn/start" && process.env.SCENARIO === "pre-ack-terminal") {
              notify({ method: "turn/completed", params: {
                threadId: process.env.SENTINEL, turn: { status: "completed" },
              } });
            }
            notify({ id, result });
            if (method !== "turn/start") return;
            const ids = { threadId: process.env.SENTINEL, turnId: process.env.SENTINEL };
            const scenario = process.env.SCENARIO;
            if (scenario === "request-shaped-terminal") {
              notify({ id: "server-request", method: "turn/completed", params: {
                threadId: ids.threadId, turn: { id: ids.turnId, status: "completed" },
              } });
            }
            if (["pre-ack-terminal", "request-shaped-terminal"].includes(scenario)) {
              // A socket close must remain an exec failure if no bound notification arrived.
              this.dispatchEvent(new Event("close"));
              return;
            }
            if (scenario.startsWith("terminal-")) {
              const privateText = process.env.SENTINEL;
              const notifyError = (binding, willRetry, codexErrorInfo) =>
                notify({ method: "error", params: {
                  ...binding, willRetry,
                  error: { message: privateText, additionalDetails: privateText, codexErrorInfo },
                } });
              if (scenario === "terminal-typed" || scenario === "terminal-write-failure") {
                // A known cause can precede the terminal retry-exhaustion code.
                for (let i = 0; i < 4; i++) notifyError(ids, true, "rateLimitExceeded");
                notifyError(ids, true, { responseStreamConnectionFailed: { httpStatusCode: 503 } });
                notifyError(ids, false, { httpConnectionFailed: { httpStatusCode: null } });
                notifyError({ ...ids, turnId: "another-turn" }, false, "unauthorized");
                notifyError({ ...ids, threadId: "another-thread" }, false, "sandboxError");
                notifyError(ids, "false", "internalServerError");
                notify({ method: "item/completed", params: {
                  ...ids, item: { type: "agentMessage", text: privateText, headers: { arbitrary: privateText } },
                } });
              }
              const terminalErrors = {
                "terminal-typed": {
                  responseTooManyFailedAttempts: { httpStatusCode: 502, headers: { arbitrary: privateText } },
                },
                "terminal-malformed": { httpConnectionFailed: { httpStatusCode: "403" } },
                "terminal-out-of-range": { httpConnectionFailed: { httpStatusCode: 65536 } },
                "terminal-uint16": { httpConnectionFailed: { httpStatusCode: 65535 } },
                "terminal-missing-http": { httpConnectionFailed: { headers: { httpStatusCode: 403 } } },
                "terminal-unknown": { [privateText]: { httpStatusCode: 401 } },
                "terminal-multiple": { httpConnectionFailed: { httpStatusCode: 502 }, [privateText]: {} },
                "terminal-null": null,
                "terminal-expected-failure": { httpConnectionFailed: { httpStatusCode: 502 } },
              };
              terminalErrors["terminal-write-failure"] = terminalErrors["terminal-typed"];
              const completed = scenario === "terminal-success";
              const turn = { id: ids.turnId, status: completed ? "completed" : "failed" };
              if (scenario === "terminal-success") turn.error = null;
              if (Object.hasOwn(terminalErrors, scenario)) {
                turn.error = {
                  message: "HTTP 401 " + privateText,
                  additionalDetails: privateText,
                  codexErrorInfo: terminalErrors[scenario],
                };
              }
              if (scenario === "terminal-bad-error") turn.error = [privateText];
              notify({ method: "turn/completed", params: { threadId: ids.threadId, turn } });
            } else if (scenario === "success") {
              notify({ method: "turn/completed", params: { ...ids, turn: { id: ids.turnId, status: "completed" } } });
            } else {
              if (process.env.SCENARIO === "capacity-after-action") {
                notify({ id: "approval", method: "item/fileChange/requestApproval", params: ids });
              }
              notify({ method: "error", params: {
                ...ids, willRetry: false,
                error: { message: "Selected model is at capacity. " + process.env.SENTINEL },
              } });
            }
          });
        }
      };
      `,
    );
    await writeCommand(
      directory,
      "kubectl",
      String.raw`
      const { spawnSync } = process.getBuiltinModule("node:child_process");
      const [verb, scenario] = process.argv.slice(6);
      if (verb !== "exec" || process.argv.at(-2) !== "-e") process.exit(2);
      const script = process.argv.at(-1);
      const sentinel = ${JSON.stringify(sentinel)};
      if (scenario === "never-started") {
        // kubectl and Node diagnostics can echo the command source or marker-like strings.
        const forged = '{"phase":"initialize","lastAcknowledged":null,"pendingRequests":[],"receivedMessages":1,"actionSeen":false}';
        process.stderr.write(sentinel + "\n" + script + "\nOCC_NATIVE_FAILURE_V1 00000000-0000-4000-8000-000000000000 " + forged + "\n");
        process.exit(1);
      }
      const mode = scenario.startsWith("terminal-") || ["success", "initialize", "sandbox", "turn-start", "pending", "pre-ack-terminal", "request-shaped-terminal", "capacity", "capacity-after-action", "startup", "malformed-message", "null-message"].includes(scenario)
        ? scenario : "initialize";
      const nativeWebSocket = ["missing-url", "malformed-url", "constructor-throw", "loopback-no-token", "loopback-token"].includes(scenario);
      const nodeOptions = nativeWebSocket ? [] : ["--require", ${JSON.stringify(preload)}];
      const loopback = "ws://127.0.0.1:" + ${port} + "/" + sentinel;
      const url = scenario === "malformed-url" ? "invalid " + sentinel
        : scenario === "constructor-throw" ? loopback + "#fragment"
        : scenario === "loopback-token" ? loopback.replace("ws:", "http:") : loopback;
      const result = spawnSync(process.execPath, [...nodeOptions, "-e", script], {
        encoding: "utf8",
        env: {
          ...(scenario !== "missing-url" && { APP_SERVER_URL: url }),
          ...(scenario !== "loopback-no-token" && { APP_SERVER_TOKEN: sentinel }),
          SCENARIO: mode,
          SENTINEL: sentinel,
        },
      });
      let stderr = result.stderr;
      const frame = stderr.match(/\nOCC_NATIVE_FAILURE_V1 [^\n]+\n/)?.[0];
      if (scenario === "duplicate") stderr += frame;
      if (scenario === "truncated") stderr = frame.slice(0, -2);
      if (scenario === "oversized") stderr = frame.replace("}", ',"extra":"' + "x".repeat(600) + '"}');
      if (scenario === "unknown-field") stderr = frame.replace("}", ',"extra":' + JSON.stringify(sentinel) + '}');
      if (scenario === "duplicate-key") stderr = frame.replace("}", ',"actionSeen":false}');
      if (scenario === "bad-counter") stderr = frame.replace('"receivedMessages":1', '"receivedMessages":1000001');
      if (scenario === "bad-phase") stderr = frame.replace('"phase":"initialize"', '"phase":' + JSON.stringify(sentinel));
      if (scenario === "bad-site") stderr = frame.replace('"failureSite":"client"', '"failureSite":' + JSON.stringify(sentinel));
      if (scenario === "bad-url-shape") stderr = frame.replace('"urlShape":"ws"', '"urlShape":' + JSON.stringify(sentinel));
      if (scenario === "bad-token-presence") stderr = frame.replace('"tokenPresent":true', '"tokenPresent":' + JSON.stringify(sentinel));
      if (["startup", "missing-url", "malformed-url", "constructor-throw", "malformed-message", "null-message"].includes(scenario) &&
          frame && (result.stderr !== frame || result.stdout !== "")) {
        process.exit(3);
      }
      if (scenario !== "truncated") stderr += "command terminated with exit code " + result.status + "\n" + sentinel;
      if (scenario === "success" && result.stderr !== "") process.exit(3);
      if (scenario === "initialize" && result.stderr.includes(sentinel)) process.exit(3);
      process.stderr.write(stderr);
      process.stdout.write(result.stdout, () => process.exit(scenario === "wrong-exit" ? 17 : result.status));
      `,
      { interpreter: process.execPath },
    );

    const recorded = (
      phase: string,
      lastAcknowledged: string | null,
      pendingRequests: string[],
      receivedMessages: number,
      failureSite = "client",
      urlShape = "ws",
      tokenPresent: boolean | null = true,
    ) => ({
      status: "recorded",
      phase,
      lastAcknowledged,
      pendingRequests,
      receivedMessages,
      actionSeen: false,
      failureSite,
      urlShape,
      tokenPresent,
    });
    const cases: [string, (ReturnType<typeof recorded> | { status: string })?, number?][] = [
      ["success"],
      ["missing-url", recorded("connect", null, [], 0, "configuration", "missing")],
      ["malformed-url", recorded("connect", null, [], 0, "configuration", "malformed")],
      ["constructor-throw", recorded("connect", null, [], 0, "websocket-constructor")],
      ["startup", recorded("connect", null, [], 0, "startup", "ws", null)],
      ["loopback-no-token", recorded("connect", null, [], 0, "websocket-error", "ws", false)],
      ["loopback-token", recorded("connect", null, [], 0, "websocket-error", "http")],
      ["malformed-message", recorded("initialize", null, ["initialize"], 1, "message-decode")],
      ["null-message", recorded("initialize", null, ["initialize"], 1, "message-decode")],
      ["initialize", recorded("initialize", null, [], 1)],
      ["sandbox", recorded("thread/start", "thread/start", [], 2)],
      ["pending", recorded("turn/start", "thread/start", ["turn/start"], 2, "websocket-close")],
      ["pre-ack-terminal", recorded("turn", "turn/start", [], 4, "websocket-close")],
      [
        "request-shaped-terminal",
        { ...recorded("turn", "turn/start", [], 4, "websocket-close"), actionSeen: true },
      ],
      ["turn-start", recorded("turn/start", "thread/start", [], 3)],
      ["capacity", recorded("turn", "turn/start", [], 4), 75],
      ["capacity-after-action", { ...recorded("turn", "turn/start", [], 5), actionSeen: true }],
      ["never-started", { status: "absent" }],
      ["wrong-exit", { status: "invalid" }, 17],
      ...[
        "duplicate",
        "truncated",
        "oversized",
        "unknown-field",
        "duplicate-key",
        "bad-counter",
        "bad-phase",
        "bad-site",
        "bad-url-shape",
        "bad-token-presence",
      ].map((scenario): [string, { status: string }] => [scenario, { status: "invalid" }]),
    ];
    const pod = {
      metadata: { annotations: { "kubectl.kubernetes.io/default-container": "gateway" } },
      spec: {
        containers: [
          { name: "sidecar", env: [{ name: "APP_SERVER_URL", value: sentinel }] },
          {
            name: "gateway",
            env: [
              { name: "APP_SERVER_URL", value: `wss://${sentinel}.invalid/${sentinel}` },
              {
                name: "APP_SERVER_TOKEN",
                valueFrom: { secretKeyRef: { name: sentinel, key: "token" } },
              },
            ],
          },
        ],
      },
    };
    await withEnvironment({ PATH: directory }, async () => {
      const f = createOpenShellKubernetesFixture({
        kubeconfigPath: sentinel,
        kubernetesContext: "fixture",
        commandTimeoutMs: 5000,
        modelAtCapacityRetry: {
          sleep: () => assert.fail("bounded command failure must not replay"),
        },
      } as Parameters<typeof createOpenShellKubernetesFixture>[0]);
      for (const [scenario, nativeExec, exitCode = 1] of cases) {
        const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
        t.after(() => rm(evidence.directory, { recursive: true, force: true }));
        const noFrame = scenario === "never-started";
        await evidence.checkpoint(
          "turn-start",
          noFrame ? { gatewayAppServerDeclaration: describeGatewayAppServerDeclaration(pod) } : {},
        );
        const turn = f.requestCodexTurnFromGatewayPod({
          namespace: "fixture",
          gatewayPod: scenario,
          providerModel: sentinel,
          prompt: sentinel,
          observeFailure: ["pre-ack-terminal", "request-shaped-terminal"].includes(scenario),
        } as Parameters<typeof f.requestCodexTurnFromGatewayPod>[0]);
        let expected:
          | {
              kind: string;
              operation: string;
              kubectl: {
                outcome: string;
                exitCode: number;
                signal: null;
                killed: boolean;
                signalAborted: boolean;
              };
              nativeExec: (typeof cases)[number][1];
            }
          | undefined;
        if (scenario === "success") {
          assert.deepEqual(Object.keys(await turn).sort(), ["assistant", "items"]);
        } else {
          const operation = "gateway-codex-exec";
          const kubectl = {
            outcome: "exit",
            exitCode,
            signal: null,
            killed: false,
            signalAborted: false,
          };
          expected = { kind: "operation", operation, kubectl, nativeExec };
          await assert.rejects(turn, (asyncError) => {
            assert.ok(asyncError instanceof Error);
            assert.equal(record(asyncError).stderr, undefined);
            assert.equal(record(asyncError).stdout, undefined);
            assert.equal(asyncError.cause, undefined);
            assert.ok(asyncError.stack);
            assert.equal(asyncError.stack.includes(sentinel), false);
            return true;
          });
          const safe: unknown = await turn.catch((error: unknown) =>
            safeConnectedFailure(error, "turn-start", evidence.recordFailure),
          );
          assert.ok(safe instanceof Error);
          assert.ok(
            safe.message.includes(
              `kubectl=${JSON.stringify(kubectl)} nativeExec=${JSON.stringify(nativeExec)};`,
            ),
            scenario + ": " + safe.message,
          );
          assert.ok(safe.stack);
          assert.equal(safe.stack.includes(sentinel), false, scenario);
        }
        const observations = evidence.directory + "/observations.json";
        const beforeCleanup = readObservations(await readFile(observations, "utf8"));
        assert.deepEqual(beforeCleanup.failure, expected, scenario);
        if (noFrame) {
          assert.deepEqual(beforeCleanup.phases.at(-1)?.gatewayAppServerDeclaration, {
            urlSource: "literal",
            urlShape: "wss",
            tokenSource: "reference",
            tokenNonEmpty: null,
          });
        }
        await evidence.checkpoint("cleanup");
        const raw = await readFile(observations, "utf8");
        assert.deepEqual(readObservations(raw).failure, expected, scenario);
        assert.equal(raw.includes(sentinel), false, scenario);
      }

      // Use one ledger for successive real client calls to catch stale evidence.
      const progress: { stage?: string } = {};
      const evidence = await createRunEvidence(
        t,
        { input: { images: {} }, controller: {} },
        progress,
      );
      t.after(() => rm(evidence.directory, { recursive: true, force: true }));
      const observations = evidence.directory + "/observations.json";
      const http = (variant: string, state: string, code?: number) => ({
        state: "known",
        variant,
        httpStatus: { state, ...(code !== undefined && { code }) },
      });
      const notices = [
        { willRetry: true, error: { state: "known", variant: "rateLimitExceeded" } },
        { willRetry: true, error: { state: "known", variant: "rateLimitExceeded" } },
        { willRetry: true, error: http("responseStreamConnectionFailed", "present", 503) },
        { willRetry: false, error: http("httpConnectionFailed", "null") },
      ];
      const typed = http("responseTooManyFailedAttempts", "present", 502);
      const terminalCases: [string, { state: string }, typeof notices?][] = [
        ["typed", typed, notices],
        ["success", { state: "null" }],
        ["expected-failure", http("httpConnectionFailed", "present", 502)],
        ["bad-error", { state: "invalid" }],
        ["malformed", http("httpConnectionFailed", "invalid")],
        ["out-of-range", http("httpConnectionFailed", "invalid")],
        ["uint16", http("httpConnectionFailed", "present", 65535)],
        ["missing-http", http("httpConnectionFailed", "absent")],
        ["unknown", { state: "unknown" }],
        ["multiple", { state: "invalid" }],
        ["absent", { state: "absent" }],
        ["null", { state: "null" }],
        ["write-failure", typed, notices],
      ];
      for (const [scenario, terminalError, errorNotifications = []] of terminalCases) {
        await t.test("terminal " + scenario, async () => {
          const gateway = gatewayPod("terminal-fixture");
          gateway.metadata.name = "terminal-" + scenario;
          const turnPhase = "fixture-" + scenario;
          const completed = scenario === "success";
          const writeFailure = scenario === "write-failure";
          const status = completed ? "completed" : "failed";
          const expectedStatus = scenario === "expected-failure" ? "failed" : "completed";
          const summary = {
            expectedStatus,
            actualStatus: status,
            lastAcknowledged: "turn/start",
            terminalEvent: "turn/completed",
            terminalError,
            errorNotifications,
          };
          const declaration = describeGatewayAppServerDeclaration(pod);
          await evidence.checkpoint("turn-start", {
            turnPhase,
            gatewayAppServerDeclaration: declaration,
          });
          if (writeFailure) {
            await mkdir(evidence.directory + "/observations.pending.json");
          }
          const installedTurn = await requestInstalledGatewayTurn(
            { ...f, maybeResource: async () => gateway },
            evidence,
            {
              placement: gatewayPlacement,
              agentId: gatewayAgent,
              revisionId: gatewayRevision,
              image: gatewayImage,
              gateway,
              phase: turnPhase,
              custodyTransitions: { snapshot: async () => {} },
              expected: expectedStatus,
            },
            { providerModel: sentinel, prompt: sentinel, observeFailure: true },
          );
          const result = record(installedTurn.result);
          const { nativeTurnResult } = installedTurn;
          const beforeVerification = readObservations(await readFile(observations, "utf8")).phases;
          const declarationPhase = beforeVerification.find(
            (entry) => entry.phase === "turn-start" && entry.turnPhase === turnPhase,
          );
          assert.deepEqual(declarationPhase?.gatewayAppServerDeclaration, declaration);
          const retained = (phases: JsonRecord[]) =>
            phases.find(
              (entry) => entry.phase === "gateway-turn-result" && entry.turnPhase === turnPhase,
            );
          assert.deepEqual(
            retained(beforeVerification)?.nativeTurnResult,
            writeFailure ? undefined : summary,
            "save the closed native result before verification",
          );
          const verify = observeConnectedOperation(
            "gateway-turn-verification",
            () => {
              assert.equal(
                result.status,
                expectedStatus,
                "fixture expected the declared terminal status",
              );
            },
            nativeTurnResult,
          );
          if (status === expectedStatus) {
            await verify;
          } else {
            await assert.rejects(verify, {
              code: "ERR_ASSERTION",
              actual: "failed",
              expected: "completed",
            });
            const safe: unknown = await verify.catch((error: unknown) =>
              safeConnectedFailure(error, progress.stage, evidence.recordFailure),
            );
            assert.ok(safe instanceof Error);
            assert.ok(safe.message.includes(`nativeTurnResult=${JSON.stringify(summary)};`));
            assert.ok(safe.stack);
            assert.equal(safe.stack.includes(sentinel), false);
            if (writeFailure) {
              await rm(evidence.directory + "/observations.pending.json", { recursive: true });
            }
          }
          await evidence.checkpoint("cleanup");
          const raw = await readFile(observations, "utf8");
          const ledger = readObservations(raw);
          assert.deepEqual(retained(ledger.phases)?.nativeTurnResult, summary);
          if (status !== expectedStatus) {
            assert.deepEqual(ledger.failure, {
              kind: "assertion",
              operation: "gateway-turn-verification",
              kubectl: null,
              nativeTurnResult: summary,
            });
          }
          assert.equal(raw.includes(sentinel), false);
        });
      }
    });
  });

  const gatewayPlacement = "fixture-workspace";
  const gatewayAgent = "agt_fixture";
  const gatewayRevision = "rev_fixture";
  const gatewayImage = `fixture/gateway@sha256:${"a".repeat(64)}`;

  function gatewayPod(uid: string, changes: GatewayPodChanges = {}) {
    const {
      agent = gatewayAgent,
      role = "gateway",
      revision = gatewayRevision,
      deleting,
      pending,
      image = gatewayImage,
      podReady = !pending,
      containerReady = !pending,
    } = changes;
    return {
      metadata: {
        name: "fixture-gateway",
        uid,
        labels: {
          "openclaw.dev/agent": agent,
          "openclaw.dev/workload-role": role,
          "openclaw.dev/revision": revision,
        },
        ...(deleting && { deletionTimestamp: "2026-01-01T00:00:00Z" }),
        annotations: { unretained: "private-pod-annotation" },
      },
      spec: {
        containers: [
          { name: "gateway", image },
          { name: "sidecar", image: gatewayImage },
        ],
      },
      status: {
        phase: pending ? "Pending" : "Running",
        conditions: [{ type: "Ready", status: podReady ? "True" : "False" }],
        containerStatuses: [
          {
            name: "gateway",
            ready: containerReady,
            state: pending ? { waiting: { reason: "PodInitializing" } } : { running: {} },
          },
        ],
      },
    };
  }

  test("protected Agent activation requires successful work and the exact published revision", async () => {
    const privateValue = "PRIVATE_ACTIVATION_" + randomUUID().replaceAll("-", "").toUpperCase();
    const revisionId = privateValue;
    const agentPath = "/agent";
    const deploymentPath = "/deployment";
    const selection = { agentPath, deploymentPath, revisionId };
    const date = new Date(0);
    const pending = { state: "queued", availableAt: date, attemptCount: 1 } as const;
    const attempt = { at: date, code: "REVISION_FINALIZATION_INCOMPLETE" };
    const succeeded = { ...pending, state: "succeeded", reasonCode: "REVISION_ACTIVATED" } as const;
    const terminal = {
      ...pending,
      state: "failed_permanent",
      reasonCode: "RUNTIME_LOGIN_FAILED",
    } as const;
    // Use the same status, error and progress projections the deployment endpoint uses.
    // Finalization incomplete is currently published as general reconciliation pending.
    const deployment = (
      work: Pick<
        Parameters<typeof deploymentStatusForWork>[0],
        "state" | "availableAt" | "attemptCount" | "reasonCode" | "resultData"
      >,
      lastAttempt?: Parameters<typeof deploymentStatusForWork>[1],
    ) => ({
      status: deploymentStatusForWork(
        work as Parameters<typeof deploymentStatusForWork>[0],
        lastAttempt,
        date,
      ),
      progress: deploymentProgressForWork(work, lastAttempt),
      error: deploymentErrorForWork(work),
      deploymentId: privateValue,
    });
    const pointer = { activeRevisionId: revisionId };
    const wrongPointer = { activeRevisionId: "previous" };
    const running = deployment(pending, attempt);
    assert.equal(running.status, "running");
    const ready = deployment(succeeded);
    assert.equal(ready.status, "succeeded");
    const checkpoints: JsonRecord[] = [];
    const checkpoint = async (phase: string, details: JsonRecord) =>
      checkpoints.push({ phase, ...details });
    const polls = [
      [running, pointer],
      [running, pointer],
      [ready, wrongPointer],
      [ready, pointer],
    ];
    let reads = 0;
    let continued = 0;
    let responses: (typeof polls)[number] | undefined;
    const active: unknown = await waitForProtectedAgentActivation(
      async (
        _description: string,
        observe: () => Promise<typeof pointer | undefined>,
        timeout: number,
      ) => {
        assert.equal(timeout, 12 * 60_000);
        for (const poll of polls) {
          responses = poll;
          const result = await observe();
          if (result) {
            return result;
          }
        }
        assert.fail("the successfully activated revision must release the wait");
      },
      {
        checkpoint,
        async api(_method: string, path: string) {
          reads += 1;
          assert.ok(responses);
          return responses[path === deploymentPath ? 0 : 1];
        },
      },
      selection,
    );
    continued += 1;
    assert.equal(active, pointer);
    assert.equal(reads, 8, "hold on running work and a mismatched pointer");
    assert.equal(continued, 1);
    assert.deepEqual(checkpoints.splice(0), [
      {
        phase: "activation-pending",
        last: {
          status: "running",
          progressCode: "RECONCILIATION_PENDING",
          activeRevisionMatches: true,
        },
      },
      {
        phase: "activation-pending",
        last: { status: "succeeded", progressCode: null, activeRevisionMatches: false },
      },
    ]);

    for (const [response, expected, failure, activeReads] of [
      [
        running,
        {
          outcome: "timeout",
          last: {
            status: "running",
            progressCode: "RECONCILIATION_PENDING",
            activeRevisionMatches: true,
          },
        },
        /Timed out: protected Agent activation/,
        1,
      ],
      [
        deployment(terminal),
        {
          outcome: "failed",
          last: {
            status: "failed",
            progressCode: null,
            activeRevisionMatches: null,
            errorCode: "RUNTIME_LOGIN_FAILED",
          },
        },
        /protected Agent deployment failed/,
        0,
      ],
      [
        { ...deployment(terminal), error: { code: privateValue, message: privateValue } },
        {
          outcome: "failed",
          last: {
            status: "failed",
            progressCode: null,
            activeRevisionMatches: null,
            errorCode: "UNKNOWN",
          },
        },
        /protected Agent deployment failed/,
        0,
      ],
      [
        ready,
        {
          outcome: "read-error",
          reading: "agent",
          last: { status: "succeeded", progressCode: null, activeRevisionMatches: null },
        },
        new Error(privateValue),
        1,
      ],
    ] as const) {
      let pointerReads = 0;
      let now = -1;
      await assert.rejects(
        waitForProtectedAgentActivation(
          (
            description: string,
            observe: () => Promise<typeof pointer | undefined>,
            timeout: number,
          ) =>
            waitFor(description, observe, timeout, {
              now: () => ++now * timeout,
            }),
          {
            checkpoint,
            async api(_method: string, path: string) {
              if (path === deploymentPath) {
                return response;
              }
              assert.equal(path, agentPath);
              pointerReads += 1;
              if (failure instanceof Error) {
                throw failure;
              }
              return pointer;
            },
          },
          selection,
        ).then(() => {
          continued += 1;
        }),
        (error: unknown) =>
          failure instanceof Error
            ? error === failure
            : error instanceof Error && failure.test(error.message),
      );
      assert.equal(pointerReads, activeReads);
      assert.deepEqual(checkpoints.pop(), { phase: "activation-failed", ...expected });
      assert.deepEqual(
        checkpoints.splice(0),
        expected.outcome === "timeout"
          ? [{ phase: "activation-pending", last: expected.last }]
          : [],
      );
    }
    assert.equal(continued, 1, "a failed or pending deployment must not continue to a turn");
  });

  test("installed Gateway selection waits for a unique current ready Pod and retains terminal counts", async (t) => {
    const ready = gatewayPod("ready");
    const pending = gatewayPod("pending", { pending: true });
    const stale = gatewayPod("old", { revision: "rev_old" });
    const deleting = gatewayPod("deleting", { deleting: true });
    const foreign = gatewayPod("foreign", { agent: "agt_other" });
    const wrongRole = gatewayPod("wrong-role", { role: "agent" });
    const wrongImage = gatewayPod("wrong-image", { image: "fixture/other" });
    const podNotReady = gatewayPod("not-ready", { podReady: false });
    const containerNotReady = gatewayPod("container-not-ready", { containerReady: false });
    const readError = new Error("private Kubernetes transport error");
    const scenarios = [
      {
        name: "converges after creation and rollout",
        reads: [
          [],
          [stale, deleting],
          [pending],
          [wrongImage],
          [podNotReady],
          [containerNotReady],
          [ready, pending],
          [ready, stale, deleting, foreign, wrongRole],
        ],
        uid: "ready",
        last: { owned: 3, deleting: 1, stale: 1, current: 1, wrongImage: 0, pending: 0, ready: 1 },
      },
      {
        name: "times out with zero Pods",
        reads: [[]],
        last: { owned: 0, deleting: 0, stale: 0, current: 0, wrongImage: 0, pending: 0, ready: 0 },
      },
      {
        name: "times out rather than choosing one ready Pod in an overlap",
        reads: [[ready, pending, wrongImage]],
        last: { owned: 3, deleting: 0, stale: 0, current: 3, wrongImage: 1, pending: 1, ready: 1 },
      },
      {
        name: "propagates the list error after an observed Pending Pod",
        reads: [[pending], readError],
        last: { owned: 1, deleting: 0, stale: 0, current: 1, wrongImage: 0, pending: 1, ready: 0 },
      },
    ];
    for (const { name, reads, uid, last } of scenarios) {
      await t.test(name, async (t) => {
        const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
        t.after(() => rm(evidence.directory, { recursive: true, force: true }));
        let lists = 0;
        const deadline = new Error("controlled poll deadline");
        const f = {
          async waitFor(
            _description: string,
            read: () => Promise<ReturnType<typeof gatewayPod> | undefined>,
            timeoutMs: number,
          ) {
            assert.equal(timeoutMs, 120_000);
            for (const _ of reads) {
              const selected = await read();
              if (selected !== undefined) {
                return selected;
              }
            }
            throw deadline;
          },
          async resources(kind: string, placement: string, flag: string, selector: string) {
            assert.deepEqual(
              [kind, placement, flag, selector],
              [
                "pods",
                gatewayPlacement,
                "--selector",
                "openclaw.dev/agent=agt_fixture,openclaw.dev/workload-role=gateway",
              ],
            );
            const entry = reads[lists++];
            if (entry instanceof Error) {
              throw entry;
            }
            return entry;
          },
        };
        const select = waitForInstalledGateway(
          f,
          evidence,
          gatewayPlacement,
          gatewayAgent,
          gatewayRevision,
          gatewayImage,
        );
        if (uid) {
          assert.equal((await select).metadata.uid, uid);
        } else {
          const failedRead = reads.at(-1) instanceof Error;
          await assert.rejects(select, failedRead ? readError : deadline);
          if (failedRead) {
            const safe = await safeConnectedFailure(
              readError,
              "gateway-selection-failed",
              evidence.recordFailure,
            );
            assert.match(safe.message, /gateway-selection-list/);
          }
        }
        assert.equal(lists, reads.length);
        await evidence.checkpoint("cleanup");
        const raw = await readFile(evidence.directory + "/observations.json", "utf8");
        const retained = readObservations(raw).phases.at(-2);
        assert.ok(retained);
        assert.equal(retained.phase, uid ? "gateway-selected" : "gateway-selection-failed");
        assert.deepEqual(retained.last, last);
        if (!uid) {
          assert.equal(retained.outcome, reads.at(-1) instanceof Error ? "read-error" : "timeout");
        }
        assert.equal(raw.includes("private-pod-annotation"), false);
        assert.equal(raw.includes("private Kubernetes transport error"), false);
      });
    }
  });

  test("installed Gateway turn rechecks the pinned UID after custody and sends at most one named exec", async (t) => {
    const selected = gatewayPod("selected");
    const readError = new Error("private read error");
    const dispatchError = new Error("uncertain exec outcome");
    const scenarios = [
      { outcome: "absent", current: undefined },
      { outcome: "replaced", current: gatewayPod("replacement") },
      { outcome: "ineligible", current: gatewayPod("selected", { deleting: true }) },
      { outcome: "ineligible", current: gatewayPod("selected", { containerReady: false }) },
      { outcome: "read-error", current: readError, error: readError },
      { outcome: "eligible", current: selected, error: dispatchError },
    ];
    for (const { outcome, current, error } of scenarios) {
      await t.test(outcome, async (t) => {
        const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
        t.after(() => rm(evidence.directory, { recursive: true, force: true }));
        const actions: string[] = [];
        let serving: ReturnType<typeof gatewayPod> | Error | undefined = selected;
        const f = {
          async maybeResource(kind: string, name: string, placement: string) {
            assert.deepEqual(
              [kind, name, placement],
              ["pod", selected.metadata.name, gatewayPlacement],
            );
            actions.push("read");
            if (serving instanceof Error) {
              throw serving;
            }
            return serving;
          },
          async requestCodexTurnFromGatewayPod(turn: {
            observeFailure: boolean;
            namespace: string;
            gatewayPod: string;
            container: string;
          }) {
            actions.push("exec");
            assert.deepEqual(turn, {
              observeFailure: true,
              namespace: gatewayPlacement,
              gatewayPod: selected.metadata.name,
              container: "gateway",
            });
            throw dispatchError;
          },
        };
        const custodyTransitions = {
          async snapshot() {
            actions.push("snapshot");
            serving = current;
          },
        };
        await assert.rejects(
          requestInstalledGatewayTurn(
            f,
            evidence,
            {
              placement: gatewayPlacement,
              agentId: gatewayAgent,
              revisionId: gatewayRevision,
              image: gatewayImage,
              gateway: selected,
              phase: "fixture-turn",
              custodyTransitions,
            } as Parameters<typeof requestInstalledGatewayTurn>[2],
            { observeFailure: true },
          ),
          error ?? { code: "ERR_ASSERTION" },
        );
        assert.deepEqual(
          actions,
          outcome === "eligible" ? ["snapshot", "read", "exec"] : ["snapshot", "read"],
        );
        await evidence.checkpoint("cleanup");
        const retained = readObservations(
          await readFile(evidence.directory + "/observations.json", "utf8"),
        );
        assert.deepEqual(retained.gatewayExecTarget, { phase: "fixture-turn", outcome });
      });
    }
  });
}
