// The embedded Gateway restarted after an unclean stop, split from
// runtime-image-startup-termination.test.mjs. It starts the wrapper through the
// same scenario helper as the startup probe files.
import assert from "node:assert/strict";
import test from "node:test";
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

async function stopAndRecoverGateway(containerName) {
  const { stdout: id } = await runDocker(["inspect", "--format", "{{.Id}}", containerName]);
  const gatewayId = id.trim();
  await runDocker(["kill", "--signal", "KILL", gatewayId]);
  const stopped = await runDocker(["wait", gatewayId]);
  assert.equal(stopped.stdout.trim(), "137", "Docker must confirm the killed Gateway exited");

  // The test owns this private volume. Act as its operator only after Docker
  // confirms the exact former owner stopped. Reuse its read-only fixture config
  // and writable state so OC inspects the same locks the replacement will see.
  const command = [
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--volumes-from",
    gatewayId,
    "--tmpfs",
    "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
    "--env",
    "HOME=/home/node",
    "--env",
    "OPENCLAW_STATE_DIR=/home/node/.openclaw",
    "--env",
    "OPENCLAW_CONFIG_PATH=/etc/openclaw/openclaw.json",
    "--entrypoint",
    "node",
    image,
    "/app/openclaw.mjs",
    "gateway",
    "recover-lock",
    "--json",
  ];
  const { stdout: inspection } = await runDocker(command);
  const { present, confirmation } = JSON.parse(inspection);
  assert.equal(present, true, "the hard stop must leave Gateway ownership records");
  assert.match(confirmation, /^[a-f0-9]{64}$/);
  const { stdout: recovery } = await runDocker([...command, "--confirm", confirmation]);
  assert.equal(JSON.parse(recovery).recovered, true);
}

// Finding 2185: a Gateway Pod went Ready while OpenClaw was still inspecting
// the agent database its previous process left without a release, and the
// first chat turn after Start got HTTP 500. A Gateway killed without its
// SIGTERM drain (OOM kill, node loss) leaves the same lease. Its restart on the
// same state after operator recovery must stay unready until the agent takes turns.
test(
  "runtime image embedded Gateway serves its first turn after operator-confirmed recovery from an unclean stop",
  { ...imageTestOptions, timeout: 900_000 },
  async (t) => {
    const homeVolume = await gatewayStateVolume(t, "/home/node");
    // The first Gateway answers a turn, so its agent database holds a lease,
    // and is then killed with no chance to release it.
    let firstTurn;
    const first = await runStartupProbeScenario(t, {
      kind: "gateway",
      mode: "answer",
      homeVolume,
      until: ({ events }) => events.some(observedValue("ready", true)),
      act: async ({ containerName }) => {
        firstTurn = await sendFirstTurn(containerName);
      },
    });
    await withStartupProbeEvidence(first, async () => {
      assert.equal(firstTurn.status, 200, `first Gateway turn: ${JSON.stringify(firstTurn)}`);
      assert.equal(firstTurn.content, "READY");
    });
    await stopAndRecoverGateway(first.containerName);
    // The restart's first turn goes out as soon as the runtime reports ready.
    let turn;
    const restarted = await runStartupProbeScenario(t, {
      kind: "gateway",
      mode: "answer",
      homeVolume,
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
      // The restart did inspect the unreleased database in the background
      // after its listener bound: the window this readiness must cover.
      assert.match(restarted.snapshot.output, /previous release not observed/);
      // The full integrity gate, which runs when the restart cannot prove from
      // its own PID namespace that the killed owner is dead. OpenClaw logs this
      // line only with that refusal's cause, which depends on whether the
      // restart got the owner's PID; a dead owner in the same namespace gets
      // the deferred check instead and no such line.
      assert.match(restarted.snapshot.output, /integrityGateReason=stale-lease-full because=[a-z]/);
      assert.match(restarted.snapshot.output, /recovered after background inspection/);
    });
  },
);
