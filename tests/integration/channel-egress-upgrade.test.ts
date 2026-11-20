import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createServer } from "node:http";
import { request } from "node:https";
import { selfSigned } from "../helpers/certificates.ts";
import { createUpgradeResponseProxy } from "../helpers/channel-upgrade-response-proxy.ts";

async function fixture(t: TestContext, enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "oce-channel-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const values = {
    images: { controller: `registry.example/controller@sha256:${"a".repeat(64)}` },
    installation: { name: "retained-installation" },
    database: { upgradeMigration: "separate", cidrs: ["192.0.2.10/32"] },
    metrics: { enabled: true },
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
  const run = (action: string, extra: string[] = [], env = process.env) =>
    spawnSync("python3", ["scripts/upgrade-channel-egress", action, ...args, ...extra], {
      encoding: "utf8",
      env,
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
  const validate = () =>
    spawnSync(
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
  const refused = validate();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unrelated settings/);
  values.database.upgradeMigration = f.values.database.upgradeMigration;
  values.metrics.enabled = 1;
  await writeFile(join(output, "values.yaml"), JSON.stringify(values));
  const changedType = validate();
  assert.equal(changedType.status, 1);
  assert.match(
    changedType.stderr,
    /unrelated settings/,
    "boolean and numeric values are distinct inputs",
  );
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

test("one-off preserves values parsed by filename and validates requested candidates", async (t) => {
  const f = await fixture(t, false);
  const input = join(f.directory, "values.properties");
  const installation = join(f.directory, "installation.yaml");
  const prepared = join(f.directory, "prepared");
  // yq reads property values as strings. The channel upgrade must preserve that type.
  await writeFile(input, "feature: true\n", { mode: 0o600 });
  const preparation = f.run("prepare", ["--values", input, "--out-dir", prepared]);
  assert.equal(preparation.status, 0, preparation.stderr);
  const candidate = await readFile(join(prepared, "values.yaml"), "utf8");
  assert.deepEqual(JSON.parse(candidate), {
    feature: "true",
    channelEgress: { enabled: false },
  });

  // The production wrapper checks copies with a .yaml.requested suffix.
  const requestedValues = join(f.directory, "candidate-values.yaml.requested");
  const requestedInstallation = join(f.directory, "candidate-installation.yaml.requested");
  await writeFile(requestedValues, candidate, { mode: 0o600 });
  await writeFile(requestedInstallation, await readFile(join(prepared, "installation.yaml")), {
    mode: 0o600,
  });
  const validation = f.run("validate", [
    "--before-values",
    input,
    "--before-installation",
    installation,
    "--values",
    requestedValues,
    "--installation",
    requestedInstallation,
  ]);
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal(validation.stdout, "false\n");

  // A .properties filename must not hide a Helm display header from either command.
  for (const heading of ["USER-SUPPLIED VALUES", "COMPUTED VALUES"]) {
    await t.test(heading, async () => {
      const display = join(f.directory, "display.properties");
      const refused = join(f.directory, `${heading}-properties-refused`);
      await writeFile(display, `${heading}: \nfeature: true\n`, { mode: 0o600 });
      const preparation = f.run("prepare", ["--values", display, "--out-dir", refused]);
      const validation = f.run("validate", [
        "--before-values",
        display,
        "--before-installation",
        installation,
        "--values",
        requestedValues,
        "--installation",
        requestedInstallation,
      ]);
      for (const result of [preparation, validation]) {
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, new RegExp(`${heading} display header`));
        assert.match(result.stderr, /helm get values RELEASE --output yaml/);
      }
      await assert.rejects(access(refused), { code: "ENOENT" });
    });
  }
});

test("one-off preparation never uses a values file swapped in after inspection", async (t) => {
  const f = await fixture(t, false);
  const input = join(f.directory, "values.yaml");
  const replacement = join(f.directory, "replacement.yaml");
  const output = join(f.directory, "prepared");
  const tools = join(f.directory, "bin");
  const display = "USER-SUPPLIED VALUES:\nmetrics:\n  enabled: false\n";
  await writeFile(replacement, display, { mode: 0o600 });
  await mkdir(tools);
  // Replace the path at the first parser invocation, then run the real yq.
  await writeFile(
    join(tools, "yq"),
    `#!/bin/sh
export PATH="$TEST_YQ_PATH"
if [ -f "$TEST_YQ_REPLACEMENT" ]; then
  mv "$TEST_YQ_REPLACEMENT" "$TEST_YQ_INPUT" || exit 1
fi
exec yq "$@"
`,
    { mode: 0o700 },
  );
  const result = f.run("prepare", ["--out-dir", output], {
    ...process.env,
    PATH: [tools, process.env.PATH].join(delimiter),
    TEST_YQ_PATH: process.env.PATH,
    TEST_YQ_INPUT: input,
    TEST_YQ_REPLACEMENT: replacement,
  });
  assert.equal(await readFile(input, "utf8"), display);
  if (result.status === 1) {
    await assert.rejects(access(output), { code: "ENOENT" });
    return;
  }
  assert.equal(result.status, 0, result.stderr);

  const values = JSON.parse(await readFile(join(output, "values.yaml"), "utf8"));
  assert.equal(Object.hasOwn(values, "USER-SUPPLIED VALUES"), false);
  assert.deepEqual(values.metrics, f.values.metrics);
});

test("one-off requires machine-readable Helm values captures", async (t) => {
  const f = await fixture(t, false);
  const input = join(f.directory, "values.yaml");
  const installation = join(f.directory, "installation.yaml");
  const prepared = join(f.directory, "prepared");
  const baseline = "slackProxy:\n  enabled: false\n";
  await writeFile(input, baseline);
  const preparation = f.run("prepare", ["--out-dir", prepared]);
  assert.equal(preparation.status, 0, preparation.stderr);
  const candidate = join(prepared, "values.yaml");
  const validate = (before: string, after: string) =>
    f.run("validate", [
      "--before-values",
      before,
      "--before-installation",
      installation,
      "--values",
      after,
      "--installation",
      join(prepared, "installation.yaml"),
    ]);

  for (const heading of ["USER-SUPPLIED VALUES", "COMPUTED VALUES"]) {
    await t.test(heading, async () => {
      const display = join(f.directory, "display.yaml");
      const refused = join(f.directory, "refused");
      const recapture = /helm get values RELEASE --output yaml/;
      await writeFile(display, `${heading}: \n${baseline}`, { mode: 0o600 });
      // The display header can reach either side of validation.
      for (const result of [
        f.run("prepare", ["--values", display, "--out-dir", refused]),
        validate(display, candidate),
        validate(input, display),
      ]) {
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, new RegExp(`${heading} display header`));
        assert.match(result.stderr, recapture);
        assert.equal(result.stdout, "");
      }
      await assert.rejects(access(refused), { code: "ENOENT" });

      // Helm prints a flow mapping after the header when there are no values.
      await writeFile(display, `${heading}: \n{}\n`);
      const empty = f.run("prepare", ["--values", display, "--out-dir", refused]);
      assert.equal(empty.status, 1, empty.stderr);
      assert.match(empty.stderr, /yq failed; inspect the selected resource/);
      assert.match(empty.stderr, recapture);
      await assert.rejects(access(refused), { code: "ENOENT" });

      for (const [label, entry, expected] of [
        ["mapping", `${heading}:\n  note: keep`, { note: "keep" }],
        ["explicit-null", `${heading}: null`, null],
        ["indented-null", `${heading}:\n  null`, null],
        ["quoted-key", `"${heading}":`, null],
        ["preceding-comment", `# operator note\n${heading}:`, null],
      ] as const) {
        const output = join(f.directory, `${heading}-${label}`);
        await writeFile(input, `${entry}\n${baseline}`);
        const result = f.run("prepare", ["--out-dir", output]);
        assert.equal(result.status, 0, result.stderr);
        const saved = JSON.parse(await readFile(join(output, "values.yaml"), "utf8"));
        assert.equal(Object.hasOwn(saved, heading), true);
        assert.deepEqual(saved[heading], expected);
      }
      await writeFile(input, baseline);
    });
  }
  const validated = validate(input, candidate);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(validated.stdout, "false\n");
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

test("quiesced one-off recovery verifies recorded Stops without contacting the stopped API", async (t) => {
  const f = await fixture(t);
  const inventory = join(f.directory, "inventory");
  await mkdir(inventory);
  const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
  const agentId = "agt_00000000-0000-4000-8000-000000000002";
  const originalRevisionId = "rev_00000000-0000-4000-8000-000000000003";
  const installationId = "ins_00000000-0000-4000-8000-000000000004";
  const before = {
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
            activeRevisionId: originalRevisionId as string | null,
            deploymentInProgress: false,
            repositoryWorkerRestart: "not-applicable" as string | null,
          },
        ],
      },
    ],
  };
  const stopped = structuredClone(before);
  Object.assign(stopped.namespaces[0]!.agents[0]!, {
    desiredRuntimeState: "stopped",
    activeRevisionId: null,
    repositoryWorkerRestart: null,
  });
  await writeFile(join(inventory, "restart-preflight.json"), JSON.stringify(before), {
    mode: 0o600,
  });
  await writeFile(join(inventory, "before-stop-selection.json"), JSON.stringify(stopped), {
    mode: 0o600,
  });
  const journal = join(f.directory, "channel-agent-operations.json");
  const receipt = {
    installationId,
    targets: [{ namespaceId, agentId, originalRevisionId, stop: "complete", deploy: "unsent" }],
  };
  await writeFile(journal, JSON.stringify(receipt), { mode: 0o600 });
  const run = () =>
    spawnSync(
      "python3",
      [
        "scripts/upgrade-channel-egress",
        "verify-stopped",
        "--evidence-dir",
        f.directory,
        "--occ",
        "/stopped-api-must-not-be-contacted",
        "--timeout-seconds",
        "1",
      ],
      { encoding: "utf8" },
    );
  const verified = run();
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /pre-quiescence inventory are confirmed/);
  // An accepted Stop is not evidence of completed cleanup, even while writers are off.
  receipt.targets[0]!.stop = "accepted";
  await writeFile(journal, JSON.stringify(receipt));
  const incomplete = run();
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /every original Stop to be complete/);
});

test("upgrade response proxy only forwards paths to its selected upstream", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-upgrade-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tls = await selfSigned(directory);
  const paths: string[] = [];
  const upstream = createServer((incoming, outgoing) => {
    paths.push(incoming.url!);
    outgoing.writeHead(200).end("fixture");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const proxy = await createUpgradeResponseProxy({
    upstream: `http://127.0.0.1:${address.port}`,
    key: tls.key,
    cert: tls.cert,
  });
  t.after(() => proxy.close());
  const status = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const call = request(proxy.url, { path, ca: tls.cert }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      });
      call.on("error", reject);
      call.end();
    });
  assert.equal(await status("/installation?probe=true"), 200);
  // A client cannot select another service even when it is reachable locally.
  assert.equal(await status(`http://127.0.0.1:${address.port}/absolute`), 400);
  assert.equal(await status(`//127.0.0.1:${address.port}/relative`), 400);
  assert.deepEqual(paths, ["/installation?probe=true"]);
});
