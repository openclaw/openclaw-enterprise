import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { kubernetesGatewayNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

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
const { execFileSync, spawnSync } = require('child_process');
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
const yq = (expression, file) => execFileSync('yq', ['-p=yaml', '-r', expression, file], {encoding: 'utf8'}).trim();
// Unless a case selects the real chart, a stand-in renders only what the startup
// preflight reads: each controller container's image and Installation mount.
const standInChart = (values) => {
  const secretName = yq('.installation.secretName // "occ-installation-startup"', values);
  const key = yq('.installation.key // "installation.yaml"', values);
  const deployment = (component, placement) => ({kind: 'Deployment', metadata: {name: 'openclaw-enterprise-' + component}, spec: {template: {spec: {serviceAccountName: 'openclaw-enterprise-' + component, volumes: [{name: 'installation-startup', secret: {secretName, items: [{key, path: 'installation.yaml'}]}}], [placement]: [{name: component, image: yq('.images.controller', values), env: [{name: 'OCC_CONFIG_PATH', value: '/etc/openclaw/installation/installation.yaml'}], volumeMounts: [{name: 'installation-startup', mountPath: '/etc/openclaw/installation', readOnly: true}]}]}}}});
  const repository = yq('.repositoryCredentials.enabled // false', values) === 'true';
  return [deployment('api', 'containers'), deployment('worker', repository ? 'initContainers' : 'containers')].map((document) => '---\\n' + JSON.stringify(document) + '\\n').join('');
};
// Starts the preflight Pod's container once with its Secret volumes and literal
// environment. Other cluster inputs (Secret-backed env, CA and token volumes) are
// not provided; chart cases point Compute at the test's Kubernetes API through an
// explicit kubeconfig instead of the Pod's service account. The container runs in
// OCC_TEST_PRODUCTION_IMAGE when set, otherwise as this checkout's source with
// /app mapped to it. Stand-in cases only record it.
const runPreflight = (pod) => {
  const scripted = state.preflightResults?.[pod.spec.containers[0].name];
  if (scripted) return scripted;
  if (!state.startupCheck) return {phase: 'Succeeded', log: 'installation-startup-ready\\n'};
  const container = pod.spec.containers[0];
  const work = fs.mkdtempSync(path.join(root, 'preflight-'));
  fs.chmodSync(work, 0o755);
  const mounts = [];
  for (const mount of container.volumeMounts ?? []) {
    const volume = pod.spec.volumes.find((item) => item.name === mount.name);
    const secret = volume?.secret && state.preflight.secrets[volume.secret.secretName];
    if (!secret) continue;
    const directory = path.join(work, mount.name);
    // The helper's umask is 077; the image's unprivileged user must still read the mount.
    fs.mkdirSync(directory);
    fs.chmodSync(directory, 0o755);
    for (const item of volume.secret.items) {
      fs.writeFileSync(path.join(directory, item.path), Buffer.from(secret.data[item.key], 'base64'));
      fs.chmodSync(path.join(directory, item.path), 0o644);
    }
    mounts.push([directory, mount.mountPath]);
  }
  // Kubernetes expands $(VAR) in literal values from earlier variables and turns $$ into $.
  const expanded = {};
  const env = (container.env ?? []).filter((item) => typeof item.value === 'string').map((item) => {
    const value = item.value.replace(/\\$\\$|\\$\\(([A-Za-z_][A-Za-z0-9_]*)\\)/g, (match, name) => match === '$$' ? '$' : expanded[name] ?? match);
    expanded[item.name] = value;
    return {name: item.name, value};
  });
  const image = process.env.OCC_TEST_PRODUCTION_IMAGE;
  const result = image
    // Host networking reaches the test's loopback Kubernetes API only with rootful Docker.
    ? spawnSync('docker', ['run', '--rm', ...(state.kubeconfig ? ['--network', 'host', '--mount', 'type=bind,src=' + state.kubeconfig + ',dst=' + state.kubeconfig + ',readonly'] : ['--network', 'none']), ...mounts.flatMap(([source, target]) => ['--mount', 'type=bind,src=' + source + ',dst=' + target + ',readonly']), ...env.flatMap((item) => ['--env', item.name + '=' + item.value]), '--entrypoint', container.command[0], image, ...container.args], {encoding: 'utf8'})
    : (() => {
      const local = (value) => mounts.reduce((current, [source, target]) => current.split(target).join(source), value).split('/app/apps/').join(process.cwd() + '/apps/').split('/app/packages/').join(process.cwd() + '/packages/');
      return spawnSync(process.execPath, container.args.map(local), {encoding: 'utf8', env: Object.fromEntries(env.map((item) => [item.name, local(item.value)]))});
    })();
  return {phase: result.status === 0 ? 'Succeeded' : 'Failed', log: (result.stdout ?? '') + (result.stderr ?? '')};
};
if (tool === 'helm') {
  if (args[0] === 'status') {
    out(args.includes('json') ? {version: state.version, info: {status: state.helmStatus}} : state.helmStatus);
  } else if (args[0] === 'get') {
    out(fs.readFileSync(path.join(root, 'live-values'), 'utf8'));
  } else if (args[0] === 'template') {
    out(state.realChart ? execFileSync(process.env.REAL_HELM, args, {encoding: 'utf8'}) : standInChart(fileArg('--values')));
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
  state.preflight ??= {secrets: {}, pods: {}, networkpolicies: {}, deleted: []};
  const resource = args.find((a) => /^(pod|secret|networkpolicy\\.networking\\.k8s\\.io)\\//.test(a));
  const collection = {pod: 'pods', secret: 'secrets', 'networkpolicy.networking.k8s.io': 'networkpolicies'};
  if (args.includes('create') && args.includes('--filename')) {
    const source = fileArg('--filename');
    const object = JSON.parse(fs.readFileSync(source === '-' ? 0 : source, 'utf8'));
    if (object.kind === 'Secret') state.preflight.secrets[object.metadata.name] = object;
    else if (object.kind === 'NetworkPolicy') state.preflight.networkpolicies[object.metadata.name] = object;
    else state.preflight.pods[object.metadata.name] = {...runPreflight(object), spec: object.spec};
    save();
  } else if (resource && args.includes('delete')) {
    const [kind, name] = resource.split('/');
    delete state.preflight[collection[kind]][name];
    state.preflight.deleted.push(resource);
    save();
  } else if (resource && (args.includes('get') || args.includes('logs'))) {
    const pod = state.preflight.pods[resource.slice('pod/'.length)];
    if (!pod) { console.error(resource + ' not found'); process.exit(1); }
    if (args.includes('logs') && pod.log === undefined) { console.error('container is waiting to start'); process.exit(1); }
    out(args.includes('logs') ? pod.log : {status: pod.status ?? {phase: pod.phase}});
  } else if (args.includes('--raw=/readyz')) out('ok');
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
  } else if (args.includes('get') && args.includes('secret')) {
    const name = args[args.indexOf('secret') + 1];
    if (name !== state.secret.metadata.name && name === state.collectorSecretName) {
      if (!state.collectorSecret) { console.error('secrets "' + name + '" not found'); process.exit(1); }
      out(state.collectorSecret);
    } else out(state.secret);
  }
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
    out({installationId: 'ins_test', namespaces: state.inventoryNamespaces ?? [{id: 'ns_test', status: 'ready', agents: state.agent ? [{id: 'agt_test', status: 'active', desiredRuntimeState: 'running', executionMode: 'embedded', activeRevisionId: 'rev_old', deploymentInProgress: false}] : []}]});
  } else if (state.names && args.includes('get') && (args.includes('agent') || args.includes('namespace'))) {
    // Reads a scripted resource name; an unlisted ID stands for a denied read.
    log('read ' + args.at(-1));
    const name = state.names[args.at(-1)];
    if (name === undefined) { process.stderr.write('permission denied\\n'); process.exit(1); }
    out({id: args.at(-1), name});
  } else if (args.includes('deploy')) {
    state.dispatches += 1; state.activeRevision = 'rev_new'; save(); log('agent-deploy');
    if (take('lost-agent-response')) process.exit(9);
    out({id: 'rev_new'});
  } else if (args.includes('agent') && args.includes('get')) out({id: 'agt_test', activeRevisionId: state.activeRevision ?? 'rev_old'});
  else if (args.includes('deployment-status')) out({status: 'succeeded'});
  else out({id: 'ins_test', name: state.installationName});
}
`;

// The fixture tools exit 9 only for a fault armed with failNext, so an interrupted
// run must stop at that fault and not at an earlier refusal.
const injectedFault = { code: 9 };

// The fixture's helm stands in for the real binary; chart cases still render with it.
const realHelm = (
  await execute("bash", ["-c", "command -v helm"]).catch(() => ({ stdout: "" }))
).stdout.trim();

const shippedCollectorConfig = (key) => readFile(join(repository, "deploy/logging", key));

// The bundled Collector's operator-created config Secret, as created from
// deploy/logging at install time ("current") or by an older revision ("stale").
async function collectorConfigSecret(name, collector) {
  if (collector !== "current" && collector !== "stale") {
    return null;
  }
  const data = {};
  for (const key of ["collector.yaml", "kubernetes.yaml", "exporter.yaml"]) {
    let content = await shippedCollectorConfig(key);
    if (collector === "stale" && key !== "exporter.yaml") {
      content = Buffer.from(
        content
          .toString()
          .replace(
            /^ *- set\(attributes\["event\.name"\], cache\["record"\]\["event"\]\) where attributes\["event\.name"\] == nil.*\n/m,
            "",
          )
          .replace(/^ *- delete_key\(attributes, "container\.image\.tag"\).*\n/m, ""),
      );
      assert.notDeepEqual(content, await shippedCollectorConfig(key));
    }
    data[key] = content.toString("base64");
  }
  return { metadata: { name, uid: "collector-config-uid", resourceVersion: "1" }, data };
}

// A stand-in Kubernetes API for the startup preflight's Compute check. It serves
// only the version, Namespace and SelfSubjectAccessReview requests that check makes,
// over verified HTTPS with a bearer token, from the Namespaces a case seeds. With
// `execution`, a second stand-in serves the two-cluster execution target under the
// kubeconfig context `execution`, granting the rules its `allows` callback admits.
// The real Kubernetes Compute Driver in the preflight Pod decides whether that state
// may start; this is not live cluster or RBAC proof.
async function kubernetesApi(t, directory, namespaces, denied, execution = null) {
  const certificate = join(directory, "kubernetes-api.crt");
  const key = join(directory, "kubernetes-api.key");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=kubernetes",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    key,
    "-out",
    certificate,
  ]);
  const tls = { key: await readFile(key), cert: await readFile(certificate) };
  const serve = async ({ namespaces, uid, allows }) => {
    const reads = [];
    const reviews = [];
    const server = createServer(tls, async (request, response) => {
      const url = new URL(request.url, "https://127.0.0.1");
      const reply = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const review =
        request.method === "POST" &&
        url.pathname === "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews";
      if (
        denied ||
        (request.method !== "GET" && !review) ||
        request.headers.authorization !== "Bearer preflight-token"
      ) {
        reply(403, { kind: "Status", apiVersion: "v1", status: "Failure", code: 403 });
        return;
      }
      if (review) {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
        const attributes = JSON.parse(body).spec.resourceAttributes;
        // `allows` answers a decision, or a whole review status such as an evaluation error.
        const decision = allows(attributes);
        const status = typeof decision === "object" ? decision : { allowed: decision };
        reviews.push({ ...attributes, allowed: status.allowed });
        reply(201, {
          kind: "SelfSubjectAccessReview",
          apiVersion: "authorization.k8s.io/v1",
          spec: { resourceAttributes: attributes },
          status,
        });
        return;
      }
      reads.push(url.pathname);
      if (url.pathname === "/version") {
        reply(200, { major: "1", minor: "35", gitVersion: "v1.35.0" });
      } else if (url.pathname === "/api/v1/namespaces/kube-system") {
        // Two-cluster preflight tells the clusters apart by this Namespace's UID.
        reply(200, { kind: "Namespace", apiVersion: "v1", metadata: { name: "kube-system", uid } });
      } else if (url.pathname === "/api/v1/namespaces") {
        // Only label-existence selectors, which is what Compute preflight sends.
        const keys = (url.searchParams.get("labelSelector") ?? "").split(",").filter(Boolean);
        const items = namespaces.filter((namespace) =>
          keys.every((label) => label in (namespace.metadata.labels ?? {})),
        );
        reply(200, { kind: "NamespaceList", apiVersion: "v1", metadata: {}, items });
      } else {
        reply(404, { kind: "Status", apiVersion: "v1", status: "Failure", code: 404 });
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { port: server.address().port, reads, reviews };
  };
  const control = await serve({ namespaces, uid: "control-cluster", allows: () => false });
  const target =
    execution === null
      ? null
      : await serve({
          namespaces: execution.namespaces,
          uid: "execution-cluster",
          allows: execution.allows,
        });
  const authority = (await readFile(certificate)).toString("base64");
  const cluster = (name, port) => ({
    name,
    cluster: { server: `https://127.0.0.1:${port}`, "certificate-authority-data": authority },
  });
  const kubeconfig = join(directory, "preflight-kubeconfig.json");
  await writeFile(
    kubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        cluster("preflight", control.port),
        ...(target === null ? [] : [cluster("execution", target.port)]),
      ],
      users: [{ name: "preflight", user: { token: "preflight-token" } }],
      contexts: [
        { name: "preflight", context: { cluster: "preflight", user: "preflight" } },
        ...(target === null
          ? []
          : [{ name: "execution", context: { cluster: "execution", user: "preflight" } }]),
      ],
      "current-context": "preflight",
    }),
  );
  // The controller image's unprivileged user reads this file through a bind mount.
  await chmod(kubeconfig, 0o644);
  return {
    kubeconfig,
    reads: control.reads,
    executionReads: target?.reads ?? [],
    reviews: target?.reviews ?? [],
  };
}

async function fixture(
  t,
  {
    agent = false,
    candidates = false,
    controllerOnly = false,
    repositoryCredentials = false,
    simulatePair = false,
    workerPlacement = "container",
    collector = null,
    chart = null,
    preflightResults = null,
    kubernetesNamespaces = [],
    kubernetesDenied = false,
    executionCluster = null,
    installationName = "Production",
    inventoryNamespaces = null,
    names = null,
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
  const collectorSecretName = "occ-demo-collector-config";
  let values = JSON.stringify({
    images: { controller },
    ...(collector
      ? { logging: { collector: { enabled: true, configSecretName: collectorSecretName } } }
      : {}),
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
  let installation = JSON.stringify({
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
  let api = null;
  if (chart) {
    // The release's example values and Installation, rendered by the real chart.
    const example = async (name) =>
      JSON.parse(
        (
          await execute("yq", [
            "-o=json",
            ".",
            join(repository, "deploy/examples/production", name),
          ])
        ).stdout,
      );
    const exampleValues = await example("values.yaml");
    exampleValues.images.controller = controller;
    exampleValues.installation = {
      secretName: "occ-installation-startup",
      key: "installation.yaml",
    };
    values = JSON.stringify(chart.values ? chart.values(exampleValues) : exampleValues);
    const exampleInstallation = await example("installation.yaml");
    exampleInstallation.drivers.compute.configuration.network.gatewayTrustedProxyCidrs = [
      "10.42.0.0/16",
    ];
    // Outside a cluster the preflight Pod has no service account, so Compute
    // reaches the stand-in Kubernetes API through an explicit kubeconfig.
    api = await kubernetesApi(
      t,
      directory,
      kubernetesNamespaces,
      kubernetesDenied,
      executionCluster,
    );
    const compute = exampleInstallation.drivers.compute.configuration;
    compute.authentication = {
      mode: "kubeconfig",
      kubeconfigPath: api.kubeconfig,
      context: "preflight",
    };
    if (executionCluster) {
      // The experimental two-cluster profile: the same kubeconfig selects the
      // execution stand-in, with documentation-range endpoint CIDRs.
      compute.gatewayRouting.hostname = "gateway.example.test";
      compute.executionCluster = {
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: api.kubeconfig,
          context: "execution",
        },
        harnessRouting: { ...compute.gatewayRouting, hostname: "harness.example.test" },
        network: {
          dns: compute.network.dns,
          harnessEndpointCidrs: ["192.0.2.2/32"],
          gatewayEndpointCidrs: ["192.0.2.1/32"],
          pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
        },
      };
    }
    installation = JSON.stringify(chart.installation(exampleInstallation));
  }
  const state = {
    realChart: Boolean(chart),
    startupCheck: Boolean(chart),
    kubeconfig: api?.kubeconfig ?? null,
    preflightResults,
    installationName,
    inventoryNamespaces,
    names,
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
    collectorSecretName,
    collectorSecret: await collectorConfigSecret(collectorSecretName, collector),
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
    REAL_HELM: realHelm,
    OCC_URL: "https://occ.example.invalid",
    OCC_SERVICE_KEY_FILE: join(directory, "key"),
  };
  return {
    directory,
    evidence,
    kubernetesReads: api?.reads ?? [],
    executionReads: api?.executionReads ?? [],
    accessReviews: api?.reviews ?? [],
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
  await assert.rejects(f.run(), injectedFault);
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
  await assert.rejects(f.run(), injectedFault);
  await f.run("--resume");
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
});

test("an interrupted quiescence never starts migration while the worker still runs", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-scale-worker");
  await assert.rejects(f.run(), injectedFault);
  assert.equal((await f.state()).api, 0);
  assert.equal((await f.state()).worker, 1);
  assert.deepEqual(await f.events(), ["scale-api"]);
  await f.run("--resume");
  assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
});

test("failed Helm migration keeps old writers stopped and requires checked history and a terminal Job", async (t) => {
  const f = await fixture(t);
  await f.failNext("fail-migration");
  await assert.rejects(f.run(), injectedFault);
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
  await assert.rejects(f.run(), injectedFault);
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
  await assert.rejects(f.run(), injectedFault);
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
  await assert.rejects(f.run(), injectedFault);
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

test("stale baseline image fields stop before any writes", { concurrency: true }, async (t) => {
  const cases = [];
  for (const file of ["values", "installation"]) {
    cases.push(
      t.test(file, async (subtest) => {
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
      }),
    );
  }
  await Promise.all(cases);
});

test("resume refuses altered reviewed candidates before another mutation", async (t) => {
  const f = await fixture(t, { candidates: true });
  await f.failNext("lost-secret-response");
  await assert.rejects(f.run(), injectedFault);
  const path = join(f.directory, "candidate-values.json");
  const candidate = JSON.parse(await readFile(path, "utf8"));
  candidate.api.channelDirectoryProxyUrl = "http://198.51.100.26:3128";
  await writeFile(path, JSON.stringify(candidate));
  await assert.rejects(f.run("--resume"), /reviewed candidate values changed after preparation/);
  assert.equal((await f.events()).filter((event) => event === "migration").length, 0);
});

test(
  "resume refuses changed prepared candidate and fleet evidence before another mutation",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const name of ["candidate-values.yaml", "targets.jsonl"]) {
      cases.push(
        t.test(name, async (subtest) => {
          const f = await fixture(subtest);
          await f.failNext("fail-scale-worker");
          await assert.rejects(f.run(), injectedFault);
          const events = await f.events();
          // An interrupted release must use the frozen candidate and Agent inventory.
          await writeFile(join(f.evidence, name), "{}\n");
          await assert.rejects(f.run("--resume"), /prepared upgrade evidence changed/);
          assert.deepEqual(await f.events(), events);
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "candidate cannot redirect the Installation Secret or change an image outside the selected flags",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const field of ["secret", "image"]) {
      cases.push(
        t.test(field, async (subtest) => {
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
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "candidate cannot change repository identity, grants, trust, or the Compute peer",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const change of [
      "registry",
      "driver",
      "duration",
      "peer",
      "compute-authentication",
      "remove",
      "add",
    ]) {
      cases.push(
        t.test(change, async (subtest) => {
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
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "candidate cannot change cluster credentials or other protected trust settings",
  { concurrency: true },
  async (t) => {
    const cases = [];
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
      cases.push(
        t.test(change, async (subtest) => {
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
                authentication: {
                  mode: "kubeconfig",
                  kubeconfigPath: "/etc/other",
                  context: "other",
                },
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
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "repository-enabled upgrades require both image selections before mutation",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const controllerOnly of [true, false]) {
      cases.push(
        t.test(controllerOnly ? "controller release" : "runtime release", async (subtest) => {
          const f = await fixture(subtest, { repositoryCredentials: true, controllerOnly });
          // Either release restarts the worker and broker, so neither may reuse an unverified pair.
          await assert.rejects(f.run(), /require explicit controller and broker image selections/);
          assert.deepEqual(await f.events(), []);
        }),
      );
    }
    await Promise.all(cases);
  },
);

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

test("a running Agent without an active revision is named with its remedy before mutation", async (t) => {
  const agent = (id, fields = {}) => ({
    id,
    status: "active",
    desiredRuntimeState: "running",
    executionMode: "dedicated",
    deploymentInProgress: false,
    ...fields,
  });
  const stranded = Array.from({ length: 12 }, (_, index) => `agt_stranded_${index + 1}`);
  const f = await fixture(t, {
    inventoryNamespaces: [
      {
        id: "ns_alpha",
        status: "ready",
        agents: [
          agent("agt_healthy", { activeRevisionId: "rev_old" }),
          agent("agt_stopped", { desiredRuntimeState: "stopped" }),
          ...stranded.slice(0, 2).map((id) => agent(id)),
        ],
      },
      { id: "ns_beta", status: "ready", agents: stranded.slice(2).map((id) => agent(id)) },
    ],
    // agt_stranded_2 and ns_beta have no readable name; agt_stranded_1's name
    // carries a quote, a newline, DEL, and a C1 control.
    names: { ns_alpha: "Team Alpha", agt_stranded_1: 'Mail "triage"\nbot\u007f\u009b' },
  });
  const failure = await f.run().then(
    () => assert.fail("the upgrade must refuse"),
    (error) => error,
  );
  const lines = failure.stderr.trimEnd().split("\n");
  assert.deepEqual(lines, [
    "upgrade-production-images: the deployment inventory contains a running Agent without an active revision; resolve its initial deployment first. No cluster changes were made.",
    '  - Agent agt_stranded_1 "Mail \\"triage\\"\\nbot\\u007f?" in Namespace ns_alpha "Team Alpha"',
    '  - Agent agt_stranded_2 (name unavailable) in Namespace ns_alpha "Team Alpha"',
    ...stranded
      .slice(2, 10)
      .map((id) => `  - Agent ${id} (name unavailable) in Namespace ns_beta (name unavailable)`),
    `  - and 2 more; see ${join(f.evidence, "inventory/deployment-inventory.json")}`,
    "Stop or delete each running Agent without an active revision (occ --namespace NAMESPACE_ID agent stop AGENT_ID), or deploy it until it succeeds (occ --namespace NAMESPACE_ID agent deploy AGENT_ID), then start again with a new evidence directory. See docs/guides/deploy/production-upgrade.md#upgrade-agent-runtimes.",
  ]);
  // Only name reads: one per listed Agent and one per Namespace, nothing beyond the first ten.
  assert.deepEqual(await f.events(), [
    "read ns_alpha",
    "read agt_stranded_1",
    "read agt_stranded_2",
    "read ns_beta",
    ...stranded.slice(2, 10).map((id) => `read ${id}`),
  ]);
  assert.equal((await f.state()).dispatches, 0);
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

test(
  "deployed pair verification stops before Agent dispatch on failure",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const scenario of [
      { flag: "wrong-broker-identity", error: /deployed worker identity does not match/ },
      { flag: "fail-capability", error: /deployed controller cannot verify repository admission/ },
    ]) {
      cases.push(
        t.test(scenario.flag, async (subtest) => {
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
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "controller upgrade verifies worker placement with and without a repository broker",
  { concurrency: true },
  async (t) => {
    const cases = [];
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
      cases.push(
        t.test(scenario.name, async (subtest) => {
          const f = await fixture(subtest, {
            ...scenario,
            controllerOnly: true,
            simulatePair: scenario.repositoryCredentials,
          });
          const result = await f.run();
          assert.match(
            result.stdout,
            /Upgraded controller image; no Agent deployments were requested/,
          );
          assert.equal((await f.events()).filter((event) => event === "migration").length, 1);
          assert.equal((await f.state()).controller, newController);
        }),
      );
    }
    await Promise.all(cases);
  },
);

test(
  "controller upgrade rejects missing, ambiguous, or invalid worker placement",
  { concurrency: true },
  async (t) => {
    const cases = [];
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
      cases.push(
        t.test(scenario.name, async (subtest) => {
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
        }),
      );
    }
    await Promise.all(cases);
  },
);

test("a stale bundled Collector config Secret stops the upgrade before mutation", async (t) => {
  const f = await fixture(t, { controllerOnly: true, collector: "stale" });
  await assert.rejects(
    f.run(),
    /Collector config Secret occ-demo-collector-config differs from this checkout's deploy\/logging \(collector\.yaml,kubernetes\.yaml\); refresh it/,
  );
  assert.deepEqual(await f.events(), []);
  assert.equal((await f.state()).controller, controller);
});

test("a missing bundled Collector config Secret stops the upgrade before mutation", async (t) => {
  const f = await fixture(t, { controllerOnly: true, collector: "missing" });
  await assert.rejects(
    f.run(),
    /cannot read the Collector config Secret occ-demo-collector-config/,
  );
  assert.deepEqual(await f.events(), []);
});

test(
  "a current or explicitly reviewed Collector config Secret lets the upgrade proceed",
  { concurrency: true },
  async (t) => {
    const cases = [];
    for (const [collector, extra] of [
      ["current", []],
      ["stale", ["--collector-config-reviewed"]],
    ]) {
      cases.push(
        t.test(`${collector} ${extra.join(" ")}`.trim(), async (subtest) => {
          const f = await fixture(subtest, { controllerOnly: true, collector });
          await f.run(...extra);
          assert.equal((await f.state()).controller, newController);
          const drift = (await readFile(join(f.evidence, "collector-config-drift"), "utf8")).trim();
          assert.equal(drift, collector === "stale" ? "collector.yaml\nkubernetes.yaml" : "");
        }),
      );
    }
    await Promise.all(cases);
  },
);

// A startup preflight refusal stops the upgrade before quiescence: both writers keep the
// old release, nothing migrates, and the temporary preflight resources are removed.
async function assertStoppedBeforeWriters(f) {
  const state = await f.state();
  assert.equal(state.api, 1);
  assert.equal(state.worker, 1);
  assert.equal(state.version, 1);
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(state.preflight.secrets, {});
  assert.deepEqual(state.preflight.pods, {});
  assert.deepEqual(state.preflight.networkpolicies, {});
  return state;
}

// The 2026-09-28 release example offered DevDay Presets through presets.files; later
// images no longer ship those files (finding 436). The selected controller image must
// reject that Installation before quiescence, so the old release keeps serving.
test("an Installation the selected controller image cannot load stops before any writer stops", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: {
      installation: (installation) => ({
        ...installation,
        presets: { includeDefaults: true, files: ["/app/deploy/presets/devday.json"] },
      }),
    },
  });
  await assert.rejects(f.run(), (error) =>
    /cannot start the api with the candidate Installation: .*Preset file \/app\/deploy\/presets\/devday\.json is unavailable\..*No OCC writer was stopped/s.test(
      error.stderr,
    ),
  );
  // The temporary NetworkPolicy, Secret and both Pods are removed after the refusal.
  const state = await assertStoppedBeforeWriters(f);
  // Both components fail the same way, and both logs are saved (finding 447).
  for (const component of ["api", "worker"]) {
    assert.match(
      await readFile(join(f.evidence, `preflight-${component}.log`), "utf8"),
      /Preset file \/app\/deploy\/presets\/devday\.json is unavailable\./,
    );
  }
  assert.deepEqual(state.preflight.deleted.map((resource) => resource.split("/")[0]).sort(), [
    "networkpolicy.networking.k8s.io",
    "pod",
    "pod",
    "secret",
  ]);
});

// The API and worker read the stored Installation name from the database and refuse
// one that breaks the Name rule (INSTALLATION_NAME_INVALID). The preflight Pods check
// the name OCC returns with the selected image's rule, so the refusal comes before any
// writer stops instead of after (dogfood D525). The Pod carries the stored name as JSON,
// so a trailing no-break space survives and a line break (a control character) gets the
// same refusal rather than a parse failure. Each case reads a different component's Pod.
for (const [name, installationName, component] of [
  [
    "a stored Installation name that breaks the Name rule stops before any writer stops",
    "Production\u00a0",
    "api",
  ],
  [
    "a stored Installation name with a line break gets the Name rule refusal",
    "Production\n",
    "worker",
  ],
]) {
  test(name, async (t) => {
    if (!realHelm) {
      t.skip("helm is unavailable to render the real chart");
      return;
    }
    const f = await fixture(t, {
      controllerOnly: true,
      installationName,
      chart: { installation: (installation) => installation },
    });
    await assert.rejects(f.run(), (error) => {
      for (const stopped of ["api", "worker"]) {
        assert.match(
          error.stderr,
          new RegExp(
            `the ${stopped} startup preflight stopped: The stored Installation name breaks the Name rule: 1 to 200 characters, .*\\. \\(INSTALLATION_NAME_INVALID\\) No OCC writer was stopped; the old release keeps serving\\. Rename the Installation as in docs/guides/deploy/production-upgrade-recovery\\.md#correct-an-invalid-installation-name`,
          ),
        );
      }
      return true;
    });
    await assertStoppedBeforeWriters(f);
    const pod = JSON.parse(
      await readFile(join(f.evidence, `preflight-${component}-pod.json`), "utf8"),
    );
    assert.deepEqual(
      pod.spec.containers[0].env.find(
        (variable) => variable.name === "OCC_UPGRADE_PREFLIGHT_INSTALLATION_NAME",
      ),
      { name: "OCC_UPGRADE_PREFLIGHT_INSTALLATION_NAME", value: JSON.stringify(installationName) },
    );
  });
}

// An OCC that returns no stored name cannot be checked, so the upgrade stops while
// building the first preflight Pod, before it creates one or stops a writer.
test("an Installation read without a stored name stops before any preflight Pod", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    installationName: null,
    chart: { installation: (installation) => installation },
  });
  await assert.rejects(f.run(), (error) => {
    assert.match(
      error.stderr,
      /upgrade-startup-preflight: OCC did not return the stored Installation name\./,
    );
    assert.match(
      error.stderr,
      /cannot build the api startup preflight Pod from the rendered chart; no OCC writer was stopped\./,
    );
    return true;
  });
  // Only the NetworkPolicy and Secret were created, and both are removed again.
  const state = await assertStoppedBeforeWriters(f);
  assert.deepEqual(state.preflight.deleted.map((resource) => resource.split("/")[0]).sort(), [
    "networkpolicy.networking.k8s.io",
    "secret",
  ]);
});

// Releases with the shared tenant namespace refuse to start on a single-cluster
// Installation that still has split-layout Gateway storage. The startup preflight
// runs that Compute check with the selected image before quiescence, so the old
// release keeps serving and the operator is pointed at the documented options.
test("split-layout Gateway storage stops the startup preflight before any writer stops", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const namespaceId = "ns_split_00000000-0000-4000-8000-000000000001";
  const f = await fixture(t, {
    controllerOnly: true,
    chart: { installation: (installation) => installation },
    kubernetesNamespaces: [
      {
        metadata: {
          name: kubernetesGatewayNamespaceName(namespaceId),
          labels: { "openclaw.dev/gateway-namespace": namespaceId },
        },
      },
    ],
  });
  await assert.rejects(f.run(), (error) => {
    for (const component of ["api", "worker"]) {
      assert.match(
        error.stderr,
        new RegExp(
          `the ${component} startup preflight stopped: Kubernetes Compute startup preflight refused the candidate release: Existing split-layout Gateway storage prevents this single-cluster upgrade\\..* No OCC writer was stopped; the old release keeps serving\\. See docs/reference/drivers/kubernetes-compute\\.md#existing-split-layout-installations\\.`,
        ),
      );
    }
    return true;
  });
  // Each Pod read the Namespaces itself; nothing was stopped or migrated.
  assert.equal(f.kubernetesReads.filter((path) => path === "/api/v1/namespaces").length, 2);
  const state = await f.state();
  assert.equal(state.api, 1);
  assert.equal(state.worker, 1);
  assert.equal(state.version, 1);
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(state.preflight.secrets, {});
  assert.deepEqual(state.preflight.pods, {});
  assert.deepEqual(state.preflight.networkpolicies, {});
});

// A Kubernetes API the preflight Pod cannot use is not a refusal of the release:
// the helper says so, names the access the Pod had, and still stops first.
test("a denied Kubernetes API stops the startup preflight as incomplete", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: { installation: (installation) => installation },
    kubernetesDenied: true,
  });
  await assert.rejects(f.run(), (error) => {
    for (const component of ["api", "worker"]) {
      assert.match(
        error.stderr,
        new RegExp(
          `the ${component} startup preflight stopped: Kubernetes Compute startup preflight could not complete: .* No OCC writer was stopped; the old release keeps serving\\. The Pod uses the installed release's service account and RBAC`,
        ),
      );
    }
    assert.doesNotMatch(error.stderr, /refused the candidate release|split-layout/);
    return true;
  });
  const state = await f.state();
  assert.equal(state.version, 1);
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(state.preflight.pods, {});
  assert.deepEqual(state.preflight.networkpolicies, {});
});

// Two-cluster tenant grants in the execution stand-in. Both preflight Pods share
// one kubeconfig there, so a grant set is the union of the API and worker roles.
const tenantNamespaces = ["oce-unbound", "oce-tenant"].map((name) => ({
  metadata: { name, labels: { "openclaw.dev/namespace": `ns_${name}` } },
}));
const rule = (attributes) =>
  [
    attributes.group === "apps" ? "apps" : "core",
    attributes.verb,
    attributes.resource + (attributes.subresource ? `/${attributes.subresource}` : ""),
  ].join(" ");
// The openclaw-execution release-era tenant roles: API Deployment lists; worker Pod
// reads and proxy reads (plus writes the check never asks about).
const releaseTenantRules = [
  "apps list deployments",
  "core get pods",
  "core list pods",
  "core get pods/proxy",
];
const currentTenantRules = [
  ...releaseTenantRules,
  "core patch pods",
  "core get pods/log",
  "core get events",
  "core list events",
];
// oce-unbound has no tenant RoleBinding, so nothing is allowed there.
const tenantGrants = (rules) => (attributes) =>
  attributes.namespace === "oce-tenant" && rules.includes(rule(attributes));

// The execution chart is a separate Helm release that the helper does not upgrade.
// Each startup preflight Pod asks the execution cluster, as its own identity, for
// the tenant rules this release needs, so a chart left at the release-era grants
// stops the upgrade before any writer stops and names the documented step.
test("a two-cluster execution chart without the new tenant grants stops the startup preflight", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: { installation: (installation) => installation },
    executionCluster: { namespaces: tenantNamespaces, allows: tenantGrants(releaseTenantRules) },
  });
  await assert.rejects(f.run(), (error) => {
    for (const [component, missing] of [
      ["api", "get pods/log, get events, list events"],
      ["worker", "patch pods"],
    ]) {
      assert.match(
        error.stderr,
        new RegExp(
          `the ${component} startup preflight stopped: Kubernetes Compute startup preflight refused the candidate release: The execution cluster's tenant ${component} grant in Namespace oce-tenant lacks ${missing}\\. Upgrade the openclaw-execution chart before this release\\. No OCC writer was stopped; the old release keeps serving\\. Upgrade the execution release as in docs/testing/two-cluster-local\\.md#upgrade-the-execution-chart`,
        ),
      );
    }
    return true;
  });
  // The unbound tenant Namespace was skipped after its baseline review.
  assert.deepEqual(
    f.accessReviews
      .filter((review) => review.namespace === "oce-unbound")
      .map(rule)
      .sort(),
    ["apps list deployments", "core get pods"],
  );
  await assertStoppedBeforeWriters(f);
});

test("a two-cluster execution chart with the new tenant grants passes the startup preflight", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: { installation: (installation) => installation },
    executionCluster: { namespaces: tenantNamespaces, allows: tenantGrants(currentTenantRules) },
  });
  await f.run();
  assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
  // Each component asked for its own new rules in the bound tenant Namespace.
  assert.deepEqual(
    f.accessReviews
      .filter((review) => review.namespace === "oce-tenant")
      .map(rule)
      .sort(),
    [
      "apps list deployments",
      "core get events",
      "core get pods",
      "core get pods",
      "core get pods/log",
      "core get pods/proxy",
      "core list events",
      "core list pods",
      "core patch pods",
    ],
  );
  assert.ok(f.executionReads.includes("/api/v1/namespaces/kube-system"));
});

// An execution authorizer that cannot evaluate the reviews leaves the check incomplete:
// the helper says which kubeconfig and access the Pod needed, and still stops first.
test("an unevaluated two-cluster tenant grant review stops the startup preflight as incomplete", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: { installation: (installation) => installation },
    executionCluster: {
      namespaces: tenantNamespaces,
      allows: () => ({ allowed: false, evaluationError: "webhook authorizer unavailable" }),
    },
  });
  await assert.rejects(f.run(), (error) => {
    for (const component of ["api", "worker"]) {
      assert.match(
        error.stderr,
        new RegExp(
          `the ${component} startup preflight stopped: Kubernetes Compute startup preflight could not complete: The execution cluster tenant grant review failed: could not evaluate .* in Namespace oce-unbound: webhook authorizer unavailable No OCC writer was stopped; the old release keeps serving\\. The Pod used its execution cluster kubeconfig, which must list Namespaces and create SelfSubjectAccessReviews there`,
        ),
      );
    }
    assert.doesNotMatch(error.stderr, /refused the candidate release|openclaw-execution chart/);
    return true;
  });
  await assertStoppedBeforeWriters(f);
});

// With runtime logs off, the release's tenant API role carries no log or Event reads, so
// the preflight asks only for the rules that release needs.
test("a two-cluster upgrade with runtime logs off needs no log grants in the execution chart", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    chart: {
      installation: (installation) => installation,
      values: (values) => ({ ...values, agentRuntimeLogs: { enabled: false } }),
    },
    executionCluster: {
      namespaces: tenantNamespaces,
      allows: tenantGrants([...releaseTenantRules, "core patch pods"]),
    },
  });
  await f.run();
  assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
  assert.deepEqual(
    f.accessReviews
      .filter((review) => review.namespace === "oce-tenant")
      .map(rule)
      .sort(),
    [
      "apps list deployments",
      "core get pods",
      "core get pods",
      "core get pods/proxy",
      "core list pods",
      "core patch pods",
    ],
  );
});

// The helper waits for every preflight Pod and saves its status and log before it
// reports, so a refusal names each failing component, not only the first.
test("a failed startup preflight reports and saves every component before cleanup", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightResults: {
      api: {
        status: {
          phase: "Pending",
          containerStatuses: [{ name: "api", state: { waiting: { reason: "ImagePullBackOff" } } }],
        },
      },
      worker: { phase: "Failed", log: "loading drivers\nworker cannot load the Installation\n" },
    },
  });
  await assert.rejects(f.run(), (error) => {
    assert.match(
      error.stderr,
      /the api startup preflight Pod cannot start \(ImagePullBackOff\); no OCC writer was stopped\./,
    );
    assert.match(
      error.stderr,
      /cannot start the worker with the candidate Installation: loading drivers worker cannot load the Installation No OCC writer was stopped/,
    );
    return true;
  });
  const status = JSON.parse(await readFile(join(f.evidence, "preflight-api-status.json"), "utf8"));
  assert.equal(status.status.containerStatuses[0].state.waiting.reason, "ImagePullBackOff");
  assert.match(await readFile(join(f.evidence, "preflight-api.log"), "utf8"), /waiting to start/);
  assert.equal(
    JSON.parse(await readFile(join(f.evidence, "preflight-worker-status.json"), "utf8")).status
      .phase,
    "Failed",
  );
  assert.equal(
    await readFile(join(f.evidence, "preflight-worker.log"), "utf8"),
    "loading drivers\nworker cannot load the Installation\n",
  );
  const state = await f.state();
  assert.equal(state.api, 1);
  assert.equal(state.worker, 1);
  assert.equal(state.version, 1);
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(state.preflight.secrets, {});
  assert.deepEqual(state.preflight.pods, {});
  assert.deepEqual(state.preflight.deleted.map((resource) => resource.split("/")[0]).sort(), [
    "pod",
    "pod",
    "secret",
  ]);
});

test("a preflight Pod that outlives the timeout does not hide another component's failure", async (t) => {
  const f = await fixture(t, {
    controllerOnly: true,
    preflightResults: {
      api: {
        status: {
          phase: "Pending",
          conditions: [
            {
              type: "PodScheduled",
              status: "False",
              reason: "Unschedulable",
              message: "0/3 nodes are available",
            },
          ],
        },
      },
      worker: { phase: "Failed", log: "worker cannot load the Installation\n" },
    },
  });
  await assert.rejects(f.run("--timeout-seconds", "3"), (error) => {
    assert.match(
      error.stderr,
      /the api startup preflight did not finish before the timeout \(Unschedulable: 0\/3 nodes are available\)/,
    );
    assert.match(error.stderr, /cannot start the worker with the candidate Installation/);
    return true;
  });
  assert.equal(
    await readFile(join(f.evidence, "preflight-worker.log"), "utf8"),
    "worker cannot load the Installation\n",
  );
  const state = await f.state();
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(state.preflight.secrets, {});
  assert.deepEqual(state.preflight.pods, {});
});

test("an Installation the selected controller image loads passes the preflight and upgrades", async (t) => {
  if (!realHelm) {
    t.skip("helm is unavailable to render the real chart");
    return;
  }
  const f = await fixture(t, {
    controllerOnly: true,
    // A 200-character name: if Kubernetes expanded $(OCC_CONFIG_PATH) in the Pod's
    // environment, the preflight would see a longer name and refuse it.
    installationName: `${"A".repeat(182)}$(OCC_CONFIG_PATH)`,
    chart: { installation: (installation) => installation },
  });
  await f.run();
  const state = await f.state();
  assert.equal(state.controller, newController);
  assert.deepEqual(await f.events(), ["scale-api", "scale-worker", "migration"]);
  assert.deepEqual(state.preflight.secrets, {});
  assert.deepEqual(state.preflight.pods, {});
  const pod = JSON.parse(await readFile(join(f.evidence, "preflight-worker-pod.json"), "utf8"));
  // The Pod runs the selected image with the chart's service account and Installation mount.
  assert.equal(pod.spec.containers[0].image, newController);
  assert.equal(pod.spec.serviceAccountName, "openclaw-enterprise-worker");
  assert.equal(
    pod.spec.volumes.find((volume) => volume.name === "installation-startup").secret.secretName,
    state.preflight.deleted
      .find((resource) => resource.startsWith("secret/"))
      .slice("secret/".length),
  );
  // Both Pods ran Kubernetes Compute preflight on this shared-layout state.
  for (const component of ["api", "worker"]) {
    const log = await readFile(join(f.evidence, `preflight-${component}.log`), "utf8");
    assert.match(log, /^kubernetes-compute-preflight-passed$/m);
    assert.match(log, /^installation-startup-ready$/m);
  }
  assert.equal(f.kubernetesReads.filter((path) => path === "/api/v1/namespaces").length, 2);
  // The chart's default-deny policy selects the preflight Pods too. The temporary
  // policy selects exactly them and grants the candidate's dependency egress.
  const policy = JSON.parse(
    await readFile(join(f.evidence, "preflight-networkpolicy.json"), "utf8"),
  );
  assert.deepEqual(policy.spec.podSelector.matchLabels, pod.metadata.labels);
  const rendered = (await readFile(join(f.evidence, "preflight-rendered.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    policy.spec.egress,
    rendered.find(
      (document) =>
        document?.kind === "NetworkPolicy" &&
        document.metadata.name === "openclaw-enterprise-dependency-egress",
    ).spec.egress,
  );
  assert.deepEqual(state.preflight.networkpolicies, {});
  assert.ok(
    state.preflight.deleted.includes(`networkpolicy.networking.k8s.io/${policy.metadata.name}`),
  );
});
