import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { OpenShellNetworkPolicyRule } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createOpenShellInstallationConfiguration } from "../helpers/openshell-kubernetes-real.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(repository, "apps/controller/package.json"));
const { loadYaml, dumpYaml } = require("@kubernetes/client-node");
const script = join(repository, "docs/assets/openshell-quickstart/configure-installation.mjs");
const example = loadYaml(
  await readFile(
    join(repository, "docs/assets/openshell-quickstart/plugin-network-policy.yaml"),
    "utf8",
  ),
) as { networkPolicies: OpenShellNetworkPolicyRule[] };

type OpenShellInstallationFixture = ReturnType<typeof createOpenShellInstallationConfiguration> & {
  backend: Parameters<typeof createOpenShellBackend>[0][];
  drivers: {
    sandbox: {
      id: string;
      configuration: ConstructorParameters<typeof OpenShellSandboxDriver>[0];
    };
  };
};

function installation(artifactRules: readonly OpenShellNetworkPolicyRule[]) {
  const image = "registry.example/runtime@sha256:" + "a".repeat(64);
  const base = createOpenShellInstallationConfiguration({
    authentication: { mode: "inCluster" },
    platformNamespace: "oce-system",
    gatewayImage: image,
    codexImage: image,
    cluster: "quickstart-policy",
  }) as OpenShellInstallationFixture;
  const sandbox = base.drivers.sandbox;
  const networkPolicies: OpenShellNetworkPolicyRule[] = [
    ...sandbox.configuration.policy.networkPolicies,
    {
      name: "source-control",
      binaries: [{ path: "/usr/bin/git" }],
      endpoints: [{ host: "github.com", ports: [443], tls: "skip" }],
    },
    ...artifactRules,
  ];
  return {
    ...base,
    drivers: {
      ...base.drivers,
      sandbox: {
        ...sandbox,
        configuration: {
          ...sandbox.configuration,
          policy: { ...sandbox.configuration.policy, networkPolicies },
        },
      },
      plugin: { id: "codex-plugin", configuration: { catalogSource: "openai-curated" } },
    },
  };
}

function edit(directory: string) {
  return spawnSync(process.execPath, [script], {
    cwd: repository,
    env: { ...process.env, OCC_DEVELOPMENT_STATE_DIRECTORY: directory },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("quickstart editor explicitly selects the supplied artifact rule and the real Sandbox admits only that subset", async (t) => {
  const directory = await temporaryDirectory(t, "oce-quickstart-policy-");
  const file = join(directory, "installation.yaml");
  const input = installation(example.networkPolicies);
  await writeFile(file, dumpYaml(input), { mode: 0o600 });
  const result = edit(directory);
  assert.equal(result.status, 0, result.stderr);
  const output = loadYaml(await readFile(file, "utf8")) as ReturnType<typeof installation>;
  assert.equal(
    output.drivers.sandbox.configuration.policy.networkPolicies.some(
      (rule) => rule.name === "source-control",
    ),
    false,
  );
  const definition = output.backend[0]!;
  const backend = createOpenShellBackend(definition);
  t.after(() => backend.client.close());
  const driver = new OpenShellSandboxDriver(output.drivers.sandbox.configuration, {
    id: output.drivers.sandbox.id,
    backend,
  });
  const admitted = driver.admitProtectedCodexArtifactPolicy(1);
  assert.deepEqual(admitted.declaredRuleNames, ["codex-plugin-artifacts"]);
  assert.deepEqual(Object.keys(admitted.snapshot.defaults), ["codex-plugin-artifacts"]);
  assert.deepEqual(admitted.snapshot.additions, []);
});

test("quickstart editor refuses a missing or ambiguous supplied artifact rule without changing the Installation", async (t) => {
  for (const [name, rules] of [
    ["missing", []],
    ["duplicate", [...example.networkPolicies, ...example.networkPolicies]],
  ] as const) {
    await t.test(name, async (context) => {
      const directory = await temporaryDirectory(context, "oce-quickstart-policy-refused-");
      const file = join(directory, "installation.yaml");
      const original = dumpYaml(installation(rules));
      await writeFile(file, original, { mode: 0o600 });
      const result = edit(directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Load exactly one approved codex-plugin-artifacts rule/);
      assert.equal(await readFile(file, "utf8"), original);
    });
  }
});
