import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createServer } from "node:http";
import { request } from "node:https";
import { selfSigned } from "../helpers/certificates.ts";
import { createUpgradeResponseProxy } from "../helpers/channel-upgrade-response-proxy.ts";
import { commandPath, writeCommand } from "../helpers/fake-commands.ts";

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

test("an ingress owner can admit the exact probe fleet before the dependency check", async (t) => {
  const f = await fixture(t);
  const output = join(f.directory, "prepared");
  const prepared = f.run("prepare", [
    "--out-dir",
    output,
    "--excluded-cidr",
    "10.42.0.0/16",
    "--excluded-cidr",
    "10.43.0.0/16",
    "--excluded-cidr",
    "192.0.2.3/32",
  ]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const log = join(f.directory, "kubectl.jsonl");
  const probe = "oce-channel-probe-2918ac095bc0";
  await writeCommand(
    f.directory,
    "kubectl",
    `import json, os, sys
from pathlib import Path
args = sys.argv[6:]
if args[0] == "-n":
    args = args[2:]
request = None
if args[:2] == ["create", "-f"]:
    request = json.load(sys.stdin)
elif args[:2] == ["delete", "--raw"]:
    request = json.loads(Path(args[-1]).read_text())
with open(os.environ["TEST_KUBE_CALLS"], "a") as log:
    print(json.dumps([args, request]), file=log)
if args[:2] == ["create", "namespace"]:
    if os.environ["TEST_EXISTING_NAMESPACE"] == "true":
        sys.exit(1)
    response = {"metadata": {"name": args[2], "uid": "probe-namespace-uid"}}
elif args[:2] == ["get", "deployment"]:
    response = {"spec": {"template": {"spec": {"containers": [{"image": "envoyproxy/gateway:v1.6.7"}]}}}}
elif args[:2] == ["get", "configmap"]:
    response = {"data": {"envoy-gateway.yaml": '{"extensionApis":{"enableEnvoyPatchPolicy":true}}'}}
elif args[:2] == ["get", "gatewayclass"]:
    response = {"spec": {"controllerName": "gateway.envoyproxy.io/gatewayclass-controller"}}
elif args[:2] == ["get", "pods"]:
    # Stop before port-forward. This test checks fleet identity and resource ownership.
    response = {"items": []}
elif request and request["kind"] == "NetworkPolicy":
    response = {"metadata": {"uid": "probe-egress-uid"}}
else:
    response = {}
print(json.dumps(response))
`,
    { interpreter: "python3" },
  );
  const env = {
    ...process.env,
    PATH: commandPath(f.directory),
    TEST_KUBE_CALLS: log,
  };
  const run = (name: string, existing = false) =>
    spawnSync(
      "python3",
      [
        "scripts/setup-channel-egress",
        "check",
        "--values",
        join(output, "values.yaml"),
        "--kubeconfig",
        "unused",
        "--context",
        "fixture",
        "--namespace",
        "oce-system",
        "--probe-name",
        name,
      ],
      { encoding: "utf8", env: { ...env, TEST_EXISTING_NAMESPACE: String(existing) } },
    );
  const calls = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const failed = run(probe);
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /probe expected exactly one owned Envoy Pod/u);
  const recorded = await calls();
  const creates = recorded.filter(([args]) => args[0] === "create");
  assert.deepEqual(creates[0][0].slice(0, 3), ["create", "namespace", probe]);
  assert.equal(creates.length, 3);
  assert.deepEqual(creates[1][1].spec.podSelector.matchLabels, {
    "gateway.envoyproxy.io/owning-gateway-name": probe,
    "gateway.envoyproxy.io/owning-gateway-namespace": probe,
  });
  assert.deepEqual(creates[1][1].spec.egress[0], {
    to: [{ podSelector: { matchLabels: { "control-plane": "envoy-gateway" } } }],
    ports: [{ protocol: "TCP", port: 18000 }],
  });
  const gateway = creates[2][1].items.find((item: { kind: string }) => item.kind === "Gateway");
  assert.deepEqual(gateway.metadata, { name: probe, namespace: probe });
  assert.deepEqual(
    recorded.filter(([args]) => args[0] === "delete").map(([, data]) => data.preconditions.uid),
    ["probe-namespace-uid", "probe-egress-uid"],
  );

  await writeFile(log, "");
  const invalid = run("kube-system");
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.match(invalid.stderr, /oce-channel-probe- followed by 12 lowercase hexadecimal digits/u);
  assert.equal(await readFile(log, "utf8"), "");

  const collision = run(probe, true);
  assert.equal(collision.status, 1, collision.stderr);
  // A failed namespace create grants no authority over the resources of its current owner.
  assert.deepEqual(
    (await calls()).filter(([args]) => args[0] === "create" || args[0] === "delete"),
    [[["create", "namespace", probe, "-o", "json"], null]],
  );
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
