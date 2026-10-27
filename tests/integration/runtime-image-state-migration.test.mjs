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
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION,
  OPENCLAW_STATE_DATABASE_SCHEMA_VERSION,
} from "../../apps/controller/src/drivers/compute/runtime-startup.ts";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";
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
  // The shared state database (schema 19) and the main agent database (schema 23).
  assert.match(released.logs, /from schema 19 to \d+, 23 to \d+ with openclaw doctor --fix/);
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

// A dedicated Codex Agent's workspace node state as a Harness on the OpenClaw
// f8386bc7 runtime image (2026.9.9, shared state schema 20) left it: native setup
// and one node start, which saved its device identity. Recorded for finding 2685,
// where every such Harness failed workspace setup after an upgrade until Doctor
// moved its client credentials. The archive holds the initialized workspace (Git
// sample hooks left out) and the shared state database with that identity
// deleted, then vacuumed; each run saves a fresh one in its place.
const olderWorkspaceNodeState = fileURLToPath(
  new URL(
    "../fixtures/runtime-state/workspace-node-state-openclaw-f8386bc7.tar.gz",
    import.meta.url,
  ),
);

// Runs in the runtime image as the Harness user. Saves a device identity in the
// older store's row format (key "primary", id = SHA-256 of the raw Ed25519 public
// key), starts the real program twice with only its long-lived children (and a
// native worker's model probe) replaced by `children`, and reports what the
// current OpenClaw then reads. Never prints a key.
const WORKSPACE_NODE_UPGRADE = String.raw`
const crypto = require("node:crypto");
const { readdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const [entrypoint, timeoutMs, children, environment] =
  [process.argv[1], Number(process.argv[2]), process.argv[3], JSON.parse(process.argv[4])];
const state = "/home/node/.openclaw-node";
const shared = state + "/state/openclaw.sqlite";
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const savedDeviceId = crypto.createHash("sha256")
  .update(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url")).digest("hex");
const savedAt = Date.now();
const older = new DatabaseSync(shared);
older.prepare("INSERT INTO device_identities VALUES ('primary', ?, ?, ?, ?, ?)").run(
  savedDeviceId,
  publicKey.export({ type: "spki", format: "pem" }),
  privateKey.export({ type: "pkcs8", format: "pem" }),
  savedAt,
  savedAt,
);
older.close();
const program = children + "\n" + entrypoint;
const start = () => {
  const result = spawnSync(process.execPath, ["-e", program], {
    env: {
      PATH: process.env.PATH,
      HOME: "/home/node",
      OPENCLAW_NODE_STATE_DIR: state,
      OPENCLAW_NODE_SETUP_CODE: "synthetic-setup",
      OPENCLAW_WORKSPACE_DIR: "/home/node/workspace",
      ...environment,
    },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return { status: result.status, signal: result.signal, output: result.stdout + result.stderr };
};
const upgraded = start();
const identity = spawnSync(process.execPath, ["/app/openclaw.mjs", "node", "identity", "--json"], {
  env: { PATH: process.env.PATH, HOME: "/home/node", OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: state + "/openclaw.json", OPENCLAW_NO_AUTO_UPDATE: "1" },
  encoding: "utf8",
  timeout: 60_000,
});
let deviceId;
try { deviceId = JSON.parse(identity.stdout).deviceId; } catch {}
function schema(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const header = database.prepare("PRAGMA user_version").get().user_version;
    let marker = 0;
    try {
      marker = Number(JSON.parse(database.prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
      ).get()?.value_json ?? "0"));
    } catch {}
    // The current schema keeps client credentials elsewhere; only an older copy has this table.
    let backedUpDeviceId;
    try {
      backedUpDeviceId = database.prepare(
        "SELECT device_id FROM device_identities WHERE identity_key = 'primary'",
      ).get()?.device_id;
    } catch {}
    return { version: Math.max(header, marker), deviceId: backedUpDeviceId };
  } finally {
    database.close();
  }
}
const backups = readdirSync(state + "/state")
  .filter((name) => name.startsWith("openclaw.sqlite.pre-startup-migration-") && name.endsWith(".bak"));
const current = start();
process.stdout.write(JSON.stringify({
  savedDeviceId,
  upgraded,
  deviceId,
  identityStatus: identity.status,
  migrated: schema(shared).version,
  backups: backups.map((name) => ({ name, ...schema(state + "/state/" + name) })),
  current,
}));
`;

// The Harness's node and Codex children, replaced; Doctor runs for real.
const HARNESS_CHILDREN = [
  'const cp = require("node:child_process");',
  "const realSpawn = cp.spawn;",
  "cp.spawn = (command, args, options) => {",
  '  if (args[1] === "doctor") return realSpawn(command, args, options);',
  '  console.log("HARNESS_CHILD_STARTED " + (args[0] === "/app/openclaw.mjs" ? "node" : "codex"));',
  '  return new (require("node:events").EventEmitter)();',
  "};",
].join("\n");

// The native worker's connect child and its model probe's answer, replaced; Doctor
// runs for real, with the environment the worker gives it (no model credential).
const WORKER_CHILDREN = [
  'const cp = require("node:child_process");',
  "const realSpawn = cp.spawn;",
  "const realSpawnSync = cp.spawnSync;",
  "cp.spawn = (command, args, options) => {",
  '  if (args[1] === "doctor") return realSpawn(command, args, options);',
  '  console.log("WORKER_CHILD_STARTED " + args[1]);',
  '  return new (require("node:events").EventEmitter)();',
  "};",
  "cp.spawnSync = (command, args, options) => Array.isArray(args) && args.includes('--probe')",
  "  ? { status: 0, stdout: " +
    JSON.stringify(
      JSON.stringify({
        auth: {
          probes: {
            results: [
              { provider: "openai", model: "openai/state-migration", source: "env", status: "ok" },
            ],
          },
        },
      }),
    ) +
    " }",
  "  : realSpawnSync(command, args, options);",
].join("\n");

const NATIVE_INFERENCE_CONFIG = {
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: { source: "env", provider: "model", id: "OPENAI_API_KEY" },
        models: [
          {
            id: "state-migration",
            name: "state-migration",
            api: "openai-responses",
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  secrets: { providers: { model: { source: "env", allowlist: ["OPENAI_API_KEY"] } } },
};

// Seeds the recorded workspace node state on a volume standing in for the Agent's
// workspace claim (its workspace and node state subpaths) and runs
// WORKSPACE_NODE_UPGRADE on it with `entrypoint`.
async function upgradeWorkspaceNode(t, entrypoint, children, environment = {}) {
  const volume = await gatewayStateVolume(t, "/home/node", {
    seed: "tar -xzf /workspace-node-state.tar.gz -C /home/node",
    seedVolumes: [`${olderWorkspaceNodeState}:/workspace-node-state.tar.gz:ro`],
  });
  // Doctor's full repair pass takes about 20 s, and over a minute on a busy runner.
  const startMs = 240_000 * imageSmokeTimeoutMultiplier;
  const { stdout } = await runDocker(
    [
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--network",
      "none",
      "--tmpfs",
      "/tmp:size=64m,mode=1777",
      "--volume",
      `${volume}:/home/node`,
      "--entrypoint",
      "/usr/bin/tini",
      image,
      "-s",
      "--",
      "node",
      "-e",
      WORKSPACE_NODE_UPGRADE,
      entrypoint,
      String(startMs),
      children,
      JSON.stringify(environment),
    ],
    { timeout: 2 * startMs + 120_000 * imageSmokeTimeoutMultiplier },
  );
  return JSON.parse(stdout);
}

// The first start migrates once, then runs `phases` and starts `count` children
// matching `started`; the node keeps its identity; the second start runs no Doctor.
function assertWorkspaceNodeMigratedOnce(outcome, phases, started, count) {
  const { upgraded, current } = outcome;
  assert.equal(upgraded.status, 0, upgraded.output);
  assert.match(upgraded.output, /from schema 20 to \d+ with openclaw doctor --fix/);
  for (const phase of ["state-migration", ...phases]) {
    assert.deepEqual(
      jsonLogEntries(upgraded.output)
        .filter((entry) => entry.event === "runtime.startup_phase" && entry.phase === phase)
        .map(({ outcome }) => outcome),
      ["ok"],
      upgraded.output,
    );
  }
  assert.equal(upgraded.output.match(started)?.length, count, upgraded.output);
  assert.doesNotMatch(upgraded.output, /migration custody|PRIVATE KEY/);
  assert.equal(
    outcome.migrated,
    OPENCLAW_STATE_DATABASE_SCHEMA_VERSION,
    "Doctor migrated to another schema: update OPENCLAW_STATE_DATABASE_SCHEMA_VERSION with the OpenClaw pin.",
  );
  // The node keeps the identity its Gateway paired, and Doctor kept the older
  // database, identity included, beside the migrated one. Doctor also keeps a
  // table-scoped snapshot for the credential move (*.scoped.bak).
  assert.equal(outcome.identityStatus, 0);
  assert.equal(outcome.deviceId, outcome.savedDeviceId);
  assert.deepEqual(
    outcome.backups
      .filter(({ name }) => !name.endsWith(".scoped.bak"))
      .map(({ version, deviceId }) => ({ version, deviceId })),
    [{ version: 20, deviceId: outcome.savedDeviceId }],
    JSON.stringify(outcome.backups),
  );
  // Current state starts without Doctor.
  assert.equal(current.status, 0, current.output);
  assert.doesNotMatch(current.output, /openclaw doctor --fix|"phase":"state-migration"/);
  assert.equal(current.output.match(started)?.length, count, current.output);
}

// Each case seeds its own state volume and starts its own containers: random
// volume and container names, no shared port. All run at once.
describe("runtime image released state migration", { concurrency: 4 }, () => {
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

  test(
    "runtime image migrates an older workspace node's credentials before the dedicated Harness starts",
    imageTestOptions,
    async (t) => {
      const outcome = await upgradeWorkspaceNode(t, AGENT_WITH_NODE_ENTRYPOINT, HARNESS_CHILDREN);
      // Without Doctor, native setup refuses the older client credentials
      // ("backed-up migration custody") and the Harness never starts its children.
      assertWorkspaceNodeMigratedOnce(
        outcome,
        ["workspace-baseline"],
        /HARNESS_CHILD_STARTED (node|codex)/g,
        2,
      );
    },
  );

  test(
    "runtime image migrates an older workspace node's credentials before the dedicated OpenClaw worker connects",
    imageTestOptions,
    async (t) => {
      // The worker's node state lives on the same workspace claim subpath. Without
      // Doctor, `node identity` and `connect` refuse the older client credentials.
      const outcome = await upgradeWorkspaceNode(t, NATIVE_WORKER_ENTRYPOINT, WORKER_CHILDREN, {
        TMPDIR: "/tmp/openclaw-native-worker",
        OPENCLAW_NATIVE_WORKER_CAPACITY: "8",
        OPENCLAW_NATIVE_INFERENCE_CONFIG: JSON.stringify(NATIVE_INFERENCE_CONFIG),
        OPENCLAW_HARNESS_MODEL: "openai/state-migration",
        OPENCLAW_HARNESS_PROVIDER: "openai",
        OPENCLAW_HARNESS_CREDENTIAL_ENV: "OPENAI_API_KEY",
        OPENCLAW_HARNESS_PROBE_CONFIG: JSON.stringify({
          ...NATIVE_INFERENCE_CONFIG,
          agents: { defaults: { model: "openai/state-migration" } },
        }),
        // Synthetic: the connect child receives it, and Doctor must not.
        OPENAI_API_KEY: "sk-openclaw-runtime-image-state-migration-synthetic",
      });
      assertWorkspaceNodeMigratedOnce(outcome, [], /WORKER_CHILD_STARTED connect/g, 1);
    },
  );
});
