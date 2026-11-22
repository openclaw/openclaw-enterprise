// Runtime image agent database migration smoke tests, split from
// runtime-image-startup.test.ts so CI can run them beside it: a Gateway started
// on the released state migrates its agent database once with Doctor, through
// both the Kubernetes and the Docker development entrypoints.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  EMBEDDED_GATEWAY_OWNER_STARTUP,
  GATEWAY_NAMESPACE_PROBE,
  INITIALIZE_EMBEDDED_GATEWAY_OWNER,
  type GatewayPidNamespace,
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
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import { jsonLogEntries } from "../helpers/runtime-image-gateway-observations.ts";
import {
  image,
  imageTestOptions,
  gatewayStateVolume,
  temporaryGatewayConfiguration,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.ts";
import {
  checkNativeProfileFixture,
  nativeProfileFixtureConfiguration,
  nativeProfileUpgradeMessage,
  readNativeProfileExpected,
} from "../helpers/native-profile-state-fixture.ts";
import {
  parseObservation,
  record,
  text,
  readAgentDatabase,
  readMaintenance,
  readOwnerEnvelope,
  readOwnerStatement,
  readWorkspaceUpgrade,
} from "../fixtures/runtime-state/migration/observations.mts";

const fixtureDir = "/runtime-state-fixture";
const fixtureMount =
  fileURLToPath(new URL("../fixtures/runtime-state/migration", import.meta.url)) +
  ":" +
  fixtureDir +
  ":ro";
const maintenance = fixtureDir + "/maintenance.mts";

test(
  "runtime image retains a pre-delegation native profile and conversation after upgrade",
  imageTestOptions,
  async (t) => {
    const archive = fileURLToPath(
      new URL(
        "../fixtures/runtime-state/native-profile-state-openclaw-513c127.tar.gz",
        import.meta.url,
      ),
    );
    const metadata = parseObservation(
      await readFile(
        new URL(
          "../fixtures/runtime-state/native-profile-state-openclaw-513c127.json",
          import.meta.url,
        ),
        "utf8",
      ),
      record,
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
      text(metadata.archiveSha256),
    );
    // The old Gateway created these rows through native RPCs. Restore its
    // keyless stores and original migration bookkeeping, then use the real
    // current startup/Doctor path. Native startup regenerates removed keys.
    const volume = await gatewayStateVolume(t, "/home/node", {
      seed: "tar -xzf /native-profile-state.tar.gz -C /home/node",
      seedVolumes: [`${archive}:/native-profile-state.tar.gz:ro`],
    });
    const configuration = await temporaryGatewayConfiguration(
      t,
      "openclaw",
      nativeProfileFixtureConfiguration,
    );
    const gateway = await runGatewaySmoke(t, "openclaw", {
      configurationPath: "/etc/openclaw/openclaw.json",
      entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
      volumes: [`${volume}:/home/node`, `${configuration}:/etc/openclaw/openclaw.json:ro`],
      tmpfs: [],
      withAppServer: false,
    });
    // Preserve the old person's identity, name, session ownership and text. A
    // new admin-injected message proves the retained conversation is writable;
    // neither message is presented as model-generated content.
    await checkNativeProfileFixture(runDocker, gateway.containerName, {
      expected: readNativeProfileExpected(metadata.expected),
      appendMessage: nativeProfileUpgradeMessage,
    });
    await runDocker(["stop", "--time", "60", gateway.containerName]);
    t.diagnostic(
      `native profile upgrade: ${text(record(metadata.provenance).commit)} -> selected image; profile and conversation retained`,
    );
  },
);

test(
  "Gateway replacement retains unfinished maintenance on its database mounts",
  imageTestOptions,
  async (t) => {
    const statePath = "/home/node/.openclaw/state";
    const agentPath = "/home/node/.openclaw/agents/main/agent";
    const stateVolume = await gatewayStateVolume(t, statePath);
    const agentVolume = await gatewayStateVolume(t, agentPath);
    const volumes = [`${stateVolume}:${statePath}`, `${agentVolume}:${agentPath}`];
    const configurationPath = await temporaryGatewayConfiguration(t, "openclaw");
    // The Kubernetes wrapper, SQLite files and separate mounts are real. The
    // preload controls only the external Doctor result and final native child.
    await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "1000:1000",
      ...volumes.flatMap((volume) => ["--volume", volume]),
      "--volume",
      fixtureMount,
      "--entrypoint",
      "node",
      image,
      maintenance,
      "seed",
      String(OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION - 1),
    ]);
    for (const [index, accepted] of [false, false, true].entries()) {
      // Each new container gets a new HOME tmpfs, retaining only the two database
      // mounts. A refusal after schema advancement must still run Doctor next time.
      const { containerName } = await runGatewaySmoke(t, "openclaw", {
        configurationPath: "/etc/openclaw/openclaw.json",
        entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
        // Docker creates nested mount parents as root; Kubernetes prepares this
        // transient directory for the Gateway user before mounting PVC children.
        tmpfs: [
          "/home/node:uid=1000,gid=1000,mode=700",
          "/home/node/.openclaw:uid=1000,gid=1000,mode=700",
        ],
        volumes: [...volumes, `${configurationPath}:/etc/openclaw/openclaw.json:ro`, fixtureMount],
        extraEnvironment: [
          `NODE_OPTIONS=--require=${maintenance}`,
          `OCE_TEST_STATE_SCHEMA=${OPENCLAW_STATE_DATABASE_SCHEMA_VERSION}`,
          `OCE_TEST_AGENT_SCHEMA=${OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION}`,
          `OCE_TEST_DOCTOR_ACCEPT=${accepted ? "1" : "0"}`,
        ],
        withAppServer: false,
        waitUntilReady: false,
      });
      let logs = "";
      const deadline = Date.now() + 20_000 * imageSmokeTimeoutMultiplier;
      while (Date.now() < deadline) {
        const output = await runDocker(["logs", containerName]);
        logs = output.stdout + output.stderr;
        if (
          logs.includes("GATEWAY_CHILD_STARTED") ||
          logs.includes('"phase":"state-migration","outcome":"failed"')
        ) {
          break;
        }
        await delay(100);
      }
      assert.equal(logs.includes("GATEWAY_CHILD_STARTED"), accepted, logs);
      if (!accepted) {
        assert.match(logs, /"phase":"state-migration","outcome":"failed"/);
      }
      const snapshot = await runDocker([
        "exec",
        "--env",
        "NODE_OPTIONS=",
        containerName,
        "node",
        maintenance,
        "snapshot",
      ]);
      const current = parseObservation(snapshot.stdout, readMaintenance);
      assert.equal(current.attempts, index + 1);
      assert.equal(current.pending, !accepted);
      assert.equal(current.mode, accepted ? null : 0o600);
      await runDocker(["rm", "-f", containerName]);
    }
  },
);

test("embedded Gateway restart recovers only its signed Pod owner", imageTestOptions, async (t) => {
  const keyDir = "/run/oce-gateway-owner-key";
  const startDir = "/run/oce-gateway-owner-start";
  const keyVolume = await gatewayStateVolume(t, keyDir);
  const startVolume = await gatewayStateVolume(t, startDir);
  const pod = "85576b7d-39b1-4739-8541-366548813cd1";
  const env = { OPENCLAW_EMBEDDED_GATEWAY_OWNER: "1", OPENCLAW_STATE_DIR: "/tmp/state" };
  const run = (script: string, { uid = pod, init = false, readOnly = false } = {}) =>
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
      "--volume",
      fixtureMount,
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
  // Keep the real startup program in CommonJS, with the mounted fixture loaded
  // synchronously in the same process and PID namespace.
  const fixture = `const fixture = require("${fixtureDir}/signed-owner.mts");\n`;
  await run(INITIALIZE_EMBEDDED_GATEWAY_OWNER, { init: true });
  // The sampler cannot retire its key on a read-only startup volume. User code must not run.
  await assert.rejects(
    run(EMBEDDED_GATEWAY_OWNER_STARTUP + '\nconsole.log("started");', { readOnly: true }),
    /EROFS|read-only file system/i,
  );
  const { stdout } = await run(
    fixture + EMBEDDED_GATEWAY_OWNER_STARTUP + "\nfixture.printOwner();",
  );
  const record = parseObservation(stdout, readOwnerEnvelope);
  const prior = parseObservation(record.statement, readOwnerStatement);
  assert.equal(prior.pod, pod);

  // Each invocation is a separate private Linux PID namespace, as with a kubelet restart.
  // The lock is synthetic. The replacement runs the shipping OC CLI against it.
  const recover = (candidate: typeof record, namespace: GatewayPidNamespace, uid = pod) =>
    run(
      fixture +
        `fixture.seedLock(${JSON.stringify(JSON.stringify(candidate))}, ${JSON.stringify(JSON.stringify(namespace))});\n` +
        `console.log("observed kernels", ${JSON.stringify(namespace)}, ${GATEWAY_NAMESPACE_PROBE});\n` +
        EMBEDDED_GATEWAY_OWNER_STARTUP +
        "\nfixture.printLock();",
      { uid },
    );
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
  const statement = JSON.stringify({ ...prior, namespace: foreign });
  const { stdout: forged } = await run(
    fixture + `fixture.forgeOwner(${JSON.stringify(statement)});`,
  );
  await run(INITIALIZE_EMBEDDED_GATEWAY_OWNER, { init: true });
  await run(fixture + EMBEDDED_GATEWAY_OWNER_STARTUP + "\nfixture.assertKeyConsumed();", {
    uid: "",
  });
  assert.match(
    (await recover(parseObservation(forged, readOwnerEnvelope), foreign)).stdout,
    /lock-present=true\s*$/,
  );
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

async function agentDatabaseFacts(containerName: string) {
  const { stdout } = await runDocker([
    "exec",
    containerName,
    "node",
    fixtureDir + "/agent-database.mts",
  ]);
  return parseObservation(stdout, readAgentDatabase);
}

function stateMigrationPhases(logs: string) {
  return jsonLogEntries(logs).filter(
    (entry) => entry.event === "runtime.startup_phase" && entry.phase === "state-migration",
  );
}

// Copies the released state into a new volume for mounting at `mountPath`.
function releasedGatewayStateVolume(t: TestContext, mountPath: string) {
  return gatewayStateVolume(t, mountPath, {
    seed: "tar -xzf /released-gateway-state.tar.gz -C /home/node",
    seedVolumes: [`${releasedGatewayState}:/released-gateway-state.tar.gz:ro`],
  });
}

type GatewayStartOptions = Pick<
  NonNullable<Parameters<typeof runGatewaySmoke>[2]>,
  "readinessAttempts" | "until"
>;
type StartGateway = (options: GatewayStartOptions) => ReturnType<typeof runGatewaySmoke>;

async function assertReleasedGatewayMigratesOnce(startGateway: StartGateway) {
  // The current OpenClaw refuses this database until Doctor migrates it. Doctor's
  // full repair pass takes about 20 s here and over a minute on a busy CI runner.
  const released = await startGateway({ readinessAttempts: 240 });
  assert.ok(released.logs !== undefined, "Expected Gateway readiness logs");
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

  // A current database starts without Doctor. The launcher decides before it spawns
  // OpenClaw, and the start above already proved OpenClaw accepts the migrated
  // database, so this start ends at the spawn (about 20 CPU-seconds less).
  const current = await startGateway({ until: "spawned" });
  assert.ok(current.logs !== undefined, "Expected Gateway startup logs");
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
// both starts through its real entrypoint.
async function upgradeWorkspaceNode(
  t: TestContext,
  launcher: "harness" | "worker",
  entrypoint: string,
  environment: Readonly<Record<string, string>> = {},
) {
  const volume = await gatewayStateVolume(t, "/home/node", {
    seed: "tar -xzf /workspace-node-state.tar.gz -C /home/node",
    seedVolumes: [`${olderWorkspaceNodeState}:/workspace-node-state.tar.gz:ro`],
  });
  // OpenShell's fsGroup mount roots are root-owned and group-writable. The
  // workload owns its private children, but cannot tighten the shared ancestor.
  // Doctor must use its private temporary cache rather than HOME/.cache here.
  await runDocker([
    "run",
    "--rm",
    "--user",
    "0:0",
    "--network",
    "none",
    "--volume",
    `${volume}:/home/node`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    "chown 0:1000 /home/node && chmod 2775 /home/node",
  ]);
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
      "--volume",
      fixtureMount,
      "--entrypoint",
      "/usr/bin/tini",
      image,
      "-s",
      "--",
      "node",
      fixtureDir + "/workspace-node.mts",
      launcher,
      entrypoint,
      String(startMs),
      JSON.stringify(environment),
    ],
    { timeout: 2 * startMs + 120_000 * imageSmokeTimeoutMultiplier },
  );
  return parseObservation(stdout, readWorkspaceUpgrade);
}

// The first start migrates once, then runs `phases` and starts `count` children
// matching `started`; the node keeps its identity; the second start runs no Doctor.
function assertWorkspaceNodeMigratedOnce(
  outcome: ReturnType<typeof readWorkspaceUpgrade>,
  phases: readonly string[],
  started: RegExp,
  count: number,
) {
  const { upgraded, current } = outcome;
  assert.deepEqual(outcome.ancestor, { uid: 0, mode: 0o2775 });
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
      await assertReleasedGatewayMigratesOnce((options) =>
        runGatewaySmoke(t, "openclaw", {
          configurationPath: "/etc/openclaw/openclaw.json",
          entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
          ...options,
          tmpfs: [],
          volumes: [
            `${configurationPath}:/etc/openclaw/openclaw.json:ro`,
            `${volume}:/home/node`,
            fixtureMount,
          ],
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
      await assertReleasedGatewayMigratesOnce((options) =>
        runGatewaySmoke(t, "openclaw", {
          ...options,
          volumes: [`${volume}:/home/node/.openclaw`, fixtureMount],
          withAppServer: false,
        }),
      );
    },
  );

  test(
    "runtime image migrates an older workspace node's credentials before the dedicated Harness starts",
    imageTestOptions,
    async (t) => {
      const outcome = await upgradeWorkspaceNode(t, "harness", AGENT_WITH_NODE_ENTRYPOINT);
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
      const outcome = await upgradeWorkspaceNode(t, "worker", NATIVE_WORKER_ENTRYPOINT, {
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
