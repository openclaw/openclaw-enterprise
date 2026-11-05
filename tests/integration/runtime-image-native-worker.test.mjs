// Runtime image workspace node and native worker smoke tests, split from
// runtime-image-startup-probe.test.mjs and runtime-image-startup.test.mjs so CI
// can run them beside runtime-image-startup.test.mjs: workspace node enrollment
// and reconnect, descendant reaping across workspace node and Codex restarts,
// and the inactive Slack approver startup check on both production launchers.
// Ephemeral native worker reconnect is in runtime-image-startup-probe.test.mjs.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cpuScaledImageTimeoutMs,
  imageSmokeTimeoutMultiplier,
} from "../helpers/image-smoke-timeout.mjs";
import { assertAllPassed } from "../helpers/node-test-summary.ts";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import {
  GATEWAY_RUNTIME_ENTRYPOINT as KUBERNETES_GATEWAY_RUNTIME_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  managedInstalls,
  managedMcpInstalls,
  managedCredentialEnvironment,
} from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  commandOutput,
  gatewayStateVolume,
  image,
  imageTestOptions,
  openClawGatewaySpawnedRequest,
  openClawProcessRunningRequest,
  runDocker,
  temporaryGatewayConfiguration,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const slack = managedMcpInstalls.find(({ id }) => id === "occ-plugin:slack@1.0.0");

function slackAccount(id, name) {
  return { id, name, env: managedCredentialEnvironment(slack, id) };
}

function managedPackages(...packages) {
  return "OPENCLAW_MANAGED_PLUGIN_JSON=" + JSON.stringify(packages);
}

async function startGatewayWithSlack(
  t,
  enabled,
  workspaceNodeId,
  accounts = [],
  googleAccounts = [],
) {
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
          ...(enabled && { releaseSha256, accounts: googleAccounts }),
        },
        {
          kind: "mcp",
          id: slack.id,
          packageName: slack.packageName,
          slotId: slack.slotId,
          releaseSha256: slack.releaseSha256,
          accounts,
        },
      ),
    ],
  });
}

// Run the production worker bootstrap with its packaged files and child environment. The child
// inspects the installed plugin in place of enrolling; the model probe uses a fixture.
function runManagedWorker(childArgs, mounts = [], environment = []) {
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

async function workerPackageDirectory(t, prefix) {
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
      const { version } = JSON.parse(await readFile(releaseFile, "utf8"));
      const expected = managedGoogleInstall.releaseSha256;
      // Exercise the production worker bootstrap in the real image. Substitute its model probe and
      // enrollment peer; the child resolves and executes the installed binary with the actual launch env.
      const probe = `const r = require("node:child_process").spawnSync("gog", ["--version"], {encoding:"utf8"});
console.log(JSON.stringify({...(r.error ? {code:r.error.code} : {version:r.stdout.trim().split(" ")[0]}), baseEnv:process.env.GOG_ACCESS_TOKEN === undefined ? undefined : "present"}));
process.exit(r.error ? 0 : r.status);`;
      const west = {
        id: "cs_west",
        env: managedCredentialEnvironment(managedGoogleInstall, "cs_west"),
      };
      const east = {
        id: "cs_east",
        env: managedCredentialEnvironment(managedGoogleInstall, "cs_east"),
      };
      const withdrawn = {
        id: "cs_gone",
        env: managedCredentialEnvironment(managedGoogleInstall, "cs_gone"),
      };
      const marker = (binding, scope) =>
        "openshell:resolve:env:s" + scope.repeat(64) + "_" + binding.env;
      const worker = (
        digest,
        mounts = [],
        environment = [],
        accounts = [],
        childArgs = ["-e", probe],
      ) =>
        runManagedWorker(childArgs, mounts, [
          ...environment,
          ...(digest === undefined
            ? []
            : [
                managedPackages({
                  kind: "cli",
                  packageName: managedGoogleInstall.packageName,
                  slotId: "account",
                  releaseSha256: digest,
                  accounts,
                }),
              ]),
        ]);
      assert.deepEqual(JSON.parse((await worker(undefined, [], ["GOG_ACCESS_TOKEN=raw"])).stdout), {
        code: "ENOENT",
      });
      assert.deepEqual(JSON.parse((await worker(expected)).stdout), { version: "v" + version });
      const westMarker = marker(west, "a");
      const eastMarker = marker(east, "b");
      // An independent bearer client can consume the one scoped marker supplied by the Sandbox.
      assert.deepEqual(
        JSON.parse(
          (
            await worker(
              undefined,
              [],
              [west.env + "=" + westMarker, "GOG_ACCESS_TOKEN=" + westMarker],
            )
          ).stdout,
        ),
        { code: "ENOENT", baseEnv: "present" },
      );
      const probePath = fileURLToPath(
        new URL("../fixtures/runtime-google-account-calls.mjs", import.meta.url),
      );
      const mounts = [
        "--add-host",
        "gmail.googleapis.com:127.0.0.1",
        "--add-host",
        "www.googleapis.com:127.0.0.1",
        "--sysctl",
        "net.ipv4.ip_unprivileged_port_start=0",
        "-v",
        probePath + ":/tmp/google-account-calls.mjs:ro",
      ];
      const capture = (bindings, environment, expectedCalls) =>
        worker(expected, mounts, environment, bindings, [
          "/tmp/google-account-calls.mjs",
          JSON.stringify(
            expectedCalls.map(({ args, marker }) => ({
              args,
              bearerHash:
                marker &&
                createHash("sha256")
                  .update("Bearer " + marker)
                  .digest("hex"),
            })),
          ),
        ]);
      await capture([west], [west.env + "=" + westMarker], [{ args: [], marker: westMarker }]);
      // Both selected identities and all local denials use the same pinned binary and TLS endpoint.
      await capture(
        [west, east, withdrawn],
        [west.env + "=" + westMarker, east.env + "=" + eastMarker],
        [
          { args: ["--oce-account", east.id], marker: eastMarker },
          { args: ["--oce-account", west.id], marker: westMarker },
          { args: [] },
          { args: ["--oce-account", "cs_unknown"] },
          { args: ["--oce-account", withdrawn.id] },
          { args: ["--oce-account", west.id, "--access-token=controlled-test-override"] },
        ],
      );
      await assert.rejects(worker(expected, [], [west.env + "=raw"], [west]), (error) =>
        /requires its issued credential placeholder/.test(error.stderr),
      );
      await assert.rejects(worker("0".repeat(64)), (error) =>
        /image integrity check: \/usr\/local\/lib\/oce\/plugin-catalog\/oce-google-workspace\/ai\.openclaw\.oce\/release\.json/.test(
          error.stderr,
        ),
      );
      await assert.rejects(
        worker(expected, [
          "-v",
          fileURLToPath(releaseFile) + ":/usr/local/lib/oce/plugins/google/bin/gog:ro",
        ]),
        (error) =>
          /image integrity check: \/usr\/local\/lib\/oce\/plugins\/google\/bin\/gog/.test(
            error.stderr,
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
      const { version, artifacts } = managedGoogleInstall.release;
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
      await mkdir(join(directory, "account-bin"));
      const command = join(directory, "account-bin", executable);
      await copyFile(
        new URL("../../deploy/runtime/managed-plugin-cli.mjs", import.meta.url),
        command,
      );
      await chmod(command, 0o555);
      const account = { id: "cs_documents", env: "DOCUMENTS_ACCESS_TOKEN_TEST" };
      const settings =
        "OPENCLAW_MANAGED_PLUGIN_JSON=" +
        JSON.stringify({
          kind: "cli",
          packageName: "oce-documents-cli",
          slotId: "workspace",
          accounts: [account],
          releaseSha256: createHash("sha256").update(release).digest("hex"),
        });
      const marker = "openshell:resolve:env:s" + "b".repeat(64) + "_" + account.env;
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
        [settings, account.env + "=" + marker],
      );
      assert.deepEqual(JSON.parse(result.stdout), { version: "v" + version });
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
      const google = {
        kind: "cli",
        packageName: managedGoogleInstall.packageName,
        slotId: "account",
        releaseSha256: managedGoogleInstall.releaseSha256,
      };
      const work = slackAccount("cs_work", "Work");
      const personal = slackAccount("cs_personal", "Personal");
      const settings = (digest, toolNames, accounts = [work]) =>
        digest === undefined
          ? managedPackages(google)
          : managedPackages(google, {
              kind: "mcp",
              packageName,
              slotId,
              releaseSha256: digest,
              toolNames,
              accounts,
            });
      const inspect = async (digest, mounts = [], toolNames) => {
        const result = await runManagedWorker(
          ["/app/openclaw.mjs", "config", "get", "nodeHost", "--json"],
          ["-v", volume + ":/tmp/node", ...mounts],
          [settings(digest, toolNames)],
        );
        return JSON.parse(result.stdout);
      };
      const selected = await inspect(releaseSha256);
      assert.deepEqual(selected.mcp.servers.oce_mcp_slack, {
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
        "openshell:resolve:env:v7_" + work.env,
        "openshell:resolve:env:s" + "a".repeat(64) + "_" + work.env,
      ]) {
        const connected = await runManagedWorker(
          ["-e", probe],
          ["-v", volume + ":/tmp/node"],
          [settings(releaseSha256, tools), work.env + "=" + marker],
        );
        assert.deepEqual(JSON.parse(connected.stdout).nodeHost.mcp.servers.oce_mcp_slack, {
          ...selected.mcp.servers.oce_mcp_slack,
          enabled: true,
          headers: { Authorization: "Bearer " + marker },
          toolFilter: { include: ["slack_search_public"] },
        });
      }
      // Only the personal marker remains after withdrawal. It still requires an explicit handle.
      const personalMarker = "openshell:resolve:env:v8_" + personal.env;
      const remaining = await runManagedWorker(
        ["-e", probe],
        ["-v", volume + ":/tmp/node"],
        [settings(releaseSha256, tools, [work, personal]), personal.env + "=" + personalMarker],
      );
      assert.deepEqual(JSON.parse(remaining.stdout).nodeHost.mcp.servers.oce_mcp_slack, {
        ...selected.mcp.servers.oce_mcp_slack,
        enabled: true,
        toolFilter: { include: tools },
        accounts: { cs_personal: { headers: { Authorization: "Bearer " + personalMarker } } },
      });
      const withdrawn = await inspect(releaseSha256, [], tools);
      assert.deepEqual(withdrawn.mcp.servers.oce_mcp_slack, selected.mcp.servers.oce_mcp_slack);
      const deselected = await inspect(undefined);
      assert.equal(deselected.mcp?.servers?.oce_mcp_slack, undefined);
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
        (error) => error.stderr.includes("image integrity check: " + mcpPath),
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
      const digest = (content) => createHash("sha256").update(content).digest("hex");
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
      const work = slackAccount("cs_work", "Work");
      const slackMarker = "openshell:resolve:env:v19_" + work.env;
      const run = (toolNames) =>
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
                accounts: [work],
                toolNames: ["slack_search_public"],
              },
              {
                kind: "mcp",
                packageName: "oce-documents",
                slotId: "workspace",
                releaseSha256: digest(release),
                accounts: [{ id: "cs_documents", env: "DOCUMENTS_ACCESS_TOKEN" }],
                toolNames,
              },
            ),
            work.env + "=" + slackMarker,
            "DOCUMENTS_ACCESS_TOKEN=" + marker,
          ],
        );
      const configured = await run(["ListItems"]);
      assert.deepEqual(JSON.parse(configured.stdout).nodeHost.mcp.servers, {
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
        JSON.parse(updated.stdout).nodeHost.mcp.servers.oce_mcp_documents.toolFilter,
        {
          include: ["UpdateItem", "ListItems"],
        },
      );
      await assert.rejects(run(["List*"]), (error) =>
        error.stderr.includes("The selected MCP tools must have distinct literal names"),
      );
    },
  );

  test(
    "the native Gateway discovers the Google instructions with Slack selected alongside it",
    imageTestOptions,
    async (t) => {
      const accounts = [
        slackAccount("cs_work", "Office workspace"),
        slackAccount("cs_home", "Home workspace"),
      ];
      const googleAccounts = ["cs_office", "cs_archive"].map((id) => ({
        id,
        name: "Google " + id.slice(3),
        env: managedCredentialEnvironment(managedGoogleInstall, id),
      }));
      const { containerName } = await startGatewayWithSlack(
        t,
        true,
        undefined,
        accounts,
        googleAccounts,
      );
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
        JSON.parse(stdout).filePath,
        "/usr/local/lib/oce/plugin-catalog/oce-google-workspace/skills/oce-google/SKILL.md",
      );
      const skill = await runDocker([
        "exec",
        "-e",
        "OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json",
        containerName,
        "node",
        "/app/openclaw.mjs",
        "skills",
        "info",
        "oce-plugin-accounts",
        "--json",
      ]);
      const body = await runDocker([
        "exec",
        containerName,
        "cat",
        JSON.parse(skill.stdout).filePath,
      ]);
      assert.match(body.stdout, /--oce-account <account ID>/);
      assert.match(body.stdout, /"command":"gog"/);
      assert.match(body.stdout, /"server":"oce_mcp_slack"/);
      for (const { id, name, env } of [...accounts, ...googleAccounts]) {
        assert.ok(body.stdout.includes(id) && body.stdout.includes(name));
        assert.ok(!body.stdout.includes(env));
      }
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
    "runtime image enrolls the restricted workspace node and reconnects with saved credentials",
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
        new URL("../fixtures/runtime-workspace-node.mjs", import.meta.url),
        "utf8",
      );
      // The fixture bounds every CLI call and wait by one deadline 10 s inside this
      // exec timeout, so a hung call fails with its own name.
      const execTimeoutMs = 240_000 * imageSmokeTimeoutMultiplier;
      const { stdout } = await runDocker(
        [
          "exec",
          "-e",
          `WORKSPACE_PROOF_BUDGET_MS=${execTimeoutMs - 10_000}`,
          containerName,
          "node",
          "--input-type=module",
          "-e",
          source,
        ],
        { timeout: execTimeoutMs },
      );
      const result = JSON.parse(stdout);
      assert.equal(result.sameIdentityAfterRestart, true);
      assert.equal(result.singleBootstrapCompletion, true);
      assert.equal(result.commands.length, 7);
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
        "tests/conformance/workspace-node-supervisor.test.mjs",
        "tests/helpers/available-port.mjs",
        "tests/helpers/reuse-port-preload.mjs",
        "apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
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
        "packages/contracts/src/runtime-failure.mjs",
      ];
      const files = await Promise.all(
        paths.map(async (path) => [
          path,
          await readFile(new URL(`../../${path}`, import.meta.url), "utf8"),
        ]),
      );
      const launch = String.raw`
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
for (const [relative, content] of JSON.parse(readFileSync(0, "utf8"))) {
  const target = join("/tmp/proof", relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const child = spawnSync(process.execPath, ["--test", "/tmp/proof/tests/conformance/workspace-node-supervisor.test.mjs"], { stdio: "inherit" });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`;
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
          "-e",
          launch,
        ],
        {},
        JSON.stringify(files),
      ).catch((error) => {
        // CI truncates the error message and drops the command output, so name the
        // in-image proof that failed first (main run 37424312731 lost it).
        const report = commandOutput(error);
        const failing = report.indexOf("failing tests:");
        const summary =
          failing !== -1
            ? report.slice(failing, failing + 2_000)
            : report.trim() !== ""
              ? report.slice(-2_000)
              : error.message;
        const stopped = error.killed ? ` (killed by ${error.signal ?? "a signal"})` : "";
        throw new Error(`The in-image supervisor proof failed${stopped}: ${summary}`, {
          cause: error,
        });
      });
      // Every supervisor proof in the file must pass in the image. The check reads
      // the run's own totals, so adding a proof needs no change here. The floor is
      // the 7 proofs the file had when the count stopped being hard-coded
      // (finding 1032); lower it only when a proof is removed on purpose.
      assertAllPassed(stdout, { minimum: 7 });
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
      const launch = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const cp = require("node:child_process");
const { entrypoints, schemaMs, startupMs } = JSON.parse(fs.readFileSync(0, "utf8"));
const gatewaySpawned = ${openClawGatewaySpawnedRequest};
const openClawRunning = ${openClawProcessRunningRequest};
const manifest = { kind: "openclaw", selections: {}, pluginApprovers: [] };
const base = {
  gateway: { mode: "local", bind: "loopback", controlUi: { enabled: false },
    auth: { mode: "token", token: "synthetic-approver-startup-token" } },
  logging: { consoleLevel: "error" },
};
const schemaResult = cp.spawnSync("node", ["/app/openclaw.mjs", "config", "schema", "--json"], { encoding: "utf8", timeout: schemaMs, maxBuffer: 8 * 1024 * 1024 });
assert.equal(schemaResult.status, 0, schemaResult.stderr);
const supportsSlackApprovers = JSON.parse(schemaResult.stdout).properties?.approvals?.properties?.plugin?.properties?.slack !== undefined;
async function scenario(entrypoint, channel, label) {
  const directory = fs.mkdtempSync("/tmp/oce-approver-startup-");
  const config = { ...base, ...(channel === undefined ? {} : { channels: { slack: channel } }) };
  const configPath = directory + "/base.json";
  fs.writeFileSync(configPath, JSON.stringify(config));
  const environment = { ...process.env, HOME: "/home/node", OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_JSON: JSON.stringify(config),
    OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({ manifest }), OPENCLAW_GATEWAY_PORT: "18789",
    OPENCLAW_RUNTIME_STATUS_PORT: "18888", OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
    OPENCLAW_AGENT_REVISION_ID: "rev_approver-startup", OPENCLAW_POD_UID: "pod_approver-startup" };
  const child = cp.spawn("node", ["-e", ...entrypoint], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", value => { output += value; });
  child.stderr.on("data", value => { output += value; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const deadline = Date.now() + startupMs;
  const incompatible = channel?.enabled !== false && channel !== undefined && !supportsSlackApprovers;
  // Only a configured Slack channel gets the approver overlay, so only that case
  // needs OpenClaw's full start to prove it accepts the policy. Without the overlay
  // the effective config is the base config: those cases end once the launcher has
  // passed its checks and spawned OpenClaw (four fewer full starts per run).
  const fullStart = channel?.enabled === true;
  try {
    let observed = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(label + " exited before readiness: " + output);
      if (incompatible) {
        observed = output.includes("cannot validate approvals.plugin.slack");
      } else if (!fullStart) {
        observed = (await gatewaySpawned()) === 200;
      } else {
        try { observed = (await fetch("http://127.0.0.1:18789/healthz", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      }
      if (observed) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(observed, label + " did not report its expected startup outcome: " + output);
    if (incompatible) {
      assert.equal(fs.existsSync(directory + "/openclaw.json"), false, "Rejected policy must not replace the native config");
      assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), config);
      await assert.rejects(fetch("http://127.0.0.1:18789/healthz", { signal: AbortSignal.timeout(1000) }));
      if (label.startsWith("kubernetes")) {
        const status = await (await fetch("http://127.0.0.1:18888/openclaw/runtime/status")).json();
        assert.equal(status.runtimeFailure.check, "plugin-approvers");
        assert.equal(status.runtimeFailure.code, "INCOMPATIBLE_RESPONSE");
      }
    } else {
      const effective = JSON.parse(fs.readFileSync(directory + "/openclaw.json", "utf8"));
      assert.deepEqual(effective.approvals?.plugin?.slack, channel === undefined || channel.enabled === false ? undefined : { approvers: [] });
    }
    assert.deepEqual(manifest.pluginApprovers, []);
    assert.equal(fs.readdirSync("/tmp").some(name => name.startsWith("oce-plugin-approvers-")), false, "Capability probe must clean up its private config");
  } finally {
    child.kill("SIGTERM");
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  // The launcher forwards SIGTERM to OpenClaw and exits with it, but a respawned
  // OpenClaw stopped early in its start can outlive it briefly. The next scenario
  // reuses the port, so wait until no OpenClaw process runs.
  const stopDeadline = Date.now() + 30_000;
  while ((await openClawRunning()) === 200 && Date.now() < stopDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await openClawRunning(), 503, label + " left an OpenClaw process running");
}
(async () => {
  for (const [label, entrypoint] of Object.entries(entrypoints)) {
    await scenario(entrypoint, undefined, label + " absent");
    await scenario(entrypoint, { enabled: false }, label + " disabled");
    await scenario(entrypoint, { enabled: true }, label + " configured");
  }
  console.log("PLUGIN_APPROVER_STARTUP_PASSED");
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
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
