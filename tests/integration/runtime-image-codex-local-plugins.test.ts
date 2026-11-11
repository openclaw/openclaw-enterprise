import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { EgressInstallation } from "../../packages/contracts/src/index.ts";
import type { FixtureSetup } from "../fixtures/codex-local-plugins/launch.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const names = ["selected", "excluded"];
const marketplace = '[marketplaces.oce-fixture]\nsource_type = "local"\nsource = "/fixture"\n';
const options = {
  skip: process.env.OCC_TEST_RUNTIME_IMAGE === undefined ? "Set OCC_TEST_RUNTIME_IMAGE." : false,
  timeout: 120_000,
};

async function packages(t: TestContext) {
  const root = await temporaryDirectory(t, "oce-native-packages-");
  await chmod(root, 0o755);
  await mkdir(`${root}/.agents/plugins`, { recursive: true });
  await writeFile(
    `${root}/.agents/plugins/marketplace.json`,
    JSON.stringify({
      name: "oce-fixture",
      plugins: names.map((name) => ({ name, source: `./plugins/${name}` })),
    }),
  );
  for (const name of names) {
    await mkdir(`${root}/plugins/${name}/.codex-plugin`, { recursive: true });
    await mkdir(`${root}/plugins/${name}/skills/greeting`, { recursive: true });
    await writeFile(
      `${root}/plugins/${name}/.codex-plugin/plugin.json`,
      JSON.stringify({
        name,
        version: "1.0.0",
        skills: "./skills",
      }),
    );
    await writeFile(
      `${root}/plugins/${name}/skills/greeting/SKILL.md`,
      `---\nname: greeting\ndescription: Harmless ${name} greeting.\n---\nSay hello. Do not use tools.\n`,
    );
  }
  for (const file of ["launch.ts", "client.ts", "session.ts", "probe.ts", "enrollment.ts"]) {
    await copyFile(
      new URL("../fixtures/codex-local-plugins/" + file, import.meta.url),
      root + "/" + file,
    );
    await chmod(root + "/" + file, 0o644);
  }
  return root;
}

async function dockerCase(t: TestContext) {
  const { runDocker, image } = await import("../helpers/runtime-image-startup.mjs");
  const root = await packages(t);
  const container = `oce-native-boundary-${randomUUID()}`;
  t.after(() => runDocker(["rm", "-f", container]));
  const args = [
    "run",
    "--name",
    container,
    "--pull=never",
    "--init",
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:size=256m,mode=1777",
    "--mount",
    `type=bind,src=${root},dst=/fixture,readonly`,
    "--entrypoint",
    "node",
  ];
  const provision = async (setup: FixtureSetup, launcher?: string) => {
    await writeFile(root + "/setup.json", JSON.stringify(setup), { mode: 0o644 });
    if (launcher) {
      await writeFile(root + "/generated-launcher.cjs", launcher, { mode: 0o644 });
    }
  };
  return { runDocker, image: image!, container, args, provision };
}

test(
  "protected Codex empty selection exposes no locally known fixture skills",
  options,
  async (t) => {
    const { PROTECTED_CODEX_RUNTIME_ENTRYPOINT } =
      await import("../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts");
    const { pluginRuntimeConfigMapData } =
      await import("../../apps/controller/src/drivers/compute/plugin-runtime.ts");
    const { harnessEgressEnrollment, computeReleasePublicKey, signComputeExecutionRelease } =
      await import("../../apps/controller/src/drivers/compute/egress-enrollment.ts");
    const { runDocker, image, container, args, provision } = await dockerCase(t);
    const { privateKey } = generateKeyPairSync("ed25519");
    const bearer = randomBytes(32).toString("hex");
    const installation: EgressInstallation = {
      plan: {
        id: "fixture-plan",
        generation: 1,
        sandboxDriverId: "fixture",
        egressDriverId: "fixture",
        routes: [],
        execution: {
          installationId: "fixture",
          namespaceId: "fixture",
          agentId: "fixture",
          servicePrincipalId: "fixture",
          revisionId: "fixture",
          executionId: "fixture",
        },
      },
      sandboxId: "fixture",
      sender: { id: "fixture", generation: 1 },
      installedAt: new Date().toISOString(),
      enforcement: {
        instanceId: "fixture",
        configurationId: "fixture",
        policyHash: "fixture",
        authorityScope: "execution",
        peerKeyId: "fixture",
      },
    };
    const files = pluginRuntimeConfigMapData({
      kind: "codex",
      selections: {},
      providerTools: "none",
      approvalPolicy: "on-request",
      egressEnrollment: harnessEgressEnrollment(installation.plan),
    });
    // Register only discovery locations; keep OCE's off-by-default configuration intact.
    const config = files["config.toml"]! + "\n" + marketplace;
    const environment = {
      CODEX_LOGIN_MODE: "protected-no-inference",
      OPENCLAW_HARNESS_MODEL: "codex/fixture",
      OPENCLAW_WORKSPACE_DIR: "/tmp/workspace",
      APP_SERVER_PORT: "4500",
      APP_TOKEN_SHA: createHash("sha256").update(bearer).digest("hex"),
      OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: "fixture",
      OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY: computeReleasePublicKey(privateKey),
      OPENCLAW_PLUGIN_READY_MARKER: "/tmp/ready",
      OPENCLAW_PLUGIN_RUNTIME_JSON: JSON.stringify({
        manifest: JSON.parse(files["runtime.json"]!),
        codexConfigurationToml: config,
      }),
    };
    assert.ok(!JSON.stringify(environment).includes(bearer), "Harness receives only the verifier");
    await provision(
      { configuration: config, environment, mode: "protected" },
      PROTECTED_CODEX_RUNTIME_ENTRYPOINT,
    );
    await runDocker([...args, "-d", image, "/fixture/launch.ts"]);
    // Host-side production signer; no private signing key or bearer enters Harness provisioning.
    const call = (input: unknown) =>
      runDocker(
        ["exec", "-i", container, "node", "/fixture/enrollment.ts"],
        { redact: [bearer], timeout: 30_000 },
        JSON.stringify(input),
      );
    const challenge = JSON.parse((await call({ bearer })).stdout);
    const release = signComputeExecutionRelease(privateKey, challenge.startupId, installation);
    assert.deepEqual(release.challenge, challenge);
    assert.equal(JSON.parse((await call({ bearer, release })).stdout).enrolled, true);
    const result = await runDocker(
      [
        "exec",
        "-i",
        "-e",
        "HOME=/tmp/home",
        "-e",
        "CODEX_HOME=/tmp/home/.codex",
        container,
        "node",
        "/fixture/probe.ts",
      ],
      { redact: [bearer], timeout: 40_000 },
      bearer,
    );
    assert.match(result.stdout, /NATIVE_PROTECTED_PASSED/);
  },
);

test(
  "stock Codex preparation loads only the selected read-only local package",
  options,
  async (t) => {
    const { pluginRuntimeConfigMapData } =
      await import("../../apps/controller/src/drivers/compute/plugin-runtime.ts");
    const { runDocker, image, args, provision } = await dockerCase(t);
    const baseline = pluginRuntimeConfigMapData({
      kind: "codex",
      selections: {},
      providerTools: "none",
      approvalPolicy: "on-request",
    })["config.toml"]!;
    // A separate stock-native preparation session: trust is selected before it starts.
    // This is not an admitted protected OCE Agent or a serving-client feature toggle.
    const config =
      baseline.replace("plugins = false", "plugins = true") +
      "\n" +
      marketplace +
      '\n[plugins."selected@oce-fixture"]\nenabled = true\n[plugins."excluded@oce-fixture"]\nenabled = false\n';
    await provision({ configuration: config, environment: {}, mode: "stock" });
    const result = await runDocker(
      [...args, "-i", image, "/fixture/launch.ts"],
      { timeout: 40_000 },
      "",
    );
    assert.match(result.stdout, /NATIVE_STOCK_PASSED/);
  },
);
