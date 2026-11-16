// Runtime image workspace node and native worker smoke tests, split from
// runtime-image-startup-probe.test.mjs and runtime-image-startup.test.ts so CI
// can run them beside runtime-image-startup.test.ts: workspace node enrollment
// and reconnect, descendant reaping across workspace node and Codex restarts,
// and the inactive Slack approver startup check on both production launchers.
// Ephemeral native worker reconnect is in runtime-image-startup-probe.test.mjs.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cpuScaledImageTimeoutMs,
  imageSmokeTimeoutMultiplier,
} from "../helpers/image-smoke-timeout.ts";
import { assertAllPassed } from "../helpers/node-test-summary.ts";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import {
  GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
  AGENT_WITH_NODE_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  managedInstalls,
  managedMcpInstalls,
} from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { commandOutput, runDocker } from "../helpers/runtime-image-docker.ts";
import {
  openClawGatewaySpawnedRequest,
  openClawProcessRunningRequest,
} from "../helpers/runtime-image-gateway-observations.ts";
import {
  gatewayStateVolume,
  image,
  imageTestOptions,
  temporaryGatewayConfiguration,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { asRecord } from "../../packages/utils/src/objects.ts";

function slackInstall() {
  const install = managedMcpInstalls.find(({ id }) => id === "occ-plugin:slack@1.0.0");
  assert.ok(install, "The runtime image tests require the managed Slack release");
  return install;
}
const slack = slackInstall();

type ManagedPackage = Pick<typeof slack, "packageName" | "slotId"> & {
  id?: string;
  releaseSha256?: string;
} & ({ kind: "cli"; toolNames?: never } | { kind: "mcp"; toolNames?: readonly string[] });

function decodedRecord(json: string): Record<string, unknown> {
  const value = asRecord(JSON.parse(json));
  assert.ok(value, "Expected a JSON object from the runtime");
  return value;
}

function mcpServers(nodeHost: unknown) {
  return asRecord(asRecord(asRecord(nodeHost)?.mcp)?.servers);
}

function dockerStderr(error: unknown): string {
  if (!(error instanceof Error) || !("stderr" in error)) {
    return "";
  }
  return String(error.stderr ?? "");
}

function releaseVersion(version: unknown): string {
  assert.ok(typeof version === "string" && version.length > 0, "Invalid managed release version");
  return version;
}

function managedPackages(...packages: ManagedPackage[]) {
  return "OPENCLAW_MANAGED_PLUGIN_JSON=" + JSON.stringify(packages);
}

async function startGatewayWithSlack(t: TestContext, enabled: boolean, workspaceNodeId?: string) {
  const { id, releaseSha256 } = managedGoogleInstall;
  const configurationPath = await temporaryGatewayConfiguration(t, "openclaw");
  const manifest = {
    kind: "openclaw",
    selections: { [id]: { enabled }, [slack.id]: { enabled: true } },
  };
  return runGatewaySmoke(t, "openclaw", {
    configurationPath: "/etc/openclaw/openclaw.json",
    entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
    volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
    withAppServer: false,
    extraEnvironment: [
      ...(workspaceNodeId ? ["OPENCLAW_WORKSPACE_NODE_ID=" + workspaceNodeId] : []),
      "OPENCLAW_PLUGIN_RUNTIME_JSON=" + JSON.stringify({ manifest }),
      managedPackages(
        {
          kind: "cli",
          id,
          packageName: managedGoogleInstall.packageName,
          slotId: "account",
          ...(enabled && { releaseSha256 }),
        },
        {
          kind: "mcp",
          id: slack.id,
          packageName: slack.packageName,
          slotId: slack.slotId,
          releaseSha256: slack.releaseSha256,
        },
      ),
    ],
  });
}

// Run the production worker bootstrap with its packaged files and child environment. The child
// inspects the installed plugin in place of enrolling; the model probe uses a fixture.
function runManagedWorker(childArgs: string[], mounts: string[] = [], environment: string[] = []) {
  const launch = `
const cp = require("node:child_process"), realSpawn = cp.spawn;
cp.spawnSync = () => ({status:0,stdout:JSON.stringify({auth:{probes:{results:[{provider:"openai",model:"openai/test",source:"env",status:"ok"}]}}})});
cp.spawn = (command, args, options) => {
  require("node:assert/strict").deepEqual(args.slice(0, 2), ["/app/openclaw.mjs", "connect"]);
  return realSpawn(command, ${JSON.stringify(childArgs)}, options);
};
Object.assign(process.env, {
  HOME:"/tmp/home", TMPDIR:"/tmp/worker-tmp", OPENCLAW_WORKSPACE_DIR:"/tmp/workspace", OPENCLAW_NODE_STATE_DIR:"/tmp/node",
  OPENCLAW_NODE_SETUP_CODE:"fixture", OPENCLAW_NATIVE_WORKER_CAPACITY:"1", OPENCLAW_NATIVE_INFERENCE_CONFIG:"{}",
  OPENCLAW_HARNESS_MODEL:"openai/test", OPENCLAW_HARNESS_PROVIDER:"openai", OPENCLAW_HARNESS_CREDENTIAL_ENV:"TEST_MODEL_KEY",
  TEST_MODEL_KEY:"fixture", OPENCLAW_HARNESS_PROBE_CONFIG:'{"agents":{"defaults":{"model":"openai/test"}}}'
});
${NATIVE_WORKER_ENTRYPOINT}`;
  return runDocker(
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--tmpfs",
      "/tmp:mode=1777",
      ...mounts,
      ...environment.flatMap((entry) => ["--env", entry]),
      "--entrypoint",
      "node",
      image,
      // The default OpenShell policy permits image reads under /usr and /app. Exercise
      // the bootstrap with those roots plus its writable fixture home under /tmp.
      "--permission",
      "--allow-fs-read=/usr",
      "--allow-fs-read=/app",
      "--allow-fs-read=/tmp",
      "--allow-fs-write=/tmp",
      "--allow-child-process",
      "-",
    ],
    {},
    launch,
  );
}

async function workerPackageDirectory(t: TestContext, prefix: string) {
  const directory = await temporaryDirectory(t, prefix);
  // The image's non-root worker may have a different UID from the fixture owner.
  await chmod(directory, 0o755);
  return directory;
}

// Each case uses a private container and run-owned fixtures. Two run at a time.
describe("runtime image native worker", { concurrency: 2 }, () => {
  test(
    "the dedicated worker launches the pinned gog on PATH only for the selected release",
    imageTestOptions,
    async () => {
      const releaseFile = new URL(
        "../../apps/controller/plugins/oce-google-workspace/ai.openclaw.oce/release.json",
        import.meta.url,
      );
      const version = releaseVersion(decodedRecord(await readFile(releaseFile, "utf8")).version);
      const expected = managedGoogleInstall.releaseSha256;
      // Exercise the production worker bootstrap in the real image. Substitute its model probe and
      // enrollment peer; the child resolves and executes the installed binary with the actual launch env.
      const probe = `const r = require("node:child_process").spawnSync("gog", ["--version"], {encoding:"utf8"});
console.log(JSON.stringify({...(r.error ? {code:r.error.code} : {version:r.stdout.trim().split(" ")[0]}), markerVisible:process.env.GOG_ACCESS_TOKEN===undefined?undefined:"present"}));
process.exit(r.error ? 0 : r.status);`;
      const worker = (digest?: string, mounts: string[] = [], environment: string[] = []) =>
        runManagedWorker(["-e", probe], mounts, [
          ...environment,
          ...(digest === undefined
            ? []
            : [
                "OPENCLAW_MANAGED_PLUGIN_JSON=" +
                  JSON.stringify({
                    kind: "cli",
                    packageName: managedGoogleInstall.packageName,
                    slotId: "account",
                    releaseSha256: digest,
                  } satisfies ManagedPackage),
              ]),
        ]);
      const marker =
        "GOG_ACCESS_TOKEN=openshell:resolve:env:s" + "a".repeat(64) + "_GOG_ACCESS_TOKEN";
      assert.deepEqual(decodedRecord((await worker(undefined, [], [marker])).stdout.trim()), {
        code: "ENOENT",
        markerVisible: "present",
      });
      assert.deepEqual(decodedRecord((await worker(expected)).stdout.trim()), {
        version: "v" + version,
      });
      const bound = "OPENCLAW_MANAGED_CREDENTIAL_ENV=GOG_ACCESS_TOKEN";
      assert.deepEqual(decodedRecord((await worker(expected, [], [marker])).stdout), {
        version: "v" + version,
        markerVisible: "present",
      });
      assert.deepEqual(decodedRecord((await worker(expected, [], [bound])).stdout), {
        version: "v" + version,
      });
      assert.deepEqual(
        decodedRecord((await worker(expected, [], ["GOG_ACCESS_TOKEN=raw"])).stdout),
        {
          version: "v" + version,
        },
      );
      assert.deepEqual(decodedRecord((await worker(expected, [], [bound, marker])).stdout), {
        version: "v" + version,
        markerVisible: "present",
      });
      await assert.rejects(
        worker(expected, [], [bound, "GOG_ACCESS_TOKEN=not-an-issued-placeholder"]),
        (error) => /requires its issued credential placeholder/.test(dockerStderr(error)),
      );
      await assert.rejects(worker("0".repeat(64)), (error) =>
        /image integrity check: \/usr\/local\/lib\/oce\/plugin-catalog\/oce-google-workspace\/ai\.openclaw\.oce\/release\.json/.test(
          dockerStderr(error),
        ),
      );
      await assert.rejects(
        worker(expected, [
          "-v",
          fileURLToPath(releaseFile) + ":/usr/local/lib/oce/plugins/google/bin/gog:ro",
        ]),
        (error) =>
          /image integrity check: \/usr\/local\/lib\/oce\/plugins\/google\/bin\/gog/.test(
            dockerStderr(error),
          ),
      );
    },
  );

  test(
    "the dedicated worker loads a different CLI package with its declared credential slot",
    imageTestOptions,
    async (t) => {
      const directory = await workerPackageDirectory(t, "oce-managed-cli-");
      await mkdir(join(directory, "ai.openclaw.oce"));
      const releaseMetadata = managedGoogleInstall.release;
      const version = releaseVersion(releaseMetadata?.version);
      const artifacts = asRecord(releaseMetadata?.artifacts);
      assert.ok(artifacts, "Missing managed Google release artifacts");
      const runtimeDirectory = "/usr/local/lib/oce/plugins/documents";
      const executable = "documents";
      await mkdir(join(directory, "bin"));
      // Use the pinned executable bytes under a different command name and installation
      // path. A bootstrap that hardcodes Google's location must not satisfy this case.
      const source = (
        await runDocker(["create", "--network", "none", "--entrypoint", "true", image])
      ).stdout.trim();
      try {
        await runDocker([
          "cp",
          source + ":" + managedGoogleInstall.binaryPath,
          join(directory, "bin", executable),
        ]);
      } finally {
        await runDocker(["rm", "-f", source]);
      }
      const release = JSON.stringify({
        capabilities: { gateway: [], harness: ["cli"] },
        runtimeDirectory,
        executable,
        version,
        artifacts,
        credentials: {
          workspace: {
            delivery: { role: "harness", env: "DOCUMENTS_ACCESS_TOKEN", presentation: "bearer" },
          },
        },
      });
      await writeFile(join(directory, "ai.openclaw.oce/release.json"), release);
      const settings =
        "OPENCLAW_MANAGED_PLUGIN_JSON=" +
        JSON.stringify({
          kind: "cli",
          packageName: "oce-documents-cli",
          slotId: "workspace",
          releaseSha256: createHash("sha256").update(release).digest("hex"),
        } satisfies ManagedPackage);
      const marker = "openshell:resolve:env:s" + "b".repeat(64) + "_DOCUMENTS_ACCESS_TOKEN";
      const result = await runManagedWorker(
        [
          "-e",
          `const r = require("node:child_process").spawnSync("documents", ["--version"], {encoding:"utf8"});
console.log(JSON.stringify({version:r.stdout.trim().split(" ")[0], marker:process.env.DOCUMENTS_ACCESS_TOKEN}));
process.exit(r.status);`,
        ],
        [
          "-v",
          directory + ":/usr/local/lib/oce/plugin-catalog/oce-documents-cli:ro",
          "-v",
          directory + ":" + runtimeDirectory + ":ro",
        ],
        [
          settings,
          "OPENCLAW_MANAGED_CREDENTIAL_ENV=DOCUMENTS_ACCESS_TOKEN",
          "DOCUMENTS_ACCESS_TOKEN=" + marker,
        ],
      );
      assert.deepEqual(decodedRecord(result.stdout), { version: "v" + version, marker });
    },
  );

  test(
    "the dedicated worker configures Slack's hosted MCP server only for the selected release",
    imageTestOptions,
    async (t) => {
      // Keep the node state across both revisions and mark it so a wholesale reset cannot
      // masquerade as a successful removal. Inspect the generated config with the native CLI.
      const volume = await gatewayStateVolume(t, "/tmp/node", {
        seed: "echo retained > /tmp/node/enrollment-sentinel",
      });
      const { packageName, slotId, releaseSha256 } = slack;
      const google: ManagedPackage = {
        kind: "cli",
        packageName: managedGoogleInstall.packageName,
        slotId: "account",
        releaseSha256: managedGoogleInstall.releaseSha256,
      };
      const settings = (digest?: string, toolNames?: string[]) =>
        digest === undefined
          ? managedPackages(google)
          : managedPackages(google, {
              kind: "mcp",
              packageName,
              slotId,
              releaseSha256: digest,
              ...(toolNames === undefined ? {} : { toolNames }),
            });
      const inspect = async (digest?: string, mounts: string[] = [], toolNames?: string[]) => {
        const result = await runManagedWorker(
          ["/app/openclaw.mjs", "config", "get", "nodeHost", "--json"],
          ["-v", volume + ":/tmp/node", ...mounts],
          [settings(digest, toolNames)],
        );
        return mcpServers(decodedRecord(result.stdout));
      };
      const selected = asRecord((await inspect(releaseSha256))?.oce_mcp_slack);
      assert.deepEqual(selected, {
        enabled: false,
        transport: "streamable-http",
        url: "https://mcp.slack.com/mcp",
      });
      const tools = ["slack_search_public"];
      // Execute the Google CLI in the same child that reads the worker's Slack MCP configuration.
      const probe = `
require("node:child_process").execFileSync("gog", ["--version"]);
console.log(require("node:fs").readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
`;
      for (const marker of [
        "openshell:resolve:env:v7_SLACK_MCP_TOKEN",
        "openshell:resolve:env:s" + "a".repeat(64) + "_SLACK_MCP_TOKEN",
      ]) {
        const connected = await runManagedWorker(
          ["-e", probe],
          ["-v", volume + ":/tmp/node"],
          [settings(releaseSha256, tools), "SLACK_MCP_TOKEN=" + marker],
        );
        assert.deepEqual(mcpServers(decodedRecord(connected.stdout).nodeHost)?.oce_mcp_slack, {
          ...selected,
          enabled: true,
          headers: { Authorization: "Bearer " + marker },
          toolFilter: { include: ["slack_search_public"] },
        });
      }
      const withdrawn = await inspect(releaseSha256, [], tools);
      assert.deepEqual(withdrawn?.oce_mcp_slack, selected);
      const deselected = await inspect(undefined);
      assert.equal(deselected?.oce_mcp_slack, undefined);
      const sentinel = await runDocker([
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        volume + ":/tmp/node:ro",
        "--entrypoint",
        "cat",
        image,
        "/tmp/node/enrollment-sentinel",
      ]);
      assert.equal(sentinel.stdout.trim(), "retained");
      const mcpPath = "/usr/local/lib/oce/plugin-catalog/oce-slack/mcp.json";
      const replacement = fileURLToPath(
        new URL("../../apps/controller/plugins/oce-slack/plugin.json", import.meta.url),
      );
      await assert.rejects(
        inspect(releaseSha256, ["-v", replacement + ":" + mcpPath + ":ro"]),
        (error) => dockerStderr(error).includes("image integrity check: " + mcpPath),
      );
    },
  );

  test(
    "the dedicated worker configures two MCP servers with their own credentials and tool selections",
    imageTestOptions,
    async (t) => {
      const directory = await workerPackageDirectory(t, "oce-managed-mcp-");
      await mkdir(join(directory, "ai.openclaw.oce"));
      const url = "https://documents.example.test/services/mcp";
      const manifest = JSON.stringify({
        mcpServers: { documents: { type: "streamable-http", url } },
      });
      const digest = (content: string) => createHash("sha256").update(content).digest("hex");
      const release = JSON.stringify({
        capabilities: { gateway: [], harness: ["mcp"] },
        mcpServersSha256: digest(manifest),
        credentials: {
          workspace: {
            delivery: { role: "harness", env: "DOCUMENTS_ACCESS_TOKEN", presentation: "bearer" },
            mcp: { server: "documents" },
          },
        },
      });
      await writeFile(join(directory, "mcp.json"), manifest);
      await writeFile(join(directory, "ai.openclaw.oce/release.json"), release);
      const marker = "openshell:resolve:env:v9_DOCUMENTS_ACCESS_TOKEN";
      const slackMarker = "openshell:resolve:env:v19_SLACK_MCP_TOKEN";
      const run = (toolNames: string[]) =>
        runManagedWorker(
          [
            "-e",
            "console.log(require('node:fs').readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'))",
          ],
          ["-v", directory + ":/usr/local/lib/oce/plugin-catalog/oce-documents:ro"],
          [
            managedPackages(
              {
                kind: "mcp",
                packageName: slack.packageName,
                slotId: slack.slotId,
                releaseSha256: slack.releaseSha256,
                toolNames: ["slack_search_public"],
              },
              {
                kind: "mcp",
                packageName: "oce-documents",
                slotId: "workspace",
                releaseSha256: digest(release),
                toolNames,
              },
            ),
            "SLACK_MCP_TOKEN=" + slackMarker,
            "DOCUMENTS_ACCESS_TOKEN=" + marker,
          ],
        );
      const configured = await run(["ListItems"]);
      assert.deepEqual(mcpServers(decodedRecord(configured.stdout).nodeHost), {
        oce_mcp_slack: {
          enabled: true,
          transport: "streamable-http",
          url: "https://mcp.slack.com/mcp",
          headers: { Authorization: "Bearer " + slackMarker },
          toolFilter: { include: ["slack_search_public"] },
        },
        oce_mcp_documents: {
          enabled: true,
          transport: "streamable-http",
          url,
          headers: { Authorization: "Bearer " + marker },
          toolFilter: { include: ["ListItems"] },
        },
      });
      const updated = await run(["UpdateItem", "ListItems"]);
      assert.deepEqual(
        asRecord(mcpServers(decodedRecord(updated.stdout).nodeHost)?.oce_mcp_documents)?.toolFilter,
        {
          include: ["UpdateItem", "ListItems"],
        },
      );
      await assert.rejects(run(["List*"]), (error) =>
        dockerStderr(error).includes("The selected MCP tools must have distinct literal names"),
      );
    },
  );

  test(
    "the native Gateway discovers the Google instructions with Slack selected alongside it",
    imageTestOptions,
    async (t) => {
      const { containerName } = await startGatewayWithSlack(t, true);
      const { stdout } = await runDocker([
        "exec",
        "-e",
        "OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json",
        containerName,
        "node",
        "/app/openclaw.mjs",
        "skills",
        "info",
        "oce-google",
        "--json",
      ]);
      assert.equal(
        decodedRecord(stdout).filePath,
        "/usr/local/lib/oce/plugin-catalog/oce-google-workspace/skills/oce-google/SKILL.md",
      );
    },
  );

  test(
    "the node skill policy admits only the selected Google instructions",
    imageTestOptions,
    async (t) => {
      const probe = await readFile(
        new URL("../fixtures/runtime-google-skill-policy.mts", import.meta.url),
        "utf8",
      );
      for (const enabled of [false, true]) {
        const { containerName } = await startGatewayWithSlack(t, enabled, "a".repeat(64));
        await runDocker(
          [
            "exec",
            "-i",
            containerName,
            "node",
            "--input-type=module-typescript",
            "-",
            String(enabled),
          ],
          {},
          probe,
        );
      }
    },
  );

  test(
    "runtime image recovers a lost workspace node hello and reconnects with saved credentials",
    imageTestOptions,
    async (t) => {
      // The Kubernetes entrypoint admits the workspace command grant before pairing.
      const configurationPath = await temporaryGatewayConfiguration(t, "codex");
      const { containerName } = await runGatewaySmoke(t, "codex", {
        configurationPath: "/etc/openclaw/openclaw.json",
        entrypoint: KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
        volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
      });
      const source = await readFile(
        new URL("../fixtures/runtime-workspace-node.ts", import.meta.url),
        "utf8",
      );
      // Only the unrelated Codex sibling is inert. Native setup, the node, Gateway,
      // and the production supervisor execute their real logic; the fixture's
      // transport proxy drops one credential-bearing hello before node delivery.
      const supervisor = `
const cp = require("node:child_process");
const originalSpawn = cp.spawn;
cp.spawn = (command, args, options) => originalSpawn(command,
  args[0] === "-e" ? ["-e", "setInterval(() => {}, 1000)"] : args, options);
${AGENT_WITH_NODE_ENTRYPOINT}`;
      await runDocker(
        [
          "exec",
          "-i",
          containerName,
          "node",
          "-e",
          'const fs = require("node:fs"); const files = JSON.parse(fs.readFileSync(0, "utf8")); for (const [name, content] of Object.entries(files)) fs.writeFileSync(name, content);',
        ],
        {},
        JSON.stringify({
          "/tmp/workspace-node-supervisor.cjs": supervisor,
          "/tmp/runtime-workspace-node.ts": source,
        }),
      );
      // The fixture bounds every CLI call and wait by one deadline 10 s inside this
      // exec timeout, so a hung call fails with its own name.
      const execTimeoutMs = 360_000 * imageSmokeTimeoutMultiplier;
      const { stdout } = await runDocker(
        [
          "exec",
          "-e",
          `WORKSPACE_PROOF_BUDGET_MS=${execTimeoutMs - 10_000}`,
          containerName,
          "node",
          "/tmp/runtime-workspace-node.ts",
        ],
        { timeout: execTimeoutMs },
      );
      const result = decodedRecord(stdout);
      assert.equal(result.sameIdentityAfterRestart, true);
      assert.equal(result.sameIdentityAfterReplacementSetup, true);
      assert.equal(result.stableCompletionPerSetup, true);
      assert.equal(result.lostHelloConfirmedWithoutSavedToken, true);
      assert.equal(result.consumedSetupRetryRejected, true);
      assert.equal(result.sameIdentityAfterPairingRecovery, true);
      assert.equal(result.possessionEstablishedAfterRecovery, true);
      assert.equal(result.sameTokenAfterRedeploy, true);
      assert.equal(result.possessionClearedOnRetirementAndReplacement, true);
      assert.ok(Array.isArray(result.commands));
      assert.ok(result.commands.every((command: unknown) => typeof command === "string"));
      assert.equal(result.commands.length, 7);
      assert.ok(typeof result.slowestCallMs === "number" && Number.isFinite(result.slowestCallMs));
      t.diagnostic(`slowest gateway call: ${result.slowestCallMs} ms`);
    },
  );

  test(
    "runtime image reaps descendants during workspace node and Codex restarts",
    imageTestOptions,
    async (t) => {
      const containerName = `oce-runtime-image-supervisor-${randomBytes(6).toString("hex")}`;
      t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));
      // Run the same process proof inside the image, using the production init
      // command. Copy source over argv so this also works with a remote Docker engine.
      const paths = [
        "tests/conformance/workspace-node-supervisor.test.ts",
        "tests/conformance/workspace-node-supervisor-fixture.ts",
        "tests/conformance/workspace-node-supervisor-hook-cases.ts",
        "tests/conformance/workspace-node-supervisor-native-cases.ts",
        "tests/conformance/workspace-node-supervisor-setup-cases.ts",
        "packages/utils/src/objects.ts",
        "packages/utils/src/validation.ts",
        "tests/helpers/available-port.ts",
        "tests/helpers/reuse-port-preload.ts",
        "apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
        "apps/controller/src/drivers/repo/github/public-read/runtime-source.ts",
        "apps/controller/src/drivers/repo/github/public-read/transport.mjs",
        "apps/controller/src/drivers/compute/kubernetes/codex-plugin-stdio.ts",
        "apps/controller/plugins/marketplace.json",
        ...managedInstalls.map(
          ({ packageName }) =>
            `apps/controller/plugins/${packageName}/ai.openclaw.oce/release.json`,
        ),
        "apps/controller/src/drivers/compute/embedded-gateway-owner.ts",
        "apps/controller/src/drivers/compute/gateway-tool-policy.ts",
        "apps/controller/src/drivers/compute/harness-egress-enrollment.ts",
        "apps/controller/src/drivers/compute/node-program.ts",
        "apps/controller/src/drivers/compute/openclaw-config-issues.ts",
        "apps/controller/src/drivers/compute/runtime-startup.ts",
        "apps/controller/src/drivers/plugin/runtime-translator.ts",
        "apps/controller/src/drivers/sandbox/openshell-plugin-runtime.ts",
        "packages/contracts/src/runtime-failure.ts",
        "tests/conformance/workspace-node-supervisor-cases.ts",
      ];
      const files = await Promise.all(
        paths.map(async (path) => [
          path,
          await readFile(new URL(`../../${path}`, import.meta.url), "utf8"),
        ]),
      );
      const launch = await readFile(
        new URL("../fixtures/runtime-native-supervisor-proof.mts", import.meta.url),
        "utf8",
      );
      const { stdout } = await runDocker(
        [
          "run",
          "-i",
          "--rm",
          "--name",
          containerName,
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
          "--entrypoint",
          "/usr/bin/tini",
          image,
          "-s",
          "--",
          "node",
          "--input-type=module-typescript",
          "-e",
          launch,
        ],
        // The sequential suite's per-case deadlines total 313 seconds. Keep them
        // intact and allow container startup/reporting beyond that combined budget.
        { timeout: 360_000 * imageSmokeTimeoutMultiplier },
        JSON.stringify(files),
      ).catch((error: unknown) => {
        // CI truncates the error message and drops the command output, so name the
        // in-image proof that failed first (main run 37424312731 lost it).
        assert.ok(error instanceof Error);
        const report = commandOutput(error);
        const failing = report.indexOf("failing tests:");
        const summary =
          failing !== -1
            ? report.slice(failing, failing + 2_000)
            : report.trim() !== ""
              ? report.slice(-2_000)
              : error.message;
        const signal =
          "signal" in error && typeof error.signal === "string" ? error.signal : "a signal";
        const stopped = "killed" in error && error.killed === true ? ` (killed by ${signal})` : "";
        throw new Error(`The in-image supervisor proof failed${stopped}: ${summary}`, {
          cause: error,
        });
      });
      // Every supervisor proof in the file must pass in the image. The check reads
      // the run's own totals, so adding a proof needs no change here. The floor is
      // the 7 proofs the file had when the count stopped being hard-coded
      // (finding 1032); lower it only when a proof is removed on purpose.
      const summary = assertAllPassed(stdout, { minimum: 7 });
      t.diagnostic("In-image supervisor cases passed: " + summary.pass);
    },
  );

  test(
    "runtime image omits inactive Slack approvers and checks native compatibility before gateway launch",
    imageTestOptions,
    async (t) => {
      const containerName = `oce-runtime-image-approvers-${randomBytes(6).toString("hex")}`;
      t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));
      // Exercise both production launchers against the selected native image. No
      // model or Slack credentials are provided, and the container has no network.
      const source = await readFile(
        new URL("../fixtures/runtime-native-approver-proof.mts", import.meta.url),
        "utf8",
      );
      const launch = source
        .replace('"GATEWAY_SPAWNED_PROBE"', () => JSON.stringify(openClawGatewaySpawnedRequest))
        .replace('"OPENCLAW_RUNNING_PROBE"', () => JSON.stringify(openClawProcessRunningRequest));
      // The waits scale with the runner's CPUs: the lane's other files start runtimes
      // at the same time, so a slow start under that load is not a failure. A start
      // that never reports its outcome still fails within startupMs. The container
      // reads the schema once, then starts six runtimes one after another (two
      // launchers, Slack absent, disabled and configured; only configured runs to
      // /healthz): its limit is their sum plus a minute to create and remove the
      // container.
      const schemaMs = cpuScaledImageTimeoutMs(30_000);
      const startupMs = cpuScaledImageTimeoutMs(45_000);
      const { stdout } = await runDocker(
        [
          "run",
          "-i",
          "--rm",
          "--name",
          containerName,
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--entrypoint",
          "node",
          image,
          "--input-type=module-typescript",
          "-e",
          launch,
        ],
        { timeout: schemaMs + 6 * startupMs + 60_000 * imageSmokeTimeoutMultiplier },
        JSON.stringify({
          entrypoints: {
            docker: nodeProgramArguments(DOCKER_GATEWAY_RUNTIME_ENTRYPOINT),
            kubernetes: nodeProgramArguments(KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT),
          },
          schemaMs,
          startupMs,
        }),
      );
      assert.match(stdout, /PLUGIN_APPROVER_STARTUP_PASSED/);
    },
  );
});
