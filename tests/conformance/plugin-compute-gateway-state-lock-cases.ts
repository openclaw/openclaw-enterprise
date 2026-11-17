import assert from "node:assert/strict";
import test from "node:test";
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
const leaseHolder =
  "SQLite Gateway owner lease: holder 44 at gateway-804a2e28f577-6d77574958-v8sp7/pid-ns" +
  " 4026536354, last renewed 452 s ago. Stop the holder before retrying; if it has already" +
  " stopped, run `openclaw gateway recover-lock` to inspect and explicitly recover the unchanged" +
  " owner.";
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
// The inspection the wrapper may run: never --confirm, which would recover the lock.
const expectedInspection = {
  command: "node",
  args: ["/app/openclaw.mjs", "gateway", "recover-lock", "--json"],
  readOnly: "1",
};
// The same line the tool policy step logs when `config validate` meets the lock first.
const lockHoldLine =
  "The dedicated Gateway cannot start: an earlier Gateway process did not stop cleanly and still" +
  " holds the Gateway state lock, and this container cannot verify that it stopped. It remains" +
  " unready; stop the Agent and recover the lock as the Agent troubleshooting guide describes for" +
  ` an unverifiable state owner. OpenClaw reported: ${leaseHolder}`;
const RECHECK_MS = 300_000;

async function startRefusedGateway(t: test.TestContext) {
  const gateway: GatewaySupervisor = await startCodexGatewaySupervisor(t, {
    runtimeStatus: true,
  });
  gateway.lockInspection = heldLock;
  // OpenClaw never served: it waited 95 s for the earlier owner, then exited 1.
  gateway.serving = false;
  assert.equal((await readReadyStatusFromHandler(gateway.statusHandler)).status, 503);
  required(gateway.children[0]).exit(1, null);
  return gateway;
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
    assert.ok(gateway.logs.includes(lockHoldLine), JSON.stringify(gateway.logs));
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
    assert.equal(property(gateway.runtimeStatus(), "runtimeFailure", "check"), "gateway-state-lock");

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
    assert.equal(property(gateway.runtimeStatus(), "runtimeFailure", "check"), "gateway-state-lock");
    // `occ agent stop`, the first recovery step, deletes the Pod.
    required(gateway.signalHandlers.SIGTERM)();
    assert.deepEqual(gateway.exits, [0]);
    assert.deepEqual(gateway.lockInspectionCalls, [expectedInspection]);
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
  for (const { label, lockInspection, served = false, runtimeStatus = true, exit, inspects } of cases) {
    test(`Kubernetes Gateway restarts after an exit with ${label}`, async (t) => {
      const gateway: GatewaySupervisor = await startCodexGatewaySupervisor(t, { runtimeStatus });
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
