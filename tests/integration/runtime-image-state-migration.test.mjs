// Runtime image agent database migration smoke tests, split from
// runtime-image-startup.test.mjs so CI can run them beside it: a Gateway started
// on the released state migrates its agent database once with Doctor, through
// both the Kubernetes and the Docker development entrypoints.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION } from "../../apps/controller/src/drivers/compute/runtime-startup.ts";
import {
  image,
  imageTestOptions,
  runDocker,
  temporaryGatewayConfiguration,
  jsonLogEntries,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.mjs";

// OpenClaw state written by the 2026-09-28 release's runtime image
// (ghcr.io/openclaw/openclaw-enterprise-runtime@sha256:f17a66a18de9d4231c9579faf90573d80bef1278aaaf63135b6c6ce0b71a23b3,
// OpenClaw 000d03942c87): its Gateway ran one turn against a stub provider that
// answers 401 and stopped cleanly. The archive holds the shared state database
// (its device identity and config revision keys deleted, then vacuumed) and the
// main agent database (schema 23) as that Gateway left it.
const releasedGatewayState = fileURLToPath(
  new URL("../fixtures/runtime-state/released-gateway-state.tar.gz", import.meta.url),
);

async function agentDatabaseFacts(containerName) {
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    "-e",
    `
const { readdirSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const directory = "/home/node/.openclaw/agents/main/agent";
const database = new DatabaseSync(directory + "/openclaw-agent.sqlite", { readOnly: true });
const { user_version: version } = database.prepare("PRAGMA user_version").get();
database.close();
const backups = readdirSync(directory).filter((name) => name.includes(".pre-startup-migration-")).sort();
process.stdout.write(JSON.stringify({ version, backups }));
`,
  ]);
  return JSON.parse(stdout);
}

function stateMigrationPhases(logs) {
  return jsonLogEntries(logs).filter(
    (entry) => entry.event === "runtime.startup_phase" && entry.phase === "state-migration",
  );
}

// Copies the released state into a new volume, owned as the Gateway user, for
// mounting at `mountPath` (the Gateway home or its ~/.openclaw).
async function releasedGatewayStateVolume(t, mountPath) {
  const volume = `oce-runtime-image-state-${randomBytes(6).toString("hex")}`;
  await runDocker(["volume", "create", volume]);
  t.after(() => runDocker(["volume", "rm", "-f", volume]).catch(() => {}));
  // As root, like the Docker Driver's workspace setup: a new volume mounted
  // below the image's home can be root-owned.
  await runDocker([
    "run",
    "--rm",
    "--user",
    "0:0",
    "--network",
    "none",
    "--volume",
    `${volume}:${mountPath}`,
    "--volume",
    `${releasedGatewayState}:/released-gateway-state.tar.gz:ro`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    `tar -xzf /released-gateway-state.tar.gz -C /home/node && chown -R 1000:1000 ${mountPath}`,
  ]);
  return volume;
}

// startGateway(readinessAttempts) starts a Gateway on the released state volume.
async function assertReleasedGatewayMigratesOnce(startGateway) {
  // The current OpenClaw refuses this database until Doctor migrates it. Doctor's
  // full repair pass takes about 20 s here and over a minute on a busy CI runner.
  const released = await startGateway(240);
  assert.deepEqual(
    stateMigrationPhases(released.logs).map(({ outcome }) => outcome),
    ["ok"],
    released.logs,
  );
  assert.match(released.logs, /from schema 23 to \d+ with openclaw doctor --fix/);
  assert.doesNotMatch(released.logs, /uses schema version 23/);
  const migrated = await agentDatabaseFacts(released.containerName);
  assert.equal(
    migrated.version,
    OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION,
    "Doctor migrated to another schema: update OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION with the OpenClaw pin.",
  );
  assert.equal(migrated.backups.length > 0, true, "Doctor keeps a pre-migration copy");
  await runDocker(["stop", "--time", "60", released.containerName]);
  await runDocker(["rm", "-f", released.containerName]);

  // A current database starts without Doctor.
  const current = await startGateway();
  assert.deepEqual(stateMigrationPhases(current.logs), [], current.logs);
  assert.doesNotMatch(current.logs, /openclaw doctor --fix/);
  assert.deepEqual(await agentDatabaseFacts(current.containerName), migrated);
}

test(
  "runtime image migrates a released Gateway's agent database once before starting OpenClaw",
  imageTestOptions,
  async (t) => {
    // The volume replaces the Gateway's /home/node tmpfs, as its PersistentVolume does.
    const volume = await releasedGatewayStateVolume(t, "/home/node");
    const configurationPath = await temporaryGatewayConfiguration(t, "openclaw");
    await assertReleasedGatewayMigratesOnce((readinessAttempts) =>
      runGatewaySmoke(t, "openclaw", {
        configurationPath: "/etc/openclaw/openclaw.json",
        entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
        readinessAttempts,
        tmpfs: [],
        volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`, `${volume}:/home/node`],
        withAppServer: false,
      }),
    );
  },
);

test(
  "runtime image migrates a released agent database before the Docker development Gateway starts OpenClaw",
  imageTestOptions,
  async (t) => {
    // The Docker Driver's Agent state volume, over the Gateway's /home/node tmpfs.
    const volume = await releasedGatewayStateVolume(t, "/home/node/.openclaw");
    await assertReleasedGatewayMigratesOnce((readinessAttempts) =>
      runGatewaySmoke(t, "openclaw", {
        readinessAttempts,
        volumes: [`${volume}:/home/node/.openclaw`],
        withAppServer: false,
      }),
    );
  },
);
