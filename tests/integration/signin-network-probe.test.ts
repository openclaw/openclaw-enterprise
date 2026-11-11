import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { createInterface } from "node:readline";
import { tcpControlCommand, tcpProbeCommand } from "../helpers/signin/network-probe.mjs";

type ProbeTarget = { label: string; host: string; port: number; expect: string };
type ProbeReport = {
  label: string;
  host: string;
  port: number;
  outcome: string;
  attempt: number;
  code?: string;
  message?: string;
  syscall?: string;
};

function start(command: string[]) {
  const child = spawn(process.execPath, command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = once(child, "close").then(([code, signal]) => ({
    code,
    signal,
    stdout,
    stderr,
  }));
  return { child, completion };
}

async function run(targets: ProbeTarget[], options?: { waitForInitialEgress: boolean }) {
  const result = await start(tcpProbeCommand(targets, options)).completion;
  return {
    ...result,
    reports: result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line): ProbeReport => JSON.parse(line)),
  };
}

test(
  "sign-in TCP commands preserve outcomes and fail missing positive controls",
  { timeout: 15000 },
  async (t) => {
    const listener = start(tcpControlCommand(0));
    t.after(async () => {
      listener.child.kill("SIGTERM");
      await listener.completion;
    });
    const [ready] = await once(listener.child.stdout, "data");
    const port = JSON.parse(String(ready)).port;
    const reachable = { label: "control", host: "127.0.0.1", port, expect: "connected" };
    // A real closed loopback port reproduces ECONNREFUSED, not policy enforcement.
    const closed = createServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const closedAddress = closed.address();
    assert(closedAddress && typeof closedAddress !== "string");
    const closedPort = closedAddress.port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const blocked = { label: "target", host: "127.0.0.1", port: closedPort, expect: "denied" };
    const result = await run([reachable, blocked, { ...reachable, label: "control-after" }]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.reports.map((report) => report.outcome),
      ["connected", "denied", "connected"],
    );
    assert.equal(result.reports[1]!.code, "ECONNREFUSED");
    assert.equal(result.reports[1]!.host, blocked.host);
    assert.equal(result.reports[1]!.port, closedPort);
    assert.equal(result.reports[1]!.syscall, "connect");
    assert.match(result.reports[1]!.message!, /ECONNREFUSED/);

    // The same refusal must fail when checking a target listener or egress control.
    const missing = await run([{ ...blocked, expect: "connected" }, reachable]);
    assert.equal(missing.code, 1);
    assert.equal(missing.reports.length, 1);
    assert.equal(missing.reports[0]!.code, "ECONNREFUSED");
    const unauthorized = await run([{ ...reachable, expect: "denied" }]);
    assert.equal(unauthorized.code, 1);
    assert.equal(unauthorized.reports[0]!.outcome, "connected");

    // No DNS lookup or unknown socket setup error may count as a denial.
    for (const target of [
      { ...blocked, host: "unresolvable.invalid" },
      { ...blocked, port: -1 },
    ]) {
      const invalid = await run([target]);
      assert.equal(invalid.code, 1);
      assert.equal(invalid.reports[0]!.outcome, "error");
      assert.equal(
        invalid.reports[0]!.code,
        target.port === -1 ? "ERR_SOCKET_BAD_PORT" : "INVALID_ADDRESS",
      );
    }
    listener.child.kill("SIGTERM");
    const stopped = await listener.completion;
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(stopped.signal, null);
  },
);

test(
  "only the initial egress control retries bounded transport rejections",
  { timeout: 20000 },
  async (t) => {
    const server = createServer((socket) => socket.end());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const initial = { label: "egress-before", host: "127.0.0.1", port, expect: "connected" };
    const options = { waitForInitialEgress: true };
    const delayed = start(tcpProbeCommand([initial], options));
    t.after(async () => {
      delayed.child.kill("SIGTERM");
      await delayed.completion;
    });
    const lines = createInterface({ input: delayed.child.stdout });
    const [firstLine] = await once(lines, "line");
    lines.close();
    assert.equal(JSON.parse(firstLine).code, "ECONNREFUSED");
    // Start a real listener only after the actual first refusal is observed.
    // This models readiness delay, not Kubernetes policy enforcement.
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const ready = await delayed.completion;
    assert.equal(ready.code, 0, ready.stderr);
    const attempts = ready.stdout
      .trim()
      .split("\n")
      .map((line): ProbeReport => JSON.parse(line));
    assert.equal(attempts[0]!.outcome, "denied");
    assert.equal(attempts.at(-1)!.outcome, "connected");
    assert(attempts.length > 1);
    assert.deepEqual(
      attempts.map((report) => report.attempt),
      attempts.map((_, i) => i + 1),
    );

    const unavailable = createServer();
    unavailable.listen(0, "127.0.0.1");
    await once(unavailable, "listening");
    const unavailableAddress = unavailable.address();
    assert(unavailableAddress && typeof unavailableAddress !== "string");
    const closedPort = unavailableAddress.port;
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    const closed = { ...initial, port: closedPort };
    const started = performance.now();
    const never = await run([closed], options);
    assert.equal(never.code, 1);
    assert(never.reports.length > 1 && never.reports.length <= 33);
    assert(never.reports.every((report) => report.code === "ECONNREFUSED"));
    assert(performance.now() - started < 12000, "initial control must exhaust its small deadline");

    const protectedTargets = await run(
      [
        initial,
        { ...closed, label: "api", expect: "denied" },
        { ...closed, label: "operator", expect: "denied" },
        { ...initial, label: "egress-after" },
      ],
      options,
    );
    assert.equal(protectedTargets.code, 0);
    assert.equal(protectedTargets.reports.length, 4);
    assert(protectedTargets.reports.every((report) => report.attempt === 1));

    // Once startup succeeds, loss of final egress or a reachable protected target
    // must fail on the first observation, rather than being retried into a pass.
    for (const target of [
      { ...closed, label: "egress-after" },
      { ...initial, label: "api", expect: "denied" },
    ]) {
      const result = await run([initial, target], options);
      assert.equal(result.code, 1);
      assert.equal(result.reports.length, 2);
      assert.equal(result.reports[1]!.attempt, 1);
      assert.equal(result.reports[1]!.label, target.label);
    }
    for (const target of [
      { ...initial, host: "unresolvable.invalid" },
      { ...initial, port: -1 },
    ]) {
      const result = await run([target], options);
      assert.equal(result.code, 1);
      assert.equal(result.reports.length, 1);
      assert.equal(result.reports[0]!.outcome, "error");
    }
  },
);
