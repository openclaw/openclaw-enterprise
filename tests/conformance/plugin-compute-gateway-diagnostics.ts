import assert from "node:assert/strict";
import test from "node:test";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeRequire, plain, required, runGeneratedProgram } from "./plugin-compute-fixtures.ts";
import {
  type StatusHandler,
  readReadyStatusFromHandler,
  readRuntimeChannelChecksFromHandler,
  readRuntimeStatusFromHandler,
} from "./plugin-compute-status.ts";

export function registerGatewayDiagnostics(): void {
  test("gateway runtime status maps native Slack channel status without provider data", async () => {
    const revisionId = "revision-plugin-compute-1";
    let statusHandler: StatusHandler | undefined;
    let channelStatus: unknown;
    let channelStatusCalls = 0;
    let channelError: Error | undefined;
    const transportError = new Error("connection refused");
    let holdChannelStatusResponse = false;
    let pendingChannelSignal: AbortSignal | undefined;
    let rpcTimeout: (() => void) | undefined;
    // Native /startupz and /readyz answers.
    const nativeProbeStatus = { "/startupz": 503, "/readyz": 503 };
    const sandbox = {
      AbortController,
      AbortSignal,
      Buffer,
      JSON,
      URL,
      console: { error() {} },
      process: {
        env: {
          OPENCLAW_AGENT_REVISION_ID: revisionId,
          OPENCLAW_GATEWAY_PORT: "8080",
          OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
          OPENCLAW_RUNTIME_STATUS_PORT: "18791",
          OPENCLAW_POD_UID: "pod-gateway-status-1",
        },
        on() {},
        exit(code: number) {
          throw new Error(`unexpected process exit ${code}`);
        },
      },
      setInterval() {
        return { unref() {} };
      },
      setTimeout(callback: () => void, timeoutMs: number) {
        if (timeoutMs === 6000) {
          rpcTimeout = callback;
        }
        return { unref() {} };
      },
      clearTimeout() {},
      require(specifier: string) {
        if (specifier === "node:http") {
          return {
            createServer(handler: StatusHandler) {
              statusHandler = handler;
              return { listen() {} };
            },
            get(
              options: { path: keyof typeof nativeProbeStatus },
              callback: (response: { statusCode: number; resume(): void }) => void,
            ) {
              callback({ statusCode: nativeProbeStatus[options.path], resume() {} });
              return { on() {}, destroy() {} };
            },
          };
        }
        if (specifier === "node:fs") {
          return {
            cpSync() {},
            existsSync() {
              return false;
            },
            lstatSync() {
              throw Object.assign(new Error("File not found"), { code: "ENOENT" });
            },
            mkdirSync() {},
            readFileSync() {
              throw new Error("unexpected file read");
            },
            readdirSync() {
              return [];
            },
            rmSync() {},
            writeFileSync() {},
          };
        }
        if (specifier === "openclaw/plugin-sdk/gateway-runtime") {
          return {
            isGatewayTransportError: (error: unknown) => error === transportError,
            // OpenClaw's predicate for a request refusal the Gateway answered (call.ts).
            isGatewayClientRequestError: (error: unknown) =>
              error instanceof Error &&
              error.name === "GatewayClientRequestError" &&
              "gatewayCode" in error &&
              typeof error.gatewayCode === "string" &&
              error.gatewayCode.length > 0 &&
              error.message.length > 0 &&
              "retryable" in error &&
              typeof error.retryable === "boolean" &&
              (!("retryAfterMs" in error) ||
                error.retryAfterMs === undefined ||
                (typeof error.retryAfterMs === "number" &&
                  Number.isInteger(error.retryAfterMs) &&
                  error.retryAfterMs >= 0)),
            async callGatewayFromCli(
              method: string,
              _options: unknown,
              params: unknown,
              { signal, sharedStateMode }: { signal: AbortSignal; sharedStateMode: string },
            ) {
              assert.equal(sharedStateMode, "read-only");
              assert.equal(method, "channels.status");
              assert.deepEqual(plain(params), { channel: "slack", probe: true, timeoutMs: 5000 });
              channelStatusCalls += 1;
              pendingChannelSignal = signal;
              if (channelError) {
                throw channelError;
              }
              // A stuck transport must not hold the HTTP response or the next probe.
              if (holdChannelStatusResponse) {
                return new Promise(() => {});
              }
              return channelStatus;
            },
          };
        }
        if (specifier === "node:child_process") {
          return { spawn: () => ({ on() {}, kill() {} }) };
        }
        return nodeRequire(specifier);
      },
    };

    runGeneratedProgram(GATEWAY_RUNTIME_ENTRYPOINT, sandbox);
    await Promise.resolve();

    assert.ok(statusHandler);
    const ready = await readRuntimeStatusFromHandler(statusHandler);
    assert.equal(ready.revisionId, revisionId);
    assert.equal(channelStatusCalls, 0);
    assert.deepEqual(await readReadyStatusFromHandler(statusHandler), { status: 503, body: "" });
    // Native /readyz admits a Gateway while its agent databases are still in
    // startup inspection, when turns fail (finding 2185): /startupz holds it.
    nativeProbeStatus["/readyz"] = 200;
    assert.deepEqual(await readReadyStatusFromHandler(statusHandler), { status: 503, body: "" });
    nativeProbeStatus["/startupz"] = 200;
    assert.deepEqual(await readReadyStatusFromHandler(statusHandler), { status: 200, body: "" });
    const assertSlackDiagnostics = async (
      status: unknown,
      expected: readonly { check: string; state: string; code: string | undefined }[],
      description: string,
    ) => {
      channelStatus = status;
      const diagnostics = await readRuntimeChannelChecksFromHandler(required(statusHandler));
      assert.deepEqual(
        diagnostics.checks.map(({ component }) => component),
        ["gateway", "gateway", "gateway"],
        `${description} components`,
      );
      assert.deepEqual(
        diagnostics.checks.map(({ check, state, code }) => ({ check, state, code })),
        expected,
        description,
      );
    };

    await assertSlackDiagnostics(
      {
        channels: { slack: { configured: true, connected: true } },
        channelAccounts: {
          slack: [{ accountId: "default", configured: true, connected: true, probe: { ok: true } }],
        },
        channelDefaultAccountId: { slack: "default" },
      },
      [
        { check: "configuration", state: "succeeded", code: undefined },
        { check: "authentication", state: "succeeded", code: undefined },
        { check: "connectivity", state: "succeeded", code: undefined },
      ],
      "connected",
    );

    await assertSlackDiagnostics(
      {
        channels: { slack: { configured: false } },
        channelAccounts: { slack: [{ accountId: "default", configured: false }] },
        channelDefaultAccountId: { slack: "default" },
      },
      [
        { check: "configuration", state: "failed", code: "NOT_CONFIGURED" },
        { check: "authentication", state: "unknown", code: undefined },
        { check: "connectivity", state: "unknown", code: undefined },
      ],
      "disabled",
    );

    for (const error of [
      "invalid_auth",
      "An API error occurred: invalid_auth; code: slack_webapi_platform_error; slack error: invalid_auth",
    ]) {
      await assertSlackDiagnostics(
        {
          channels: { slack: { configured: true } },
          channelAccounts: {
            slack: [{ accountId: "default", configured: true, probe: { ok: false, error } }],
          },
          channelDefaultAccountId: { slack: "default" },
        },
        [
          { check: "configuration", state: "succeeded", code: undefined },
          { check: "authentication", state: "failed", code: "AUTHENTICATION_FAILED" },
          { check: "connectivity", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
        ],
        `invalid auth ${error}`,
      );
    }

    await assertSlackDiagnostics(
      {
        channels: { slack: { configured: true, connected: true } },
        channelAccounts: {
          slack: [
            {
              accountId: "default",
              configured: true,
              connected: true,
              probe: { ok: false, error: "probe timed out after 5000ms" },
            },
          ],
        },
        channelDefaultAccountId: { slack: "default" },
      },
      [
        { check: "configuration", state: "succeeded", code: undefined },
        { check: "authentication", state: "unknown", code: "PROBE_FAILED" },
        { check: "connectivity", state: "succeeded", code: undefined },
      ],
      "probe timeout with connected transport",
    );

    await assertSlackDiagnostics(
      {
        channels: { slack: { configured: true, connected: true } },
        channelAccounts: {
          slack: [
            { accountId: "secondary", configured: true, connected: true, probe: { ok: true } },
          ],
        },
        channelDefaultAccountId: { slack: "missing-default" },
      },
      [
        { check: "configuration", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
        { check: "authentication", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
        { check: "connectivity", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
      ],
      "missing default account",
    );

    await assertSlackDiagnostics(
      { channels: [] },
      [
        { check: "configuration", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
        { check: "authentication", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
        { check: "connectivity", state: "unknown", code: "INCOMPATIBLE_RESPONSE" },
      ],
      "malformed live response",
    );

    // The shape of a refusal the Gateway answers (OpenClaw's GatewayClientRequestError).
    const gatewayRefusal = (gatewayCode: string, message: string) =>
      Object.assign(new Error(message), {
        name: "GatewayClientRequestError",
        gatewayCode,
        retryable: false,
      });
    for (const [error, code] of [
      [transportError, "UNAVAILABLE"],
      [new Error("RPC failed"), "PROBE_FAILED"],
      // Only the unknown-channel refusal for Slack itself means "no Slack channel".
      [gatewayRefusal("INVALID_REQUEST", "unknown channel: teams"), "PROBE_FAILED"],
      [gatewayRefusal("UNAVAILABLE", "unknown channel: slack"), "PROBE_FAILED"],
      [new Error("unknown channel: slack"), "PROBE_FAILED"],
    ] as const) {
      channelError = error;
      const diagnostics = await readRuntimeChannelChecksFromHandler(required(statusHandler));
      assert.deepEqual(
        diagnostics.checks.map(({ state, code }) => ({ state, code })),
        Array.from({ length: 3 }, () => ({ state: "unknown", code })),
      );
    }
    // The Gateway loads the Slack plugin only when the Configuration sets up a Slack channel,
    // so for an Agent without one it refuses channels.status as an unknown channel. That is
    // the documented NOT_CONFIGURED answer, not a failed probe.
    channelError = gatewayRefusal("INVALID_REQUEST", "unknown channel: slack");
    const withoutSlack = await readRuntimeChannelChecksFromHandler(required(statusHandler));
    assert.deepEqual(
      withoutSlack.checks.map(({ component, check, state, code }) => ({
        component,
        check,
        state,
        code,
      })),
      [
        { component: "gateway", check: "configuration", state: "failed", code: "NOT_CONFIGURED" },
        { component: "gateway", check: "authentication", state: "unknown", code: undefined },
        { component: "gateway", check: "connectivity", state: "unknown", code: undefined },
      ],
    );
    channelError = undefined;

    holdChannelStatusResponse = true;
    const timedOutRequest = readRuntimeChannelChecksFromHandler(required(statusHandler));
    await Promise.resolve();
    assert.equal(typeof rpcTimeout, "function");
    required(rpcTimeout)();
    assert.equal(required(pendingChannelSignal).aborted, true);
    const timedOutDiagnostics = await timedOutRequest;
    assert.deepEqual(
      timedOutDiagnostics.checks.map(({ state, code }) => ({ state, code })),
      Array.from({ length: 3 }, () => ({ state: "unknown", code: "UNAVAILABLE" })),
    );

    const requestListeners: Record<string, () => void> = {};
    const responseListeners: Record<string, () => void> = {};
    const abortedRequest = required(statusHandler)(
      {
        method: "GET",
        url: "/openclaw/runtime/diagnostics",
        on(event, listener) {
          requestListeners[event] = listener;
        },
        off() {},
      },
      {
        writeHead() {
          throw new Error("aborted response must not write headers");
        },
        end() {
          throw new Error("aborted response must not write a body");
        },
        on(event, listener) {
          responseListeners[event] = listener;
        },
        off() {},
      },
    );
    await Promise.resolve();
    assert.ok(pendingChannelSignal);
    required(requestListeners.aborted)();
    assert.equal(required(pendingChannelSignal).aborted, true);
    await abortedRequest;
    responseListeners.close?.();
    assert.equal(channelStatusCalls, 15);
  });
}
