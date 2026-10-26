// The embedded Gateway restarted after an unclean stop, split from
// runtime-image-startup-termination.test.mjs. It starts the wrapper through the
// same scenario helper as the startup probe files.
import assert from "node:assert/strict";
import test from "node:test";
import { INITIALIZE_EMBEDDED_GATEWAY_OWNER } from "../../apps/controller/src/drivers/compute/embedded-gateway-owner.ts";
import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
import {
  image,
  imageTestOptions,
  runDocker,
  gatewayStateVolume,
} from "../helpers/runtime-image-startup.mjs";
import {
  runStartupProbeScenario,
  observedValue,
  phaseAt,
  withStartupProbeEvidence,
} from "../helpers/runtime-image-startup-probe.mjs";

// Runs in the Gateway container: waits for the runtime readiness endpoint the
// kubelet probes, then sends one chat turn at once, as a client does on the
// first message after Start. Prints the turn's outcome as JSON.
async function firstTurnAfterReadiness({ budgetMs }) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const readiness = await fetch("http://127.0.0.1:18791/readyz", {
        signal: AbortSignal.timeout(2_000),
      });
      if (readiness.status === 200) {
        break;
      }
    } catch {
      // The status server is not listening yet.
    }
    if (Date.now() > deadline) {
      process.stdout.write(JSON.stringify({ error: "the Gateway did not become ready" }));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const response = await fetch("http://127.0.0.1:8080/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENCLAW_GATEWAY_PASSWORD}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "openclaw/default",
      stream: false,
      messages: [{ role: "user", content: "Reply with READY." }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let content;
  try {
    content = JSON.parse(text).choices?.[0]?.message?.content;
  } catch {
    // A refused turn's body need not be JSON; the status and body are reported.
  }
  process.stdout.write(
    JSON.stringify({ status: response.status, content, body: text.slice(0, 1_000) }),
  );
}

async function sendFirstTurn(containerName) {
  const budgetMs = 240_000 * imageSmokeTimeoutMultiplier;
  const { stdout } = await runDocker(
    [
      "exec",
      containerName,
      "node",
      "--input-type=module",
      "-e",
      `await (${firstTurnAfterReadiness.toString()})(${JSON.stringify({ budgetMs })});`,
    ],
    { timeout: budgetMs + 150_000 },
  );
  return JSON.parse(stdout);
}

// Age the Agent lease so that its database must take the full inspection
// path. The Gateway's own custody is transferred separately using Engine evidence.
const ownerHeartbeatStaleMs = 90_000;

// Runs in a one-shot container on the stopped Gateway's state: moves the owner
// heartbeats back by `ageMs`, leaving the volume as it is that long after the
// kill. The heartbeats are the mtimes of the Gateway's lock files (every lock
// file is aged, as real time would) and heartbeat_at of the state database's
// leases (their other times move with it). The agent database is not opened.
// With automatic checkpoints off, the process then kills itself, so SQLite
// does not checkpoint on close and the state database is left with its
// write-ahead log, as the killed Gateway left it. Prints what it aged as JSON.
async function ageOwnerHeartbeats({ stateDir, ageMs }) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const locks = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile() && entry.name.endsWith(".lock")) {
        const { atime, mtimeMs } = fs.statSync(file);
        fs.utimesSync(file, atime, new Date(mtimeMs - ageMs));
        locks.push(path.relative(stateDir, file));
      }
    }
  };
  walk(stateDir);
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
  database.exec("PRAGMA wal_autocheckpoint = 0");
  const aged = database
    .prepare(
      "UPDATE state_leases SET heartbeat_at = heartbeat_at - :age, expires_at = expires_at - :age, created_at = created_at - :age, updated_at = updated_at - :age RETURNING scope",
    )
    .all({ age: ageMs });
  process.stdout.write(JSON.stringify({ locks, leases: aged.map(({ scope }) => scope) }), () =>
    process.kill(process.pid, "SIGKILL"),
  );
}

async function ageStoppedGatewayHeartbeats(volume, mountPath, ageMs) {
  const program = `await (${ageOwnerHeartbeats.toString()})(${JSON.stringify({ stateDir: "/home/node/.openclaw", ageMs })});`;
  const { stdout, stderr } = await runDocker([
    "run",
    "--rm",
    "--user",
    "1000:1000",
    "--network",
    "none",
    "--volume",
    `${volume}:${mountPath}`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    // The program ends with SIGKILL (exit 137); any other exit is a failure.
    'node --no-warnings --input-type=module -e "$0"; status=$?; [ "$status" -eq 137 ] || exit "$status"',
    program,
  ]);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`ageing the Gateway heartbeats printed no result: ${stdout} ${stderr}`);
  }
}

// Finding 2185: a Gateway Pod went Ready while OpenClaw was still inspecting
// the agent database its previous process left without a release, and the
// first chat turn after Start got HTTP 500. A Gateway killed without its
// SIGTERM drain (OOM kill, node loss) leaves the same lease. Its restart on the
// same state must stay unready until the agent takes turns.
for (const provider of ["Docker", "Kubernetes"]) {
  test(
    provider === "Docker"
      ? "runtime image embedded Gateway restarted after an unclean stop is ready only when its agent takes turns"
      : "an embedded Gateway container restarted in the same Kubernetes Pod recovers its first owner",
    { ...imageTestOptions, timeout: 900_000 },
    async (t) => {
      const mountPath = provider === "Docker" ? "/home/node/.openclaw" : "/home/node";
      const volume = await gatewayStateVolume(t, mountPath);
      const stateMount = provider === "Docker" ? { stateVolume: volume } : { homeVolume: volume };
      // The named mounts give two Docker containers the lifetime and mount
      // permissions of one Pod's two emptyDirs. A real PID namespace dies on kill.
      const podOwner =
        provider === "Kubernetes"
          ? {
              verifier: await gatewayStateVolume(t, "/run/oce-gateway-owner-key"),
              scratch: await gatewayStateVolume(t, "/run/oce-gateway-owner-start"),
            }
          : undefined;
      if (podOwner) {
        await runDocker([
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "1000:1000",
          "-v",
          podOwner.verifier + ":/run/oce-gateway-owner-key",
          "-v",
          podOwner.scratch + ":/run/oce-gateway-owner-start",
          "--entrypoint",
          "node",
          image,
          "-e",
          INITIALIZE_EMBEDDED_GATEWAY_OWNER,
        ]);
      }
      // The first Gateway answers a turn, so its agent database holds a lease,
      // and is then killed with no chance to release it.
      let firstTurn;
      let terminatedGatewayNamespace;
      const compute = podOwner
        ? undefined
        : new DockerComputeDriver({ images: { gateway: image, agent: image } });
      const first = await runStartupProbeScenario(t, {
        kind: "gateway",
        mode: "answer",
        ...stateMount,
        podOwner,
        until: ({ events }) => events.some(observedValue("ready", true)),
        act: async ({ containerName }) => {
          firstTurn = await sendFirstTurn(containerName);
          if (compute) {
            await compute.rememberEmbeddedGateway(
              containerName,
              await compute.container(containerName),
              volume,
            );
          }
          await runDocker(["kill", "--signal", "KILL", containerName]);
          // No heartbeat renewal can follow the aging below.
          await runDocker(["wait", containerName]);
          if (compute) {
            await compute.removeGateway(containerName, await compute.container(containerName));
            terminatedGatewayNamespace = await compute.takeEmbeddedGatewayHandoff(
              containerName,
              volume,
            );
            assert.ok(terminatedGatewayNamespace, "Engine must confirm the same container stopped");
          }
        },
      });
      await withStartupProbeEvidence(first, async () => {
        assert.equal(firstTurn.status, 200, `first Gateway turn: ${JSON.stringify(firstTurn)}`);
      });
      // The separate Agent database inspection still requires an aged, unreleased
      // lease. Preserve the cross-namespace restart without waiting 92 seconds.
      const aged = await ageStoppedGatewayHeartbeats(
        volume,
        mountPath,
        ownerHeartbeatStaleMs + 2_000,
      );
      assert.ok(
        aged.locks.includes("tmp/openclaw-1000/gateway.state.lock"),
        `no Gateway lock file to age: ${JSON.stringify(aged)}`,
      );
      assert.ok(
        aged.leases.includes("gateway-owner"),
        `no owner lease to age: ${JSON.stringify(aged)}`,
      );
      // The restart's first turn goes out as soon as the runtime reports ready.
      let turn;
      const restarted = await runStartupProbeScenario(t, {
        terminatedGatewayNamespace,
        kind: "gateway",
        mode: "answer",
        ...stateMount,
        podOwner,
        until: ({ phases }) => phaseAt(phases, "native-spawn") !== undefined,
        act: async ({ containerName }) => {
          // A failed exec is reported with the wrapper output below.
          turn = await sendFirstTurn(containerName).catch((error) => ({ error: error.message }));
        },
      });
      await withStartupProbeEvidence(restarted, async () => {
        // Before the fix: HTTP 500 {"error":{"message":"internal error"}}.
        assert.equal(turn.status, 200, `first turn after restart: ${JSON.stringify(turn)}`);
        assert.equal(turn.content, "READY");
        assert.match(restarted.snapshot.output, /"recovered"\s*:\s*true/);
        // The restart did inspect the unreleased database in the background
        // after its listener bound: the window this readiness must cover.
        assert.match(restarted.snapshot.output, /previous release not observed/);
        // The full integrity gate, which runs when the restart cannot prove from
        // its own PID namespace that the killed owner is dead. OpenClaw logs this
        // line only with that refusal's cause, which depends on whether the
        // restart got the owner's PID; a dead owner in the same namespace gets
        // the deferred check instead and no such line.
        assert.match(
          restarted.snapshot.output,
          /integrityGateReason=stale-lease-full because=[a-z]/,
        );
        assert.match(restarted.snapshot.output, /recovered after background inspection/);
      });
    },
  );
}
