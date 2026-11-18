import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/index.ts";
import test from "node:test";
import { createCustodyTransitions } from "../helpers/egress-supplier-custody-transitions.mjs";
import {
  addWireService,
  bindWireServer,
  grpc,
  shutdownWireServer,
  type WireRequest,
  type WireSandboxLogLine,
} from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

export function registerLogsCases(): void {
  test("OpenShell client reads v0.1.5 sandbox logs with nanosecond times", async () => {
    const requests: WireRequest<"GetSandboxLogs">[] = [];
    const metadata: (string | Buffer)[][] = [];
    const server = new grpc.Server();
    addWireService(server, {
      GetSandboxLogs(call, callback) {
        requests.push(call.request);
        metadata.push(call.metadata.get("authorization"));
        callback(null, {
          logs: [
            {
              sandbox_id: "sandbox-object-id",
              event_time: { seconds: "1790000000", nanos: 123_456_789 },
              level: "OCSF",
              target: "ocsf",
              message: "NET:OPEN [INFO] ALLOWED curl(7) -> api.example.com:443",
              source: "sandbox",
              fields: { dst_host: "api.example.com" },
            },
            { sandbox_id: "sandbox-object-id", level: "INFO", message: "no time" },
          ],
          buffer_total: 7,
        });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    try {
      const response = await client.getSandboxLogs(
        {
          workspace: "tenant-workspace",
          sandbox: "sb-0123",
          lines: 200,
          sinceTime: "2026-09-21T14:13:20.5Z",
        },
        AbortSignal.timeout(2_000),
      );
      assert.deepEqual(requests[0], {
        sandbox: "sb-0123",
        lines: 200,
        since_time: {
          seconds: String(Date.parse("2026-09-21T14:13:20Z") / 1000),
          nanos: 500_000_000,
        },
        workspace_scope: { workspace: "tenant-workspace", selection: "workspace" },
      });
      assert.deepEqual(metadata[0], []);
      assert.equal(response.bufferTotal, 7);
      assert.deepEqual(response.lines[0], {
        sandboxId: "sandbox-object-id",
        time: "2026-09-21T14:13:20.123456789Z",
        level: "OCSF",
        target: "ocsf",
        message: "NET:OPEN [INFO] ALLOWED curl(7) -> api.example.com:443",
        source: "sandbox",
        fields: { dst_host: "api.example.com" },
      });
      assert.equal(response.lines[1]?.time, null);
      assert.equal(response.lines[1]?.source, "");

      await assert.rejects(
        client.getSandboxLogs(
          { workspace: "tenant-workspace", sandbox: "sb-0123", lines: 0 },
          AbortSignal.timeout(2_000),
        ),
        /line count must be 1 to 2000/,
      );
      await assert.rejects(
        client.getSandboxLogs(
          { workspace: "tenant-workspace", sandbox: "sb-0123", lines: 5, sinceTime: "yesterday" },
          AbortSignal.timeout(2_000),
        ),
        /RFC 3339/,
      );
      await assert.rejects(
        client.getSandboxLogs(
          {
            workspace: "tenant-workspace",
            sandbox: "sb-0123",
            lines: 5,
            sinceTime: "2026-02-30T11:59:00Z",
          },
          AbortSignal.timeout(2_000),
        ),
        /RFC 3339/,
      );
      assert.equal(requests.length, 1);
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });

  test("installed custody observer follows the supplier's structured push shape through GetSandboxLogs", async (t) => {
    const workspace = "tenant-workspace";
    const sandbox = "selected-enrolled-sandbox";
    const sandboxId = "immutable-sandbox-id";
    const supervisor = {
      metadata: {
        uid: "supervisor-uid",
        namespace: workspace,
        labels: {
          "openshell.ai/sandbox-id": sandboxId,
          "openshell.ai/boundary-role": "supervisor",
        },
      },
      status: { containerStatuses: [{ containerID: "supervisor-container-id", restartCount: 0 }] },
    };
    // Shape produced by the Rust LogPushLayer, with source and sandbox ID set by
    // the gateway. Exercise real protobuf and the production client's mapped fields.
    const id = "0199f07b-a105-7001-8900-0123456789ab";
    const entry = (
      event: string | null,
      changes?: Partial<WireSandboxLogLine>,
      requestId = id,
    ): WireSandboxLogLine => ({
      sandbox_id: sandboxId,
      source: "sandbox",
      level: "INFO",
      target: "openshell_supervisor_network::l7::rest::credentials",
      message: "Protected response custody transition",
      event_time: { seconds: "1790000000", nanos: 123_000_000 },
      fields: event === null ? {} : { request_id: requestId, response_custody_event: event },
      ...changes,
    });
    const initial = entry(null, {
      source: "gateway",
      target: "ocsf",
      message: "startup",
      fields: {},
    });
    type LogBatch = [logs: WireSandboxLogLine[], bufferTotal?: number | undefined];
    let reply: () => LogBatch | undefined;
    const server = new grpc.Server();
    addWireService(server, {
      GetSandboxLogs(call, callback) {
        assert.deepEqual(call.request, {
          sandbox,
          workspace_scope: { workspace, selection: "workspace" },
          lines: 2000,
        });
        const response = reply();
        if (response === undefined) {
          return; // Deliberately leave this read pending until the observer cancels it.
        }
        const [logs, buffer_total = logs.length] = response;
        callback(null, { logs, buffer_total });
      },
    });
    const port = await bindWireServer(server);
    const gatewayClient = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    t.after(() => {
      gatewayClient.close();
      server.forceShutdown();
    });
    type CustodyOptions = {
      gatewayClient: GrpcOpenShellGatewayClient;
      workspace: string;
      sandbox: string;
      sandboxId: string;
      supervisor: typeof supervisor;
      readSupervisor: () => Promise<typeof supervisor>;
    };
    // The shared observer owns the snapshot and requires the same object on recheck.
    const custodyObserver: (
      input: CustodyOptions,
      options: { deliveryTimeoutMs: number; pollIntervalMs: number },
    ) => {
      snapshot(): Promise<unknown>;
      expectAfter(before: unknown, expected: readonly string[]): Promise<unknown>;
    } = createCustodyTransitions;
    const start = async (deliveryTimeoutMs = 3000) => {
      reply = () => [[initial]];
      const custody = custodyObserver(
        {
          gatewayClient,
          workspace,
          sandbox,
          sandboxId,
          supervisor,
          readSupervisor: async () => supervisor,
        },
        { deliveryTimeoutMs, pollIntervalMs: 5 },
      );
      return { custody, before: await custody.snapshot() };
    };
    await t.test(
      "partial batch at origin hold then terminal batch through FIN, same operation",
      async () => {
        const { custody, before } = await start();
        const events = ["resolve_accepted", "permit_accepted"];
        let n = 0;
        reply = () => [[initial, ...events.slice(0, n++).map((event) => entry(event))]];
        assert.equal(await custody.expectAfter(before, events), id);
        events.push("response_released");
        assert.equal(await custody.expectAfter(before, events), id);
      },
    );
    const denied = ["resolve_refused", "no_permit", "response_blocked"] as const;
    const lines = denied.map((event) => entry(event));
    await t.test(
      "negative requires affirmative no_permit, not silence or a missing prefix",
      async () => {
        const { custody, before } = await start(250);
        await assert.rejects(
          custody.expectAfter(before, denied),
          /unobservable before delivery deadline/,
        );
        reply = () => [[initial, ...lines.slice(1)]];
        await assert.rejects(custody.expectAfter(before, denied), /missing, or ambiguous/);
        // Use a fresh observer; the damaged sequence above cannot be repaired by polling.
        const fresh = await start();
        reply = () => [[initial, ...lines]];
        assert.equal(await fresh.custody.expectAfter(fresh.before, denied), id);
      },
    );
    await t.test(
      "delivery deadline during an in-flight log read is explicitly unobservable",
      async () => {
        const { custody, before } = await start(150);
        reply = () => undefined;
        await assert.rejects(custody.expectAfter(before, denied), (error) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /unobservable before delivery deadline.*GetSandboxLogs read timed out/,
          );
          assert.equal(asRecord(error.cause)?.name, "TimeoutError");
          return true;
        });
      },
    );
    const refusals: [string, WireSandboxLogLine[], RegExp, number?][] = [
      [
        "foreign source",
        [initial, entry(denied[0], { source: "gateway" })],
        /not the selected supervisor INFO/,
      ],
      [
        "foreign target",
        [initial, entry(denied[0], { target: "other" })],
        /not the selected supervisor INFO/,
      ],
      ["foreign sandbox", [initial, entry(denied[0], { sandbox_id: "other" })], /foreign Sandbox/],
      [
        "invalid request ID",
        [initial, entry(denied[0], {}, "malformed")],
        /malformed supplier custody/,
      ],
      ["unknown transition", [initial, entry("future_transition")], /malformed supplier custody/],
      [
        "mixed request IDs",
        [initial, entry(denied[0]), entry(denied[1], {}, id.replace(/ab$/, "cd"))],
        /missing, or ambiguous/,
      ],
      ["lost baseline", lines, /supplier log prefix changed/],
      [
        "full ring could conceal loss",
        Array.from({ length: 2000 }, () => initial),
        /incomplete supplier log ring/,
      ],
      ["ambiguous or truncated ring", [initial, ...lines], /incomplete supplier log ring/, 2000],
    ];
    for (const [name, logs, error, bufferTotal] of refusals) {
      await t.test("reject " + name, async () => {
        const { custody, before } = await start();
        reply = () => [logs, bufferTotal];
        await assert.rejects(custody.expectAfter(before, denied), error);
      });
    }
  });

  test("OpenShell client refuses a sandbox log response over its 4 MiB receive limit", async () => {
    // OpenShell does not bound a log line, and OCC buffers the whole read before it
    // withholds oversized lines. The receive limit is that read's memory bound.
    const server = new grpc.Server({ "grpc.max_send_message_length": 16 * 1024 * 1024 });
    addWireService(server, {
      GetSandboxLogs(call, callback) {
        const { lines } = call.request;
        assert.ok(lines !== undefined);
        // Each line carries a 1 MiB message: three fit in 4 MiB, four do not.
        callback(null, {
          logs: Array.from({ length: lines }, (_, index) => ({
            sandbox_id: "sandbox-object-id",
            level: "INFO",
            message: `${index}`.padEnd(1024 * 1024, "x"),
          })),
          buffer_total: lines,
        });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    const read = (lines: number) =>
      client.getSandboxLogs(
        { workspace: "tenant-workspace", sandbox: "sb-0123", lines },
        AbortSignal.timeout(10_000),
      );
    try {
      const fitting = await read(3);
      assert.equal(fitting.lines.length, 3);
      assert.equal(fitting.lines[2]?.message.length, 1024 * 1024);
      await assert.rejects(read(4), (error) => {
        assert.equal(asRecord(error)?.code, grpc.status.RESOURCE_EXHAUSTED);
        return true;
      });
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });
}
