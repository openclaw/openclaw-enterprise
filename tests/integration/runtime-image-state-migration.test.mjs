// Runtime image agent database migration smoke tests, split from
// runtime-image-startup.test.mjs so CI can run them beside it: a Gateway started
// on the released state migrates its agent database once with Doctor, through
// both the Kubernetes and the Docker development entrypoints.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EMBEDDED_GATEWAY_OWNER_STARTUP,
  GATEWAY_NAMESPACE_PROBE,
  INITIALIZE_EMBEDDED_GATEWAY_OWNER,
} from "../../apps/controller/src/drivers/compute/embedded-gateway-owner.ts";
import { GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION } from "../../apps/controller/src/drivers/compute/runtime-startup.ts";
import {
  image,
  imageTestOptions,
  runDocker,
  gatewayStateVolume,
  temporaryGatewayConfiguration,
  jsonLogEntries,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.mjs";

test("embedded Gateway restart recovers only its signed Pod owner", imageTestOptions, async (t) => {
  const keyDir = "/run/oce-gateway-owner-key";
  const startDir = "/run/oce-gateway-owner-start";
  const keyVolume = await gatewayStateVolume(t, keyDir);
  const startVolume = await gatewayStateVolume(t, startDir);
  const pod = "85576b7d-39b1-4739-8541-366548813cd1";
  const env = { OPENCLAW_EMBEDDED_GATEWAY_OWNER: "1", OPENCLAW_STATE_DIR: "/tmp/state" };
  const run = (script, { uid = pod, init = false, readOnly = false } = {}) =>
    runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      "--hostname",
      "signed-owner-fixture",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "1000:1000",
      "--tmpfs",
      "/tmp:mode=1777",
      "--volume",
      `${keyVolume}:${keyDir}${init ? "" : ":ro"}`,
      "--volume",
      `${startVolume}:${startDir}${readOnly ? ":ro" : ""}`,
      ...Object.entries({ ...env, OPENCLAW_POD_UID: uid }).flatMap(([name, value]) => [
        "--env",
        name + "=" + value,
      ]),
      "--entrypoint",
      "/usr/bin/tini",
      image,
      "-s",
      "--",
      "node",
      "-e",
      script,
    ]);
  const fs = 'require("node:fs")';
  const privateKey = JSON.stringify(startDir + "/private.pem");
  const owner = JSON.stringify(startDir + "/owner.json");
  const assertConsumed = `require("node:assert/strict").equal(${fs}.existsSync(${privateKey}), false);`;
  await run(INITIALIZE_EMBEDDED_GATEWAY_OWNER, { init: true });
  // The sampler cannot retire its key on a read-only startup volume. User code must not run.
  await assert.rejects(
    run(EMBEDDED_GATEWAY_OWNER_STARTUP + '\nconsole.log("started");', { readOnly: true }),
    /EROFS|read-only file system/i,
  );
  const { stdout } = await run(
    EMBEDDED_GATEWAY_OWNER_STARTUP +
      "\n" +
      assertConsumed +
      `console.log(${fs}.readFileSync(${owner}, "utf8"));`,
  );
  const record = JSON.parse(stdout);
  const prior = JSON.parse(record.statement);
  assert.equal(prior.pod, pod);

  // Each invocation is a separate private Linux PID namespace, as with a kubelet restart.
  // The lock is synthetic. The replacement runs the shipping OC CLI against it.
  const recover = async (candidate, namespace, uid = pod) => {
    const setup = `
      const fs = require("node:fs");
      const root = process.env.OPENCLAW_STATE_DIR;
      const dir = root + "/tmp/openclaw-1000", lock = dir + "/gateway.state.lock";
      fs.mkdirSync(dir, {recursive:true,mode:0o700}); fs.mkdirSync(root + "/state", {recursive:true,mode:0o700});
      fs.rmSync(${owner}, {force:true});
      fs.writeFileSync(${owner}, ${JSON.stringify(JSON.stringify(candidate))});
      fs.writeFileSync(lock, JSON.stringify({pid:999999, createdAt:"2026-01-01T00:00:00.000Z",
        configPath:root + "/openclaw.json", stateDir:root, role:"gateway",
        pidNsInitStartTicks:${namespace.pidNsInitStartTicks},
        processNamespace:${JSON.stringify({ platform: namespace.platform, host: namespace.host, identity: namespace.identity, pidNsInode: namespace.pidNsInode })}}), {mode:0o600});
      console.log("observed kernels", ${JSON.stringify(namespace)}, ${GATEWAY_NAMESPACE_PROBE});
    `;
    return run(
      setup +
        EMBEDDED_GATEWAY_OWNER_STARTUP +
        '\nconsole.log("lock-present=" + fs.existsSync(lock));',
      { uid },
    );
  };
  const foreign = { ...prior.namespace, host: "unrelated-gateway" };
  const matching = await recover(record, prior.namespace);
  assert.match(matching.stdout, /lock-present=false\s*$/, matching.stdout + matching.stderr);
  assert.match((await recover(record, foreign)).stdout, /lock-present=true\s*$/);
  const later = {
    ...prior.namespace,
    pidNsInitStartTicks: prior.namespace.pidNsInitStartTicks + 1,
  };
  assert.match((await recover(record, later)).stdout, /lock-present=true\s*$/);
  assert.match(
    (await recover(record, prior.namespace, "a96d9704-ce9f-4917-846f-73613e629c43")).stdout,
    /lock-present=true\s*$/,
  );
  assert.match(
    (
      await recover(
        { ...record, statement: JSON.stringify({ ...prior, namespace: foreign }) },
        foreign,
      )
    ).stdout,
    /lock-present=true\s*$/,
  );
  // A previous model can write a key and signed claim into scratch. A retried init
  // must keep its own verifier. Missing Pod identity must still retire the scratch key.
  const { stdout: forged } = await run(`
    const crypto = require("node:crypto"), {privateKey} = crypto.generateKeyPairSync("ed25519");
    ${fs}.writeFileSync(${privateKey}, privateKey.export({type:"pkcs8",format:"pem"}));
    const statement = ${JSON.stringify(JSON.stringify({ ...prior, namespace: foreign }))};
    console.log(JSON.stringify({ statement, signature:crypto.sign(null,Buffer.from(statement),privateKey).toString("base64") }));
  `);
  await run(INITIALIZE_EMBEDDED_GATEWAY_OWNER, { init: true });
  await run(EMBEDDED_GATEWAY_OWNER_STARTUP + "\n" + assertConsumed, { uid: "" });
  assert.match((await recover(JSON.parse(forged), foreign)).stdout, /lock-present=true\s*$/);
});

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

// Copies the released state into a new volume for mounting at `mountPath`.
function releasedGatewayStateVolume(t, mountPath) {
  return gatewayStateVolume(t, mountPath, {
    seed: "tar -xzf /released-gateway-state.tar.gz -C /home/node",
    seedVolumes: [`${releasedGatewayState}:/released-gateway-state.tar.gz:ro`],
  });
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

// Each case seeds its own state volume and starts its own Gateway containers:
// random volume and container names, no shared port. Both run at once.
describe("runtime image released state migration", { concurrency: 2 }, () => {
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
});
