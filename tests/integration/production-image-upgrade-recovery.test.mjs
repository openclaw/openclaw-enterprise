import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../..", import.meta.url));
const script =
  process.env.OCC_UPGRADE_SCRIPT ?? join(repository, "scripts/upgrade-production-images");
const controller = `registry.example.invalid/controller@sha256:${"a".repeat(64)}`;
const runtime = `registry.example.invalid/runtime@sha256:${"b".repeat(64)}`;
const newController = `registry.example.invalid/controller@sha256:${"e".repeat(64)}`;
const newBroker = `registry.example.invalid/broker@sha256:${"f".repeat(64)}`;
const oldRuntime = `registry.example.invalid/runtime@sha256:${"c".repeat(64)}`;

// This fixture substitutes the external command protocols, not the upgrade
// script. It records accepted writes independently of the client response.
const executable = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = process.env.UPGRADE_FIXTURE;
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stateFile = path.join(root, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const log = (value) => fs.appendFileSync(path.join(root, 'events'), value + '\\n');
const take = (name) => { const p = path.join(root, name); if (!fs.existsSync(p)) return false; fs.unlinkSync(p); return true; };
const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
const fileArg = (name) => args[args.indexOf(name) + 1];
if (tool === 'helm') {
  if (args[0] === 'status') {
    out(args.includes('json') ? {version: state.version, info: {status: state.helmStatus}} : state.helmStatus);
  } else if (args[0] === 'get') {
    out(fs.readFileSync(path.join(root, 'live-values'), 'utf8'));
  } else if (args[0] === 'template') {
    out('rendered');
  } else if (args[0] === 'upgrade' && !args.includes('--dry-run=server')) {
    if (state.api !== 0 || state.worker !== 0) { console.error('old writers were not stopped'); process.exit(2); }
    log('migration');
    state.version += 1;
    fs.copyFileSync(fileArg('--values'), path.join(root, 'live-values'));
    if (take('fail-migration')) { state.helmStatus = 'failed'; save(); process.exit(9); }
    state.helmStatus = 'deployed';
    state.controller = execFileSync('yq', ['-p=yaml', '-r', '.images.controller', fileArg('--values')], {encoding: 'utf8'}).trim();
    state.checksum = execFileSync('yq', ['-p=yaml', '-r', '.controlPlane.installationChecksum', fileArg('--values')], {encoding: 'utf8'}).trim();
    state.api = 1;
    state.worker = 1;
    save();
    if (take('lost-helm-response')) process.exit(9);
  }
} else if (tool === 'kubectl') {
  if (args.includes('--raw=/readyz')) out('ok');
  else if (args.includes('create') && args.includes('secret')) {
    const file = args.find((a) => a.startsWith('--from-file=')).slice('--from-file='.length).split('=');
    out({metadata: {name: 'occ-installation-startup'}, data: {[file[0]]: fs.readFileSync(file[1]).toString('base64')}});
  } else if (args.includes('apply')) {
    const secret = JSON.parse(execFileSync('yq', ['-o=json', '.', '-'], {input: fs.readFileSync(0)}));
    state.secret.data = {...state.secret.data, ...secret.data}; save(); log('secret-replaced');
    if (take('lost-secret-response')) process.exit(9);
  }
  else if (args.includes('scale')) {
    const component = args.find((a) => a.startsWith('deployment/')).split('-').at(-1);
    if (component === 'worker' && take('fail-scale-worker')) process.exit(9);
    state[component] = 0; save(); log('scale-' + component);
  } else if (args.includes('replace')) {
    const secret = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (secret.metadata.resourceVersion !== state.secret.metadata.resourceVersion) process.exit(11);
    secret.metadata.resourceVersion = String(Number(secret.metadata.resourceVersion) + 1);
    state.secret = secret; save(); log('secret-replaced');
    if (take('lost-secret-response')) process.exit(9);
  } else if (args.includes('get') && args.includes('secret')) out(state.secret);
  else if (args.includes('get') && args.includes('nodes')) {
    const architecture = process.arch === 'x64' ? 'amd64' : 'arm64';
    if (fs.existsSync(path.join(root, 'change-node'))) { state.nodeReads = (state.nodeReads ?? 0) + 1; save(); }
    const uid = state.nodeReads > 1 ? 'replacement-node-uid' : 'node-uid';
    out({items: [{metadata: {name: 'node-a', uid, labels: {'kubernetes.io/os': 'linux', 'kubernetes.io/arch': architecture}}, status: {nodeInfo: {operatingSystem: 'linux', architecture}}}]});
  }
  else if (args.includes('get') && args.includes('deployment') && args.includes('openclaw-enterprise-worker')) {
    out({metadata: {labels: {'app.kubernetes.io/instance': 'oce'}}, spec: {template: {spec: {containers: [{name: 'repository-credentials', args: ['--public-origin', 'https://git.system.svc.cluster.local']}]}}}});
  }
  else if (args.some((a) => a.startsWith('deployment/')) && args.includes('get')) {
    const component = args.find((a) => a.startsWith('deployment/')).split('-').at(-1);
    const image = component === 'worker' ? (state.workerObservedImage ?? state.controller) : state.controller;
    const container = {name: component, image};
    const podSpec = {containers: [container]};
    if (component === 'worker' && state.workerPlacement !== 'container') {
      podSpec.containers = state.workerPlacement === 'ambiguous' ? [container] : [{name: 'repository-credentials', image: 'broker'}];
      if (state.workerPlacement !== 'missing') {
        podSpec.initContainers = [{...container, ...(state.workerPlacement === 'nonrestartable' ? {} : {restartPolicy: 'Always'})}];
      }
    }
    if (args.some((a) => a.startsWith('jsonpath='))) {
      out(podSpec.containers.filter((item) => item.name === component).map((item) => item.image).join(' '));
    } else {
      out({metadata: {name: 'openclaw-enterprise-' + component, uid: component + '-deployment-uid', generation: 1, labels: {'app.kubernetes.io/instance': 'oce', 'app.kubernetes.io/component': component}}, spec: {replicas: state[component], template: {metadata: {annotations: {'openclaw.dev/installation-checksum': state.checksum}}, spec: podSpec}}, status: {observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1}});
    }
  } else if (args.includes('get') && args.includes('jobs')) {
    out({items: state.initJobActive ? [{status: {active: 0, conditions: []}}] : []});
  } else if (args.includes('get') && args.includes('replicasets')) {
    const selector = fileArg('--selector');
    const component = selector.endsWith('component=worker') ? 'worker' : 'api';
    out({items: [{metadata: {name: component + '-rs', uid: component + '-rs-uid', ownerReferences: [{kind: 'Deployment', name: 'openclaw-enterprise-' + component, uid: component + '-deployment-uid', controller: true}]}}]});
  } else if (args.includes('get') && args.includes('pods')) {
    const initialization = args.some((a) => a.includes('component=initialization'));
    const revision = args.some((a) => a.includes('openclaw.dev/revision=rev_new'));
    const pairComponent = args.some((a) => a.includes('app.kubernetes.io/component=worker')) ? 'worker' : args.some((a) => a.includes('app.kubernetes.io/component=api')) ? 'api' : null;
    if (pairComponent && state.simulatePair) {
      const proof = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'pair-proof.json')));
      const status = (name, image) => ({name, imageID: 'containerd://' + image.rootDigest, containerID: 'containerd://' + name, restartCount: 0, ready: true, state: {running: {}}});
      const worker = {name: pairComponent, image: proof.controller.image};
      const restartable = pairComponent === 'worker' && state.workerPlacement === 'restartable';
      const podSpec = {nodeName: 'node-a', containers: restartable ? [] : [worker]};
      const podStatus = {phase: 'Running', conditions: [{type: 'Ready', status: 'True'}], containerStatuses: restartable ? [] : [status(pairComponent, proof.controller)]};
      if (restartable) { podSpec.initContainers = [{...worker, restartPolicy: 'Always'}]; podStatus.initContainerStatuses = [status('worker', proof.controller)]; }
      if (pairComponent === 'worker') {
        podSpec.containers.push({name: 'repository-credentials', image: proof.broker.image});
        const brokerStatus = status('repository-credentials', proof.broker);
        if (fs.existsSync(path.join(root, 'wrong-broker-identity'))) brokerStatus.imageID = 'containerd://sha256:' + '0'.repeat(64);
        podStatus.containerStatuses.push(brokerStatus);
      }
      out({items: [{metadata: {name: pairComponent + '-pod', uid: pairComponent + '-pod-uid', ownerReferences: [{kind: 'ReplicaSet', name: pairComponent + '-rs', uid: pairComponent + '-rs-uid', controller: true}]}, spec: podSpec, status: podStatus}]});
    } else out({items: initialization && state.initActive ? [{status: {phase: 'Running'}}] : revision ? [{metadata: {namespace: 'tenant', name: 'gateway'}, spec: {containers: [{name: 'gateway', image: '${runtime}'}]}, status: {phase: 'Running', conditions: [{type: 'Ready', status: 'True'}]}}] : []});
  } else if (args.includes('get')) out({items: []});
  else if (args.includes('exec')) {
    if (args.includes('worker') && state.simulatePair && take('fail-capability')) process.exit(9);
    out(args.includes('worker') && state.simulatePair ? 'repository-admission-ready\\n' : '{}');
  }
} else if (tool === 'occ') {
  if (args.includes('deployment-inventory')) {
    out({installationId: 'ins_test', namespaces: [{id: 'ns_test', status: 'ready', agents: state.agent ? [{id: 'agt_test', status: 'active', desiredRuntimeState: 'running', executionMode: 'embedded', activeRevisionId: 'rev_old', deploymentInProgress: false}] : []}]});
  } else if (args.includes('deploy')) {
    state.dispatches += 1; state.activeRevision = 'rev_new'; save(); log('agent-deploy');
    if (take('lost-agent-response')) process.exit(9);
    out({id: 'rev_new'});
  } else if (args.includes('agent') && args.includes('get')) out({id: 'agt_test', activeRevisionId: state.activeRevision ?? 'rev_old'});
  else if (args.includes('deployment-status')) out({status: 'succeeded'});
  else out({id: 'ins_test'});
}
`;

async function fixture(
  t,
  {
    agent = false,
    candidates = false,
    controllerOnly = false,
    repositoryCredentials = false,
    simulatePair = false,
    workerPlacement = "container",
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "occ-upgrade-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  for (const name of ["helm", "kubectl", "occ"]) {
    const path = join(bin, name);
    await writeFile(path, executable);
    await chmod(path, 0o755);
  }
  if (simulatePair) {
    // These cases exercise upgrade orchestration after a successful qualification.
    // The separately selected real-image test verifies compatibility itself.
    const wrapper = `#!${process.execPath}
const {spawnSync} = require('child_process');
const args = process.argv.slice(2);
if (args[0] === 'scripts/upgrade-repository-image-probe.mjs') {
  const identity = (image) => ({image, platform: args[3], rootDigest: image.split('@').at(-1), manifestDigest: image.split('@').at(-1), configDigest: image.split('@').at(-1)});
  process.stdout.write(JSON.stringify({controller: identity(args[1]), broker: identity(args[2])}) + '\\n');
} else {
  const child = spawnSync(${JSON.stringify(process.execPath)}, args, {stdio: 'inherit'});
  process.exit(child.status ?? 1);
}
`;
    const path = join(bin, "node");
    await writeFile(path, wrapper);
    await chmod(path, 0o755);
  }
  const values = JSON.stringify({
    images: { controller },
    installation: { secretName: "occ-installation-startup", key: "installation.yaml" },
    ...(repositoryCredentials
      ? {
          repositoryCredentials: {
            enabled: true,
            image: `registry.example.invalid/broker@sha256:${"1".repeat(64)}`,
            serviceName: "git",
            hostname: "git.system.svc.cluster.local",
            clusterDomain: "cluster.local",
          },
        }
      : {}),
  });
  const installation = JSON.stringify({
    ...(repositoryCredentials
      ? {
          backend: [
            {
              id: "github-primary",
              type: "github",
              configuration: { registryPath: "/etc/openclaw/repository-registry/registry.json" },
              drivers: { repo: "repository-credentials" },
            },
          ],
        }
      : {}),
    drivers: {
      ...(repositoryCredentials
        ? {
            repo: {
              id: "repository-credentials",
              configuration: {
                controlSocket: "/run/openclaw/repository-control/private/control.sock",
                sessionDurationSeconds: 86400,
                publicCaPath: "/etc/openclaw/repository-ca/ca.crt",
              },
            },
          }
        : {}),
      compute: {
        id: "compute-kubernetes",
        configuration: {
          authentication: { mode: "inCluster" },
          images: { agent: oldRuntime, gateway: oldRuntime },
          ...(repositoryCredentials
            ? {
                network: {
                  repositoryCredentials: {
                    namespace: "system",
                    podLabels: { "app.kubernetes.io/component": "worker" },
                    port: 8443,
                  },
                },
              }
            : {}),
        },
      },
    },
  });
  const state = {
    version: 1,
    helmStatus: "deployed",
    api: 1,
    worker: 1,
    controller,
    agent,
    workerPlacement,
    simulatePair,
    dispatches: 0,
    initActive: false,
    secret: {
      metadata: {
        name: "occ-installation-startup",
        uid: "secret-uid",
        resourceVersion: "1",
        annotations: { "openclaw.dev/installation-id": "ins_test", retained: "yes" },
      },
      data: {
        "installation.yaml": Buffer.from(installation).toString("base64"),
        retained: "cHJlc2VydmVk",
      },
    },
  };
  await writeFile(join(directory, "state.json"), JSON.stringify(state));
  await writeFile(join(directory, "live-values"), values);
  await writeFile(join(directory, "events"), "");
  for (const [name, content] of Object.entries({
    kubeconfig: "cluster-config",
    key: "key",
    "values.json": values,
    "installation.json": installation,
  })) {
    await writeFile(join(directory, name), content, { mode: 0o600 });
  }
  if (candidates) {
    const candidateValues = JSON.parse(values);
    candidateValues.api = { channelDirectoryProxyUrl: "http://198.51.100.25:3128" };
    const candidateInstallation = JSON.parse(installation);
    candidateInstallation.drivers.plugin = {
      id: "codex-plugin",
      configuration: { catalogSource: "openai-curated" },
    };
    await writeFile(join(directory, "candidate-values.json"), JSON.stringify(candidateValues), {
      mode: 0o600,
    });
    await writeFile(
      join(directory, "candidate-installation.json"),
      JSON.stringify(candidateInstallation),
      { mode: 0o600 },
    );
  }
  const evidence = join(directory, "evidence");
  const args = [
    "--kubeconfig",
    join(directory, "kubeconfig"),
    "--context",
    "selected",
    "--namespace",
    "system",
    "--release",
    "oce",
    "--values",
    join(directory, "values.json"),
    "--installation",
    join(directory, "installation.json"),
    ...(controllerOnly ? ["--controller-image", newController] : ["--runtime-image", runtime]),
    ...(simulatePair && !controllerOnly ? ["--controller-image", newController] : []),
    ...(simulatePair ? ["--broker-image", newBroker] : []),
    ...(candidates
      ? [
          "--candidate-values",
          join(directory, "candidate-values.json"),
          "--candidate-installation",
          join(directory, "candidate-installation.json"),
        ]
      : []),
    "--source-revision",
    "d".repeat(40),
    "--evidence-dir",
    evidence,
    "--occ",
    join(bin, "occ"),
  ];
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    UPGRADE_FIXTURE: directory,
    OCC_URL: "https://occ.example.invalid",
    OCC_SERVICE_KEY_FILE: join(directory, "key"),
  };
  return {
    directory,
    evidence,
    run: (...extra) => execute(script, [...args, ...extra], { cwd: repository, env }),
    state: async () => JSON.parse(await readFile(join(directory, "state.json"), "utf8")),
    events: async () =>
      (await readFile(join(directory, "events"), "utf8")).trim().split("\n").filter(Boolean),
    failNext: (name) => writeFile(join(directory, name), ""),
  };
}

test("resume reads an accepted Secret write before Helm and preserves its other data", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run());
  const interrupted = await f.state();
  assert.match(
    Buffer.from(interrupted.secret.data["installation.yaml"], "base64").toString(),
    /bbbbbbbbbbbbbbbb/,
  );
  await f.run("--resume");
  assert.deepEqual(await f.events(), [
    "scale-api",
    "scale-worker",
    "secret-replaced",
    "scale-api",
    "scale-worker",
    "migration",
  ]);
  const state = await f.state();
  assert.equal(state.secret.metadata.annotations.retained, "yes");
  assert.equal(state.secret.data.retained, "cHJlc2VydmVk");
  assert.equal(state.api, 1);
  assert.equal(state.worker, 1);
});

test("resume recognizes a committed Helm release without rerunning its migration", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-helm-response");
  await assert.rejects(f.run());
  await f.run("--resume");
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
});

test("an interrupted quiescence never starts migration while the worker still runs", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-scale-worker");
  await assert.rejects(f.run());
  assert.equal((await f.state()).api, 0);
  assert.equal((await f.state()).worker, 1);
  assert.deepEqual(await f.events(), ["scale-api"]);
  await f.run("--resume");
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
});

test("failed Helm migration keeps old writers stopped and requires checked history and a terminal Job", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-migration");
  await assert.rejects(f.run());
  assert.equal((await f.state()).api, 0);
  assert.equal((await f.state()).worker, 0);
  await assert.rejects(f.run("--resume"), /migration --check/);
  const state = await f.state();
  // An active Job may schedule a replacement even with no active Pods.
  state.initJobActive = true;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(
    f.run("--resume", "--migration-history-checked"),
    /initialization Job is still active/,
  );
  state.initJobActive = false;
  state.initActive = true;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(
    f.run("--resume", "--migration-history-checked"),
    /initialization Pod is still active/,
  );
  state.initActive = false;
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await f.run("--resume", "--migration-history-checked");
  assert.equal((await f.events()).filter((event) => event === "migration").length, 2);
});

test("resume reads back and stops on an unknown Agent deployment instead of retrying", async (t) => {
  const f = await fixture(t, { agent: true });
  await f.failNext("lost-agent-response");
  await assert.rejects(f.run(), /deployment outcome is unknown/);
  await assert.rejects(f.run("--resume"), /unknown deployment outcome/);
  assert.equal((await f.state()).dispatches, 1);
  const readback = JSON.parse(
    await readFile(join(f.evidence, "dispatch/ns_test--agt_test.readback.json"), "utf8"),
  );
  assert.equal(readback.id, "agt_test");
  assert.equal(readback.activeRevisionId, "rev_new");
  // Simulate the operator confirming this revision in durable history and
  // recording the accepted request before resuming the readiness checks.
  await writeFile(
    join(f.evidence, "dispatch/ns_test--agt_test.json"),
    JSON.stringify({ id: "rev_new" }),
  );
  await f.run("--resume");
  assert.equal((await f.state()).dispatches, 1);
});

test("resume refuses a pending Helm release or unrelated Secret changes", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run());
  const state = await f.state();
  state.helmStatus = "pending-upgrade";
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(f.run("--resume"), /Helm reports pending-upgrade/);
  state.helmStatus = "deployed";
  state.secret.data.retained = "Y2hhbmdlZA==";
  await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
  await assert.rejects(f.run("--resume"), /Installation Secret identity or unrelated data changed/);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 0);
});

test("resume rejects malformed protected inputs before another mutation", async (t) => {
  const f = await fixture(t);
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run());
  await writeFile(join(f.directory, "values.json"), "");
  await assert.rejects(f.run("--resume"), /protected Helm values changed/);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 0);
});

test("reviewed settings survive an interrupted controller upgrade without losing unrelated Secret data", async (t) => {
  const f = await fixture(t, {
    candidates: true,
    controllerOnly: true,
    repositoryCredentials: true,
    simulatePair: true,
  });
  // The Secret write succeeds, but its client loses the response before Helm.
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run());
  const interrupted = await f.state();
  const liveInstallation = JSON.parse(
    Buffer.from(interrupted.secret.data["installation.yaml"], "base64").toString(),
  );
  assert.equal(liveInstallation.drivers.plugin.configuration.catalogSource, "openai-curated");
  assert.equal(liveInstallation.drivers.compute.configuration.images.gateway, oldRuntime);
  assert.equal(
    liveInstallation.backend[0].configuration.registryPath,
    "/etc/openclaw/repository-registry/registry.json",
  );
  assert.equal(
    liveInstallation.drivers.repo.configuration.publicCaPath,
    "/etc/openclaw/repository-ca/ca.crt",
  );
  assert.equal(
    liveInstallation.drivers.compute.configuration.network.repositoryCredentials.port,
    8443,
  );
  assert.equal(interrupted.secret.data.retained, "cHJlc2VydmVk");
  await f.run("--resume");
  const finalState = await f.state();
  const liveValues = JSON.parse(
    (await execute("yq", ["-o=json", ".", join(f.directory, "live-values")])).stdout,
  );
  assert.equal(liveValues.api.channelDirectoryProxyUrl, "http://198.51.100.25:3128");
  assert.equal(liveValues.images.controller, newController);
  assert.equal(liveValues.repositoryCredentials.hostname, "git.system.svc.cluster.local");
  assert.equal(liveValues.controlPlane.installationChecksum, finalState.checksum);
  assert.equal(finalState.secret.metadata.annotations.retained, "yes");
  assert.equal((await f.events()).filter((event) => event === "secret-replaced").length, 1);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
  assert.equal(finalState.dispatches, 0);
});

test("stale baseline image fields stop before any writes", async (t) => {
  for (const file of ["values", "installation"]) {
    await t.test(file, async (subtest) => {
      const f = await fixture(subtest, { controllerOnly: file === "values" });
      const path = join(f.directory, `${file}.json`);
      const baseline = JSON.parse(await readFile(path, "utf8"));
      if (file === "values") {
        baseline.images.controller = `registry.example.invalid/controller@sha256:${"f".repeat(64)}`;
      } else {
        baseline.drivers.compute.configuration.images.gateway = runtime;
      }
      await writeFile(path, JSON.stringify(baseline));
      await assert.rejects(f.run(), /protected (Helm values|Installation YAML) differ/);
      assert.deepEqual(await f.events(), []);
    });
  }
});

test("resume refuses altered reviewed candidates before another mutation", async (t) => {
  const f = await fixture(t, { candidates: true });
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run());
  const path = join(f.directory, "candidate-values.json");
  const candidate = JSON.parse(await readFile(path, "utf8"));
  candidate.api.channelDirectoryProxyUrl = "http://198.51.100.26:3128";
  await writeFile(path, JSON.stringify(candidate));
  await assert.rejects(f.run("--resume"), /reviewed candidate values changed after preparation/);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 0);
});

test("resume refuses changed prepared candidate and fleet evidence before another mutation", async (t) => {
  for (const name of ["candidate-values.yaml", "targets.jsonl"]) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest);
      await f.failNext("fail-scale-worker");
      await assert.rejects(f.run());
      const events = await f.events();
      // An interrupted release must use the frozen candidate and Agent inventory.
      await writeFile(join(f.evidence, name), "{}\n");
      await assert.rejects(f.run("--resume"), /prepared upgrade evidence changed/);
      assert.deepEqual(await f.events(), events);
    });
  }
});

test("candidate cannot redirect the Installation Secret or change an image outside the selected flags", async (t) => {
  for (const field of ["secret", "image"]) {
    await t.test(field, async (subtest) => {
      const f = await fixture(subtest, { candidates: true });
      const path = join(
        f.directory,
        field === "secret" ? "candidate-values.json" : "candidate-installation.json",
      );
      const candidate = JSON.parse(await readFile(path, "utf8"));
      if (field === "secret") {
        candidate.installation.secretName = "other-installation";
      } else {
        candidate.drivers.compute.configuration.images.agent = runtime;
      }
      await writeFile(path, JSON.stringify(candidate));
      await assert.rejects(f.run(), /candidate (values|Installation) change/);
      assert.deepEqual(await f.events(), []);
    });
  }
});

test("candidate cannot change repository identity, grants, trust, or the Compute peer", async (t) => {
  for (const change of [
    "registry",
    "driver",
    "duration",
    "peer",
    "compute-authentication",
    "remove",
    "add",
  ]) {
    await t.test(change, async (subtest) => {
      const f = await fixture(subtest, {
        candidates: true,
        repositoryCredentials: change !== "add",
      });
      const path = join(f.directory, "candidate-installation.json");
      const candidate = JSON.parse(await readFile(path, "utf8"));
      // These inputs select a registry, grant authority, TLS trust, and the
      // credential service's network peer; no upgrade mutation may follow drift.
      if (change === "registry") {
        candidate.backend[0].configuration.registryPath = "/etc/other/registry.json";
      } else if (change === "driver") {
        candidate.drivers.repo.configuration.publicCaPath = "/etc/other/ca.crt";
      } else if (change === "duration") {
        candidate.drivers.repo.configuration.sessionDurationSeconds = 3600;
      } else if (change === "peer") {
        candidate.drivers.compute.configuration.network.repositoryCredentials.podLabels[
          "app.kubernetes.io/component"
        ] = "other";
      } else if (change === "compute-authentication") {
        candidate.drivers.compute.configuration.authentication = {
          mode: "kubeconfig",
          kubeconfigPath: "/etc/other/kubeconfig",
          context: "other",
        };
      } else if (change === "remove") {
        delete candidate.drivers.repo;
        delete candidate.backend;
      } else {
        candidate.drivers.repo = { id: "repository-credentials", configuration: {} };
        candidate.backend = [
          {
            id: "github-primary",
            type: "github",
            configuration: { registryPath: "/etc/other/registry.json" },
            drivers: { repo: "repository-credentials" },
          },
        ];
      }
      await writeFile(path, JSON.stringify(candidate));
      await assert.rejects(f.run(), /candidate Installation changes/);
      assert.deepEqual(await f.events(), []);
    });
  }
});

test("candidate cannot change cluster credentials or other protected trust settings", async (t) => {
  for (const change of [
    "execution-kubeconfig",
    "gateway-routing",
    "chatgpt-secret",
    "service-principal",
    "trusted-proxy",
    "configuration-authentication",
    "plugin-executable",
    "plugin-hosted",
    "plugin-null",
    "unreviewed-values",
  ]) {
    await t.test(change, async (subtest) => {
      const f = await fixture(subtest, { candidates: true, controllerOnly: true });
      const valuesPath = join(f.directory, "candidate-values.json");
      const installationPath = join(f.directory, "candidate-installation.json");
      const values = JSON.parse(await readFile(valuesPath, "utf8"));
      const installation = JSON.parse(await readFile(installationPath, "utf8"));
      // Each candidate redirects an identity or trust boundary while retaining
      // the supported proxy and catalog changes; preparation must stop first.
      if (change === "execution-kubeconfig") {
        values.executionCluster = {
          enabled: true,
          apiKubeconfigSecretName: "other-api",
          workerKubeconfigSecretName: "other-worker",
          apiCidrs: ["198.51.100.0/24"],
        };
      } else if (change === "gateway-routing") {
        values.gatewayRouting = { enabled: true, apiKeySecretName: "other-routing-key" };
      } else if (change === "chatgpt-secret") {
        values.backend = { chatgpt: { enabled: true, secretName: "other-chatgpt" } };
      } else if (change === "service-principal") {
        installation.drivers.compute.configuration.servicePrincipalCredentials = {
          mode: "projectedServiceAccountToken",
          audience: "other-audience",
          expirationSeconds: 900,
        };
      } else if (change === "trusted-proxy") {
        installation.drivers.compute.configuration.network = {
          gatewayTrustedProxyCidrs: ["198.51.100.0/24"],
        };
      } else if (change === "configuration-authentication") {
        installation.drivers.configuration = {
          id: "config-kubernetes",
          configuration: {
            authentication: { mode: "kubeconfig", kubeconfigPath: "/etc/other", context: "other" },
          },
        };
      } else if (change === "plugin-executable") {
        installation.drivers.plugin.configuration.codexExecutable = "/etc/other/codex";
      } else if (change === "plugin-hosted") {
        installation.drivers.plugin.configuration.catalogSource = "hosted";
      } else if (change === "plugin-null") {
        installation.drivers.plugin = { id: null, configuration: { catalogSource: null } };
      } else {
        values.controlPlane = { extraSetting: true };
      }
      await writeFile(valuesPath, JSON.stringify(values));
      await writeFile(installationPath, JSON.stringify(installation));
      await assert.rejects(f.run(), /candidate (values|Installation) change/);
      assert.deepEqual(await f.events(), []);
    });
  }
});

test("repository-enabled upgrades require both image selections before mutation", async (t) => {
  for (const controllerOnly of [true, false]) {
    await t.test(controllerOnly ? "controller release" : "runtime release", async (subtest) => {
      const f = await fixture(subtest, { repositoryCredentials: true, controllerOnly });
      // Either release restarts the worker and broker, so neither may reuse an unverified pair.
      await assert.rejects(f.run(), /require explicit controller and broker image selections/);
      assert.deepEqual(await f.events(), []);
    });
  }
});

test("broker image selection requires an enabled broker before mutation", async (t) => {
  const f = await fixture(t, { controllerOnly: true });
  const broker = `registry.example.invalid/broker@sha256:${"f".repeat(64)}`;
  await assert.rejects(
    f.run("--broker-image", broker),
    /requires repository credentials to be enabled/,
  );
  assert.deepEqual(await f.events(), []);
});

test("an unchecked repository image pair cannot start an upgrade", async (t) => {
  const f = await fixture(t, { repositoryCredentials: true, controllerOnly: true });
  const broker = `registry.example.invalid/broker@sha256:${"f".repeat(64)}`;
  // Selecting digests alone does not establish their admission compatibility.
  await assert.rejects(f.run("--broker-image", broker), /failed compatibility qualification/);
  assert.deepEqual(await f.events(), []);
});

test("a changed eligible node stops the upgrade before mutation", async (t) => {
  const f = await fixture(t, {
    agent: true,
    repositoryCredentials: true,
    simulatePair: true,
  });
  // Replace the selected node between preparation and the mutation boundary.
  await f.failNext("change-node");
  await assert.rejects(f.run(), /eligible control-plane nodes changed/);
  assert.deepEqual(await f.events(), []);
});

test("deployed pair verification stops before Agent dispatch on failure", async (t) => {
  for (const scenario of [
    { flag: "wrong-broker-identity", error: /deployed worker identity does not match/ },
    { flag: "fail-capability", error: /deployed controller cannot verify repository admission/ },
  ]) {
    await t.test(scenario.flag, async (subtest) => {
      const f = await fixture(subtest, {
        agent: true,
        repositoryCredentials: true,
        simulatePair: true,
      });
      // Helm has completed, but an unqualified Pod must not receive Agent work.
      await f.failNext(scenario.flag);
      await assert.rejects(f.run(), scenario.error);
      assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
      assert.equal((await f.state()).dispatches, 0);
    });
  }
});

test("controller upgrade verifies worker placement with and without a repository broker", async (t) => {
  for (const scenario of [
    { name: "broker disabled", repositoryCredentials: false, workerPlacement: "container" },
    {
      name: "broker enabled with existing chart",
      repositoryCredentials: true,
      workerPlacement: "container",
    },
    {
      name: "broker enabled with restartable worker",
      repositoryCredentials: true,
      workerPlacement: "restartable",
    },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const f = await fixture(subtest, {
        ...scenario,
        controllerOnly: true,
        simulatePair: scenario.repositoryCredentials,
      });
      const result = await f.run();
      assert.match(result.stdout, /Upgraded controller image; no Agent deployments were requested/);
      assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
      assert.equal((await f.state()).controller, newController);
    });
  }
});

test("controller upgrade rejects missing, ambiguous, or invalid worker placement", async (t) => {
  for (const scenario of [
    { name: "missing worker", repositoryCredentials: true, workerPlacement: "missing" },
    { name: "duplicate worker", repositoryCredentials: true, workerPlacement: "ambiguous" },
    {
      name: "nonrestartable worker",
      repositoryCredentials: true,
      workerPlacement: "nonrestartable",
    },
    {
      name: "init worker without broker",
      repositoryCredentials: false,
      workerPlacement: "restartable",
    },
    {
      name: "wrong worker image",
      repositoryCredentials: true,
      workerPlacement: "restartable",
      wrongImage: true,
    },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const f = await fixture(subtest, {
        ...scenario,
        controllerOnly: true,
        simulatePair: scenario.repositoryCredentials,
      });
      if (scenario.wrongImage) {
        const state = await f.state();
        state.workerObservedImage = oldRuntime;
        await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      }
      // A malformed or unexpected Deployment must not be reported as a
      // successful controller rollout, even if the Helm request completed.
      await assert.rejects(f.run(), /exactly one worker with the selected controller image/);
      assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
    });
  }
});
