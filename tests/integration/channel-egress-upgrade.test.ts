import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

async function fixture(t: TestContext, enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "oce-channel-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const values = {
    images: { controller: `registry.example/controller@sha256:${"a".repeat(64)}` },
    installation: { name: "retained-installation" },
    database: { upgradeMigration: "separate", cidrs: ["192.0.2.10/32"] },
    api: { clients: [{ namespace: "operators", podLabels: { app: "operator" } }] },
    slackProxy: { enabled },
    gatewayRouting: { gatewayClassName: "existing-class", envoyNamespace: "existing-envoy" },
  };
  const installation = {
    drivers: {
      compute: {
        id: "compute-kubernetes",
        configuration: {
          images: { gateway: "unchanged-runtime", agent: "unchanged-harness" },
          runtime: {
            gatewayStorageClassName: "retained-storage",
            ...(enabled
              ? {
                  channels: {
                    proxyUrl: "http://openclaw-enterprise-slack-proxy.oce-system.svc:3128",
                    managedProxy: {
                      hostname: "openclaw-enterprise-slack-proxy.oce-system.svc",
                      namespace: "oce-system",
                      port: 3128,
                      podLabels: {
                        "app.kubernetes.io/name": "openclaw-enterprise",
                        "app.kubernetes.io/instance": "oce",
                        "app.kubernetes.io/component": "slack-proxy",
                      },
                    },
                  },
                }
              : {}),
          },
        },
      },
    },
    presets: { files: ["retained.json"] },
  };
  for (const [name, value] of Object.entries({ values, installation })) {
    await writeFile(join(directory, `${name}.yaml`), JSON.stringify(value), { mode: 0o600 });
  }
  const args = [
    "--values",
    join(directory, "values.yaml"),
    "--installation",
    join(directory, "installation.yaml"),
    "--namespace",
    "oce-system",
    "--release",
    "oce",
  ];
  const run = (action: string, extra: string[] = []) =>
    spawnSync("python3", ["scripts/upgrade-channel-egress", action, ...args, ...extra], {
      encoding: "utf8",
    });
  return { directory, values, installation, run };
}

test("one-off preparation patches actual files and preserves unrelated settings", async (t) => {
  const f = await fixture(t);
  const output = join(f.directory, "prepared");
  const result = f.run("prepare", [
    "--out-dir",
    output,
    "--excluded-cidr",
    "10.42.0.0/16",
    "--excluded-cidr",
    "10.43.0.0/16",
    "--excluded-cidr",
    "192.0.2.3/32",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const values = JSON.parse(await readFile(join(output, "values.yaml"), "utf8"));
  const installation = JSON.parse(await readFile(join(output, "installation.yaml"), "utf8"));
  assert.equal(values.slackProxy, undefined);
  assert.equal(values.channelEgress.enabled, true);
  assert.equal(values.channelEgress.gatewayClassName, "existing-class");
  assert.equal(values.channelEgress.envoyNamespace, "existing-envoy");
  assert.deepEqual(values.database, f.values.database);
  assert.deepEqual(installation.presets, f.installation.presets);
  assert.deepEqual(
    installation.drivers.compute.configuration.images,
    f.installation.drivers.compute.configuration.images,
  );
  assert.equal(
    installation.drivers.compute.configuration.runtime.gatewayStorageClassName,
    "retained-storage",
  );
  assert.equal(installation.drivers.compute.configuration.runtime.channels, undefined);
  assert.deepEqual(installation.drivers.compute.configuration.runtime.channelEgress.excludedCidrs, [
    "10.42.0.0/16",
    "10.43.0.0/16",
    "192.0.2.3/32",
  ]);
  // Inputs remain the operator's original live baselines, including their old fields.
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, "values.yaml"), "utf8")), f.values);
  values.database.upgradeMigration = "hook";
  await writeFile(join(output, "values.yaml"), JSON.stringify(values));
  const refused = spawnSync(
    "python3",
    [
      "scripts/upgrade-channel-egress",
      "validate",
      "--before-values",
      join(f.directory, "values.yaml"),
      "--before-installation",
      join(f.directory, "installation.yaml"),
      "--values",
      join(output, "values.yaml"),
      "--installation",
      join(output, "installation.yaml"),
      "--namespace",
      "oce-system",
      "--release",
      "oce",
    ],
    { encoding: "utf8" },
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unrelated settings/);
});

test("disabled legacy channels only remove obsolete fields and remain off", async (t) => {
  const f = await fixture(t, false);
  const output = join(f.directory, "prepared");
  const result = f.run("prepare", ["--out-dir", output]);
  assert.equal(result.status, 0, result.stderr);
  const values = JSON.parse(await readFile(join(output, "values.yaml"), "utf8"));
  const installation = JSON.parse(await readFile(join(output, "installation.yaml"), "utf8"));
  assert.deepEqual(values.channelEgress, { enabled: false });
  assert.deepEqual(installation, f.installation);
  // This path exits before reading the nonexistent cluster credentials.
  const dependencies = spawnSync(
    "python3",
    [
      "scripts/setup-channel-egress",
      "install",
      "--values",
      join(output, "values.yaml"),
      "--kubeconfig",
      "missing",
      "--context",
      "unused",
      "--namespace",
      "oce-system",
    ],
    { encoding: "utf8" },
  );
  assert.equal(dependencies.status, 0, dependencies.stderr);
  assert.match(dependencies.stdout, /Channels disabled/);
});

test("one-off preparation refuses wrong release, external proxy, and unprotected input", async (t) => {
  const f = await fixture(t);
  const output = join(f.directory, "prepared");
  const wrongRelease = f.run("prepare", ["--release", "another-release", "--out-dir", output]);
  assert.equal(wrongRelease.status, 1);
  assert.match(wrongRelease.stderr, /matching runtime settings/);
  f.installation.drivers.compute.configuration.runtime.channels!.proxyUrl = "http://192.0.2.1:3128";
  await writeFile(join(f.directory, "installation.yaml"), JSON.stringify(f.installation));
  const external = f.run("prepare", ["--out-dir", output]);
  assert.equal(external.status, 1);
  assert.match(external.stderr, /matching runtime settings/);
  await chmod(join(f.directory, "values.yaml"), 0o644);
  const publicInput = f.run("prepare", ["--out-dir", output]);
  assert.equal(publicInput.status, 1);
  assert.match(publicInput.stderr, /private regular files/);
});

test("one-off refuses an uncertain deployment before invoking any OCC command", async (t) => {
  const f = await fixture(t);
  const inventory = join(f.directory, "inventory");
  await mkdir(inventory);
  const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
  const agentId = "agt_00000000-0000-4000-8000-000000000002";
  const originalRevisionId = "rev_00000000-0000-4000-8000-000000000003";
  const installationId = "ins_00000000-0000-4000-8000-000000000004";
  await writeFile(
    join(inventory, "restart-preflight.json"),
    JSON.stringify({
      installationId,
      namespaces: [
        {
          id: namespaceId,
          status: "ready",
          agents: [
            {
              id: agentId,
              status: "active",
              desiredRuntimeState: "running",
              executionMode: "dedicated",
              activeRevisionId: originalRevisionId,
              deploymentInProgress: false,
              repositoryWorkerRestart: "not-applicable",
            },
          ],
        },
      ],
    }),
    { mode: 0o600 },
  );
  const journal = join(f.directory, "channel-agent-operations.json");
  const receipt = JSON.stringify({
    installationId,
    targets: [{ namespaceId, agentId, originalRevisionId, stop: "complete", deploy: "sending" }],
  });
  await writeFile(journal, receipt, { mode: 0o600 });
  const result = spawnSync(
    "python3",
    [
      "scripts/upgrade-channel-egress",
      "deploy",
      "--evidence-dir",
      f.directory,
      "--occ",
      "/missing-occ-must-not-be-invoked",
      "--timeout-seconds",
      "1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outcome is unknown/);
  assert.match(result.stderr, /Do not resubmit automatically/);
  assert.equal(
    await readFile(journal, "utf8"),
    receipt,
    "refusal must retain the uncertain receipt",
  );
});
