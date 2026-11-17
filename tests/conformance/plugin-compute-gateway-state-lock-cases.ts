import assert from "node:assert/strict";
import test from "node:test";
import { invalidGatewayConfiguration } from "../helpers/openclaw-config-validation.ts";
import { property, record, required, text } from "./plugin-compute-fixtures.ts";
import { readReadyStatusFromHandler } from "./plugin-compute-status.ts";
import {
  assertDeliberateRestart,
  DELIBERATE_RESTART,
  startCodexGatewaySupervisor,
} from "./plugin-compute-supervisor.ts";

type GatewaySupervisor = Awaited<ReturnType<typeof startCodexGatewaySupervisor>>;

// What the pinned OpenClaw's `gateway recover-lock --json` prints without --confirm, as a
// production-shaped test install printed it inside a Gateway Pod after the Gateway Pod before
// it was force-deleted (finding 3288): the successor's own start refused that owner lease
// after `config validate` passed.
const recovery =
  "Stop the holder before retrying; if it has already stopped, run `openclaw gateway" +
  " recover-lock` to inspect and explicitly recover the unchanged owner.";
const leaseHolder =
  "SQLite Gateway owner lease: holder 44 at gateway-804a2e28f577-6d77574958-v8sp7/pid-ns" +
  ` 4026536354, last renewed 452 s ago. ${recovery}`;
// OpenClaw lists each lock file it finds before the lease, in the same shape.
function lockFileHolder(path: string, pid = 44) {
  return (
    `${path}: holder ${pid} at gateway-804a2e28f577-6d77574958-v8sp7/pid-ns 4026536354,` +
    ` last heartbeat 452 s ago. ${recovery}`
  );
}
const confirmation = "10e3e307222372d1013b3d238518fc59804660f0bd41e674ba543c63f9a903c0";
function inspection(holders: readonly string[], present = holders.length > 0) {
  return {
    status: 0,
    stdout: JSON.stringify({
      present,
      holders,
      confirmation,
      command: `openclaw gateway recover-lock --confirm ${confirmation}`,
    }),
  };
}
const heldLock = inspection([leaseHolder]);
const freeLock = inspection([]);
// What the exited-state release prints when it recovered the records of this container's own
// child, which it proved dead in this live PID namespace.
const released = { status: 0, stdout: JSON.stringify({ recovered: true, removed: 1 }) };
// What it does when one record is not attributable to this namespace: it recovers nothing.
const keptLocks = { status: 1, stdout: "" };
// A record the wrapper's own native Gateway wrote in this namespace before it exited.
const ownHolder = lockFileHolder("/home/node/.openclaw/state/gateway.lock", 7);
// The inspection the wrapper may run: never --confirm, which would recover the lock.
const expectedInspection = {
  command: "node",
  args: ["/app/openclaw.mjs", "gateway", "recover-lock", "--json"],
  readOnly: "1",
};
// The same line the tool policy step logs when `config validate` meets the lock first.
// An embedded Gateway reaches the same hold, so the line names no Gateway kind.
function lockHoldLine(reported = leaseHolder) {
  return (
    "The Gateway cannot start: an earlier Gateway process did not stop cleanly and still holds" +
    " the Gateway state lock, and this container cannot verify that it stopped. It remains" +
    " unready; stop the Agent and recover the lock as the Agent troubleshooting guide describes" +
    ` for an unverifiable state owner. OpenClaw reported: ${reported}`
  );
}
const RECHECK_MS = 300_000;

// The configuration directory is writable here, so only the wrapper's own setting can make the
// inspection read-only.
function writableConfiguration(gateway: GatewaySupervisor) {
  gateway.writableDirectories.add("/etc/openclaw");
}

// The files the exited-state release's namespace probe reads. Without them the probe fails and
// no release runs.
function liveNamespace(gateway: GatewaySupervisor) {
  const statFields = ["S", ...Array.from({ length: 18 }, () => "0"), "4242", "0"];
  gateway.files.set("/proc/1/stat", `1 (tini) ${statFields.join(" ")}`);
  gateway.files.set("/proc/sys/kernel/random/boot_id", "boot-1\n");
  gateway.files.set("/proc/self/ns/pid", "pid:[4026536354]");
}

async function startRefusedGateway(t: test.TestContext, lockInspection = heldLock) {
  const gateway: GatewaySupervisor = await startCodexGatewaySupervisor(t, {
    runtimeStatus: true,
  });
  writableConfiguration(gateway);
  gateway.lockInspection = lockInspection;
  // OpenClaw never served: it waited 95 s for the earlier owner, then exited 1.
  gateway.serving = false;
  assert.equal((await readReadyStatusFromHandler(gateway.statusHandler)).status, 503);
  required(gateway.children[0]).exit(1, null);
  return gateway;
}

function heldCheck(gateway: GatewaySupervisor) {
  return property(gateway.runtimeStatus(), "runtimeFailure", "check");
}

function recheck(gateway: GatewaySupervisor) {
  return required(gateway.intervals.find(({ delay }) => delay === RECHECK_MS)).callback();
}

export function registerGatewayStateLockCases(): void {
  test("Kubernetes Gateway holds the state lock its native start refused", async (t) => {
    const gateway = await startRefusedGateway(t);

    // The wrapper holds the refusal under the check the tool policy step uses for the same
    // lock, and its log names OpenClaw's holder, so the deployment status names the lock
    // instead of a bare exit 1 and a container restart into the same refusal.
    assert.deepEqual(gateway.exits, []);
    const { checkedAt, ...held } = record(property(gateway.runtimeStatus(), "runtimeFailure"));
    assert.ok(!Number.isNaN(Date.parse(text(checkedAt))));
    assert.deepEqual(held, {
      component: "gateway",
      check: "gateway-state-lock",
      code: "UNAVAILABLE",
    });
    assert.ok(gateway.logs.includes(lockHoldLine()), JSON.stringify(gateway.logs));
    // The confirmation would recover the lock without proof that the holder stopped.
    assert.equal(JSON.stringify(gateway.logs).includes(confirmation), false);
    assert.deepEqual(gateway.lockInspectionCalls, [expectedInspection]);

    // A held Gateway is not respawned for a changed Harness peer.
    gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
    const peerRequestsBefore = gateway.peerRequests;
    await gateway.pollPeer();
    assert.equal(gateway.peerRequests, peerRequestsBefore, "a held Gateway skips the peer poll");
    assert.equal(gateway.children.length, 1);

    // While the holder remains, the hold stays.
    recheck(gateway);
    assert.deepEqual(gateway.exits, []);
    assert.equal(
      property(gateway.runtimeStatus(), "runtimeFailure", "check"),
      "gateway-state-lock",
    );

    // An operator who proved the holder stopped recovers the lock; the next inspection finds
    // it free and the container restarts on purpose, so its next start takes the lock. The
    // wrapper itself only ever inspected.
    gateway.lockInspection = freeLock;
    recheck(gateway);
    assert.deepEqual(gateway.exits, [DELIBERATE_RESTART]);
    assertDeliberateRestart(gateway, "GATEWAY_STATE_LOCK_RELEASED");
    assert.deepEqual(gateway.lockInspectionCalls, [
      expectedInspection,
      expectedInspection,
      expectedInspection,
    ]);
    assert.equal(gateway.children.length, 1);
  });

  test("Kubernetes Gateway held on the state lock stops on SIGTERM", async (t) => {
    const gateway = await startRefusedGateway(t);
    assert.equal(
      property(gateway.runtimeStatus(), "runtimeFailure", "check"),
      "gateway-state-lock",
    );
    // `occ agent stop`, the first recovery step, deletes the Pod.
    required(gateway.signalHandlers.SIGTERM)();
    assert.deepEqual(gateway.exits, [0]);
    // A recheck that fires before the process ends neither inspects nor restarts.
    gateway.lockInspection = freeLock;
    recheck(gateway);
    assert.deepEqual(gateway.exits, [0]);
    assert.deepEqual(gateway.lockInspectionCalls, [expectedInspection]);
  });

  test("Kubernetes Gateway releases its own exited child's records before it inspects the state lock", async (t) => {
    const gateway: GatewaySupervisor = await startCodexGatewaySupervisor(t, {
      runtimeStatus: true,
    });
    liveNamespace(gateway);
    // Only the wrapper's own child holds the lock. The release proves it dead in this live
    // namespace and recovers its records, so the inspection finds the lock free.
    gateway.lockInspection = inspection([ownHolder]);
    gateway.exitRelease = () => {
      gateway.lockInspection = freeLock;
      return released;
    };
    gateway.serving = false;
    required(gateway.children[0]).exit(1, null);
    assert.equal(gateway.exitReleaseCalls.length, 1);
    assert.equal(property(gateway.exitReleaseCalls[0], "pidNsInode"), "4026536354");
    assert.equal(property(gateway.exitReleaseCalls[0], "pidNsInitStartTicks"), 4242);
    assert.deepEqual(gateway.lockInspectionCalls, [expectedInspection]);
    assert.deepEqual(gateway.exits, [1]);
    assert.equal(property(gateway.runtimeStatus(), "runtimeFailure"), undefined);
  });

  test("Kubernetes Gateway held on the state lock retries a failed exit release", async (t) => {
    const gateway: GatewaySupervisor = await startCodexGatewaySupervisor(t, {
      runtimeStatus: true,
    });
    liveNamespace(gateway);
    // Another holder made OpenClaw keep every lock, so the child's own records remain too.
    gateway.lockInspection = inspection([ownHolder, leaseHolder]);
    gateway.exitRelease = () => keptLocks;
    gateway.serving = false;
    required(gateway.children[0]).exit(1, null);
    assert.deepEqual(gateway.exits, []);
    assert.equal(heldCheck(gateway), "gateway-state-lock");
    assert.equal(gateway.exitReleaseCalls.length, 1);

    // That holder is gone; only the child's records hold the lock now. This namespace still
    // lives, so the retry proves the child dead, and the hold ends with a deliberate restart.
    gateway.lockInspection = inspection([ownHolder]);
    gateway.exitRelease = () => {
      gateway.lockInspection = freeLock;
      return released;
    };
    recheck(gateway);
    assert.equal(gateway.exitReleaseCalls.length, 2);
    assert.deepEqual(gateway.exits, [DELIBERATE_RESTART]);
    assertDeliberateRestart(gateway, "GATEWAY_STATE_LOCK_RELEASED");
  });

  test("Kubernetes Gateway held on the state lock retries the exit release only until it succeeds", async (t) => {
    const gateway: GatewaySupervisor = await startCodexGatewaySupervisor(t, {
      runtimeStatus: true,
    });
    liveNamespace(gateway);
    gateway.lockInspection = inspection([ownHolder, leaseHolder]);
    gateway.exitRelease = () => keptLocks;
    gateway.serving = false;
    required(gateway.children[0]).exit(1, null);
    // The retry recovers the child's records; the foreign lease still holds.
    gateway.exitRelease = () => {
      gateway.lockInspection = heldLock;
      return released;
    };
    recheck(gateway);
    assert.equal(gateway.exitReleaseCalls.length, 2);
    assert.deepEqual(gateway.exits, []);
    // Nothing of the child's remains, so later rechecks only inspect.
    recheck(gateway);
    assert.equal(gateway.exitReleaseCalls.length, 2);
    assert.deepEqual(gateway.exits, []);
    assert.equal(gateway.lockInspectionCalls.length, 3);
  });

  test("Kubernetes Gateway logs every state lock holder, each cut on its own", async (t) => {
    // Three lock files and the lease, the most OpenClaw lists; one of them over-long.
    const longHolder = lockFileHolder(`/home/node/.openclaw/${"x".repeat(1_500)}/gateway.lock`);
    const holders = [
      longHolder,
      lockFileHolder("/home/node/.openclaw/state/gateway.state.lock"),
      lockFileHolder("/home/node/.openclaw/state/gateway.config.lock"),
      leaseHolder,
    ];
    const gateway = await startRefusedGateway(t, inspection(holders));
    assert.equal(heldCheck(gateway), "gateway-state-lock");
    // The lease, which the recovery steps name, is never dropped or split.
    const reported = [longHolder.slice(0, 500), ...holders.slice(1)].join(" ");
    assert.ok(gateway.logs.includes(lockHoldLine(reported)), JSON.stringify(gateway.logs));
  });

  test("Kubernetes Gateway holds an invalid configuration before it inspects the state lock", async (t) => {
    const gateway: GatewaySupervisor = await startCodexGatewaySupervisor(t, {
      runtimeStatus: true,
    });
    // Either could explain an exit 1; the configuration check names the settings to fix.
    gateway.validation = invalidGatewayConfiguration;
    gateway.lockInspection = heldLock;
    gateway.serving = false;
    required(gateway.children[0]).exit(1, null);
    assert.deepEqual(gateway.exits, []);
    assert.equal(heldCheck(gateway), "gateway-config");
    assert.deepEqual(gateway.lockInspectionCalls, []);
  });

  test("Kubernetes Gateway held on the state lock exits 1 when it cannot inspect it again", async (t) => {
    const gateway = await startRefusedGateway(t);
    // Without a current answer the hold cannot show that the lock is still taken: the
    // container restarts as it did before the hold.
    gateway.lockInspection = {
      status: null,
      error: new Error("spawnSync node ETIMEDOUT"),
      stdout: "",
    };
    recheck(gateway);
    assert.deepEqual(gateway.exits, [1]);
  });

  // Every other exit restarts the container as before. A failed or unreadable inspection is
  // never reported as the lock.
  type ExitCase = {
    label: string;
    lockInspection: GatewaySupervisor["lockInspection"];
    served?: boolean;
    runtimeStatus?: boolean;
    exit: [code: number | null, signal: NodeJS.Signals | null];
    inspects: boolean;
  };
  const cases: ExitCase[] = [
    { label: "a free state lock", lockInspection: freeLock, exit: [1, null], inspects: true },
    {
      label: "an inspection that times out",
      lockInspection: { status: null, error: new Error("spawnSync node ETIMEDOUT"), stdout: "" },
      exit: [1, null],
      inspects: true,
    },
    {
      label: "an inspection that fails",
      lockInspection: { status: 1, stdout: "" },
      exit: [1, null],
      inspects: true,
    },
    {
      label: "an inspection that prints no report",
      lockInspection: { status: 0, stdout: "No Gateway lock or owner lease is present." },
      exit: [1, null],
      inspects: true,
    },
    {
      label: "an inspection that reports a lock without holders",
      lockInspection: inspection([], true),
      exit: [1, null],
      inspects: true,
    },
    {
      label: "an inspection that reports holders without a lock",
      lockInspection: inspection([leaseHolder], false),
      exit: [1, null],
      inspects: true,
    },
    {
      label: "an inspection with an empty holder",
      lockInspection: inspection([leaseHolder, ""]),
      exit: [1, null],
      inspects: true,
    },
    { label: "status 78", lockInspection: heldLock, exit: [78, null], inspects: false },
    { label: "a kill", lockInspection: heldLock, exit: [null, "SIGKILL"], inspects: false },
    {
      label: "a Gateway that served first",
      lockInspection: heldLock,
      served: true,
      exit: [1, null],
      inspects: false,
    },
    {
      label: "no Compute status port",
      lockInspection: heldLock,
      runtimeStatus: false,
      exit: [1, null],
      inspects: false,
    },
  ];
  for (const {
    label,
    lockInspection,
    served = false,
    runtimeStatus = true,
    exit,
    inspects,
  } of cases) {
    test(`Kubernetes Gateway restarts after an exit with ${label}`, async (t) => {
      const gateway: GatewaySupervisor = await startCodexGatewaySupervisor(t, { runtimeStatus });
      writableConfiguration(gateway);
      gateway.lockInspection = lockInspection;
      if (served) {
        assert.equal((await readReadyStatusFromHandler(gateway.statusHandler)).status, 200);
      } else {
        gateway.serving = false;
      }
      const [code, signal] = exit;
      required(gateway.children[0]).exit(code, signal);
      assert.deepEqual(gateway.exits, [code ?? 1]);
      assert.deepEqual(gateway.lockInspectionCalls, inspects ? [expectedInspection] : []);
      if (runtimeStatus) {
        assert.equal(property(gateway.runtimeStatus(), "runtimeFailure"), undefined);
      }
      assert.equal(
        gateway.logs.some((line) => String(line).includes("Gateway state lock")),
        false,
      );
    });
  }
}
