import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { createQaInstallation, prepareQaPreset, createQaAgent } from "./qa-installation.mjs";
import { installPublicGithubReadFixture } from "./public-github-read-k3d.mjs";
import { assertGatewayModelTurn } from "./kubernetes-real.mjs";
import { stopQaAgent } from "./qa-repository.mjs";
import { loadYaml } from "./qa-utils.mjs";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { protectedModelApiKey, redactQaError } from "./qa-secrets.mjs";

const supervisor =
  "ghcr.io/nvidia/openshell/supervisor:0.1.6@sha256:ce859a7d77ee515d3fe0b3c7dc61286516f402eb1d25c761d806d9ae5ed96c0b";
const url = "https://github.com/octocat/Hello-World.git";

async function verifyReaderSource(f) {
  const names = ["server.ts", "access.ts", "git.ts", "transport.mjs"];
  const expected = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        createHash("sha256")
          .update(
            await readFile(
              new URL(
                `../../apps/controller/src/drivers/repo/github/public-read/${name}`,
                import.meta.url,
              ),
            ),
          )
          .digest("hex"),
      ]),
    ),
  );
  const probe = String.raw`
const fs=require("node:fs"),crypto=require("node:crypto");
const names=JSON.parse(process.argv[1]);
const html=fs.readFileSync("/app/apps/controller/src/console/index.html","utf8");
console.log(JSON.stringify({node:process.version,buildRevision:/name="occ-build-revision" content="([a-f0-9]*)"/.exec(html)?.[1]??null,files:Object.fromEntries(names.map(name=>[name,crypto.createHash("sha256").update(fs.readFileSync("/app/apps/controller/src/drivers/repo/github/public-read/"+name)).digest("hex")]))}));
`;
  const provenance = JSON.parse(
    await f.run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--entrypoint",
      "node",
      f.importedControllerImageId,
      "-e",
      probe,
      JSON.stringify(names),
    ]),
  );
  assert.deepEqual(
    provenance.files,
    expected,
    "selected reader image must match the checked-out reader source",
  );
  await f.record("public-git-reader-source", {
    imageId: f.importedControllerImageId,
    ...provenance,
    sourceVerification: "Reader source files compared directly against the checkout",
  });
}

// Keep the app-server credential inside its existing Gateway. Commands enter
// the stock Codex executor with the provider-selected contract used by Agent tools.
const nativeCommandScript = String.raw`
${PLUGIN_RUNTIME_HELPERS}
(async () => {
const peer = await readPeerPluginRuntimeStatus();
if (peer === undefined) throw new Error("Native peer status is required.");
process.env.APP_SERVER_TOKEN = derivePluginAppServerToken(peer.startupId);
const args = JSON.parse(process.argv[2]);
const permissionProfile = process.env.OPENCLAW_CODEX_PROVIDER_PERMISSION_PROFILE;
const cwd = process.env.OPENCLAW_REMOTE_WORKSPACE_ROOT;
if (typeof permissionProfile !== "string" || !permissionProfile || typeof cwd !== "string" || !cwd.startsWith("/")) throw new Error("Provider execution contract is required.");
const WebSocket = require("node:module").createRequire("/app/package.json")("ws");
const socket = new WebSocket(process.env.APP_SERVER_URL, { headers: { authorization: "Bearer " + process.env.APP_SERVER_TOKEN } });
const timer = setTimeout(() => { socket.terminate(); process.exitCode = 1; }, 90000);
function finish(result) { clearTimeout(timer); socket.close(); process.stdout.write(JSON.stringify({ ...result, providerPermissionProfile: permissionProfile, workspaceRoot: cwd })); }
socket.on("error", () => { clearTimeout(timer); process.exitCode = 1; });
socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "oce-public-git-qa", version: "1" }, capabilities: { experimentalApi: true } } })));
socket.on("message", data => {
  const message = JSON.parse(data.toString());
  if (message.error) { finish({ error: true, code: message.error.code }); return; }
  if (message.id === 1) {
    socket.send(JSON.stringify({ method: "initialized" }));
    socket.send(JSON.stringify({ id: 2, method: "command/exec", params: { command: args, cwd, timeoutMs: 45000, permissionProfile } }));
  } else if (message.id === 2) { finish(message.result); }
});
})().catch(() => { process.stderr.write("Native peer authentication failed.\n"); process.exitCode = 1; });
`;

// The stock supervisor loads native system roots. Add only this journey's
// public reader CA, preserving its binary and certificate verification.
async function trustReader(f, ca) {
  const peer = f.configuration.drivers.compute.configuration.network.providerHarness;
  const namespace = peer?.namespace;
  const release = peer?.podLabels?.["app.kubernetes.io/instance"];
  assert.match(namespace ?? "", /^[a-z0-9][a-z0-9-]*$/);
  assert.match(release ?? "", /^[a-z0-9][a-z0-9-]*$/);
  const directory = join(f.directory, "supervisor-ca");
  await f.run("mkdir", ["-p", directory]);
  const name = `oce-qa-supervisor-${f.suffix}`;
  const image = `localhost/oce-qa-supervisor:${f.suffix}`;
  await f.run("docker", ["create", "--name", name, supervisor]);
  try {
    await f.run("docker", [
      "cp",
      `${name}:/etc/ssl/certs/ca-certificates.crt`,
      join(directory, "roots.pem"),
    ]);
  } finally {
    await f.run("docker", ["rm", name]);
  }
  // Container copies preserve a read-only stock bundle; make only this staging
  // copy writable before appending the public reader certificate.
  await chmod(join(directory, "roots.pem"), 0o600);
  await writeFile(
    join(directory, "roots.pem"),
    (await readFile(join(directory, "roots.pem"), "utf8")) + "\n" + ca,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "Dockerfile"),
    `FROM ${supervisor}\nCOPY --chmod=0644 roots.pem /etc/ssl/certs/ca-certificates.crt\n`,
    { mode: 0o600 },
  );
  await f.run("docker", ["build", "--network=none", "-t", image, directory]);
  f.resources.after(() => f.run("docker", ["image", "rm", image]));
  const archive = join(directory, "image.tar");
  await f.run("docker", ["save", "-o", archive, image]);
  try {
    await f.run("k3d", ["image", "import", "--mode", "direct", archive, "-c", f.cluster]);
  } finally {
    await rm(archive, { force: true });
  }
  const node = `k3d-${f.cluster}-server-0`;
  const list = await f.run("docker", ["exec", node, "ctr", "-n", "k8s.io", "images", "list"]);
  const digest = list
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([ref]) => ref === image)?.[2];
  assert.match(digest ?? "", /^sha256:[a-f0-9]{64}$/);
  await f.run("docker", [
    "exec",
    node,
    "ctr",
    "-n",
    "k8s.io",
    "images",
    "tag",
    image,
    `localhost/oce-qa-supervisor@${digest}`,
  ]);
  const files = await readdir(join(f.stateDirectory, "openshell"), { recursive: true });
  let chart;
  for (const file of files.filter((candidate) => candidate.endsWith(".tgz"))) {
    const metadata = loadYaml(
      await f.run("helm", ["show", "chart", join(f.stateDirectory, "openshell", file)]),
    );
    if (metadata.name === "helm-chart" && metadata.version === "0.1.6") {
      chart = file;
      break;
    }
  }
  assert.ok(chart, "the launcher must retain its verified pinned OpenShell chart");
  await f.run("helm", [
    "upgrade",
    release,
    join(f.stateDirectory, "openshell", chart),
    "--namespace",
    namespace,
    "--kubeconfig",
    join(f.stateDirectory, "kubeconfig"),
    "--kube-context",
    `k3d-${f.cluster}`,
    "--reuse-values",
    "--set-string",
    "supervisor.image.registry=localhost",
    "--set-string",
    "supervisor.image.repository=oce-qa-supervisor",
    "--set-string",
    `supervisor.image.tag=${f.suffix}`,
    "--set-string",
    `supervisor.image.digest=${digest}`,
    "--wait",
    "--timeout",
    "180s",
  ]);
  await f.record("public-git-supervisor", {
    stock: supervisor,
    namespace,
    release,
    chart,
    image,
    digest,
    change: "Public reader CA appended to system roots; stock binary unchanged",
  });
}

// Route only the owned controller/worker network namespaces to their k3d
// Service network. No host/VM route or Agent privilege changes are needed.
async function routeReader(f, address) {
  const node = `k3d-${f.cluster}-server-0`;
  const inspected = JSON.parse(await f.run("docker", ["inspect", node]))[0];
  const networks = inspected.NetworkSettings.Networks;
  const controllerPeers = [];
  for (const service of ["controller", "worker-kubernetes"]) {
    const id = (await f.compose("ps", "-q", service)).trim();
    const owned = JSON.parse(await f.run("docker", ["inspect", id]))[0];
    const network = Object.keys(networks).find((key) => owned.NetworkSettings.Networks[key]);
    assert.ok(network, "owned controller and k3d must share their private network");
    controllerPeers.push({
      ipBlock: { cidr: owned.NetworkSettings.Networks[network].IPAddress + "/32" },
    });
    await f.run("docker", [
      "run",
      "--rm",
      "--network",
      `container:${id}`,
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_ADMIN",
      "--entrypoint",
      "/bin/sh",
      f.state.k3sImage ??
        "docker.io/rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657",
      "-c",
      'ip route replace "$1/32" via "$2"',
      "route",
      address,
      networks[network].IPAddress,
    ]);
  }
  await f.apply({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "qa-compose-reader-clients", namespace: `qa-reader-${f.suffix}` },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/component": "public-github-read" } },
      policyTypes: ["Ingress"],
      ingress: [{ from: controllerPeers, ports: [{ protocol: "TCP", port: 8080 }] }],
    },
  });
}

export async function verifyQaPublicGithubGit(context, artifacts) {
  const f = await createQaInstallation(context, "compose", artifacts, {
    repositoryInputs: false,
    sandboxDriver: "openshell",
  });
  try {
    await verifyReaderSource(f);
    await prepareQaPreset(f, "Codex");
    await f.apply({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: `qa-reader-${f.suffix}` },
    });
    const reader = await installPublicGithubReadFixture({
      namespace: `qa-reader-${f.suffix}`,
      installationId: f.installation.id,
      controllerImage: f.controllerChartImage,
      kubectl: (...args) => f.kubectl(...args),
      applyManifest: (manifest) => f.apply(JSON.parse(manifest)),
      waitFor: f.waitFor,
      liveGithub: true,
      policy: {
        mode: "repositories",
        repositories: ["octocat/hello-world", "octocat/spoon-knife"],
      },
    });
    await trustReader(f, reader.peer.caBundle);
    f.afterSaveInstallation = () => routeReader(f, reader.peer.address);
    const compute = f.configuration.drivers.compute.configuration;
    compute.network.publicGithubRead = reader.peer;
    compute.runtime.codexModelBaseUrl = process.env.OCC_TEST_QA_CODEX_MODEL_BASE_URL;
    // This public-only service scope admits no ambient artifact destinations.
    f.configuration.drivers.sandbox.configuration.policy.codexArtifactRuleNames = [];
    await f.saveInstallation(f.configuration);
    const first = await createQaAgent(f, "Codex", undefined, "-public-git-all", {
      apiKeyAuth: true,
      configureValues: (values) => {
        values.plugins.entries.codex.config.appServer.networkProxy.domains = {
          [reader.peer.address]: "allow",
        };
      },
    });
    let commandIndex = 0;
    const executeCommand = async (agent, args) => {
      const gateway = await f.pod(agent, "gateway");
      const observed = await f.run(
        "kubectl",
        [
          "--kubeconfig",
          join(f.stateDirectory, "kubeconfig"),
          "--context",
          `k3d-${f.cluster}`,
          "exec",
          "-i",
          "--namespace",
          gateway.metadata.namespace,
          gateway.metadata.name,
          "-c",
          "gateway",
          "--",
          "node",
          "-",
          JSON.stringify(args),
        ],
        { input: nativeCommandScript, privateFailureOutput: true },
      );
      const result = JSON.parse(observed);
      await f.write(`native-git-${randomUUID()}.json`, result);
      assert.equal(result.error, undefined, "native command execution must be supported");
      assert.ok(Number.isInteger(result.exitCode), "native command must finish");
      await f.record(`public-git-command-${++commandIndex}`, {
        agentId: agent.id,
        revisionId: agent.revision.id,
        args,
        providerPermissionProfile: result.providerPermissionProfile,
        workspaceRoot: result.workspaceRoot,
        exitCode: result.exitCode,
      });
      return result;
    };
    const git = async (agent, ...args) => {
      const result = await executeCommand(agent, ["git", ...args]);
      assert.equal(result.exitCode, 0, "native Git command must succeed");
      return result.stdout.trim();
    };
    const denied = async (agent, ...args) => {
      const result = await executeCommand(agent, ["git", ...args]);
      assert.notEqual(result.exitCode, 0, "native Git must reject the unauthorized operation");
    };
    assert.match(
      await git(first, "--version"),
      /^git version /,
      "native execution must work before a denial can count",
    );
    // No Agent opt-in: ordinary GitHub access must fail under default deny.
    await denied(first, "ls-remote", url);
    async function select(agent, policy) {
      const values = structuredClone(agent.configuration.values);
      values.plugins.entries.codex.config.publicGithubRead = policy;
      values.plugins.entries.codex.config.appServer.networkProxy = {
        enabled: true,
        mode: "limited",
        allowLocalBinding: false,
        domains: { [reader.peer.address]: "allow" },
      };
      await f.api(
        "PATCH",
        `/namespaces/${agent.namespaceId}/configurations/${agent.configuration.id}`,
        { values },
      );
      agent.configuration.values = values;
      await f.deployAndWait(agent);
      assert.equal(agent.revision.executionAdmission.mode, "protected");
      assert.ok(
        agent.revision.compute.serviceAccess.some((service) => service.id === "public-github-read"),
      );
      const pod = await f.pod(agent, "agent");
      assert.ok(
        pod.metadata.ownerReferences.some((owner) => owner.kind === "Sandbox"),
        "native OpenShell owns the Harness",
      );
    }
    await select(first, { mode: "all" });
    const skill = await executeCommand(first, [
      "node",
      "-e",
      "const fs=require('node:fs');const text=fs.readFileSync('/home/node/.openclaw/skills/public-github-read/SKILL.md','utf8');console.log(JSON.stringify({node:fs.realpathSync(process.execPath),managedSkill:text.includes('name: public-github-read')&&text.includes('curl -q')}));",
    ]);
    assert.equal(
      skill.exitCode,
      0,
      "managed public-read skill must be discoverable in the native shell",
    );
    const nativePaths = JSON.parse(skill.stdout);
    assert.equal(nativePaths.managedSkill, true);
    const api = await executeCommand(first, [
      "/bin/sh",
      "-eu",
      "-c",
      'command -v curl >&2; curl -q -sS --noproxy "" --fail-with-body --cacert "$OCE_PUBLIC_GITHUB_READ_CA_FILE" -H "Authorization: Bearer $OCE_PUBLIC_GITHUB_READ_CAPABILITY" "$1/repos/octocat/Hello-World/contents"',
      "public-github-api",
      `https://${reader.peer.address}:8080`,
    ]);
    assert.equal(
      api.exitCode,
      0,
      "the managed skill's verified API read must succeed through the native proxy",
    );
    assert.ok(
      JSON.parse(api.stdout).some((entry) => entry.type === "file" && entry.name === "README"),
    );
    await f.record("public-git-native-api", {
      node: nativePaths.node,
      curl: api.stderr.trim().split("\n")[0],
      managedSkill: true,
      knownReadme: true,
    });

    const clone = `public-git-${randomUUID()}`;
    await git(first, "clone", "--depth=1", url, clone);
    assert.equal(await git(first, "-C", clone, "rev-parse", "--is-shallow-repository"), "true");
    const before = Number(await git(first, "-C", clone, "rev-list", "--count", "HEAD"));
    await git(first, "-C", clone, "fetch", "--unshallow", "origin");
    const after = Number(await git(first, "-C", clone, "rev-list", "--count", "HEAD"));
    assert.ok(after > before, "fetch must deliver additional commit objects");
    assert.equal(await git(first, "-C", clone, "remote", "get-url", "origin"), url);
    await denied(first, "ls-remote", "https://github.com/github/gitignore.git");
    await denied(first, "-C", clone, "push", "origin", "HEAD:refs/heads/oce-qa-forbidden");
    await denied(first, "ls-remote", "https://github.com/unavailable-oce-qa/nonexistent.git");
    await denied(first, "ls-remote", "https://github.com.evil.invalid/octocat/Hello-World.git");
    const gateway = await f.gatewayUrl(first);
    try {
      await assertGatewayModelTurn({
        gatewayUrl: gateway.url,
        gatewayPassword: gateway.gatewayPassword,
        nonce: `PUBLIC_GIT_${randomUUID()}`,
        secrets: [await protectedModelApiKey()],
      });
    } finally {
      await gateway.close();
    }
    const second = await createQaAgent(f, "Codex", undefined, "-public-git-list", {
      apiKeyAuth: true,
    });
    await select(second, { mode: "repositories", repositories: ["octocat/spoon-knife"] });
    await denied(second, "ls-remote", url);
    await git(second, "ls-remote", "https://github.com/octocat/Spoon-Knife.git");
    const previous = first.revision.id;
    await select(first, { mode: "repositories", repositories: ["octocat/hello-world"] });
    assert.notEqual(first.revision.id, previous);
    await git(first, "ls-remote", url);
    // Restart only shipping control-plane processes; persisted revision material
    // must permit ordinary recovery without a test-written capability.
    await f.compose("restart", "controller", "worker-kubernetes");
    await f.kubectl(
      "rollout",
      "restart",
      "deployment/openclaw-enterprise-public-github-read",
      "--namespace",
      reader.peer.namespace,
    );
    await f.kubectl(
      "rollout",
      "status",
      "deployment/openclaw-enterprise-public-github-read",
      "--namespace",
      reader.peer.namespace,
      "--timeout=120s",
    );
    await routeReader(f, reader.peer.address);
    await f.waitFor("recovered public Git revision", async () => {
      try {
        await git(first, "ls-remote", url);
        return true;
      } catch {
        return false;
      }
    });
    await stopQaAgent(f, first);
    const registry = JSON.parse(
      (await f.resource("configmap", reader.peer.authorizationConfigMapName, reader.peer.namespace))
        .data["authorizations.json"],
    );
    assert.equal(Date.parse(registry[first.revision.id].validUntil), 0);
    assert.ok(Date.parse(registry[second.revision.id].validUntil) > Date.now());
    await git(second, "ls-remote", "https://github.com/octocat/Spoon-Knife.git");
    await stopQaAgent(f, second);
    const evidence = await f.record("public-github-git", {
      provider: "live anonymous github.com",
      model: process.env.OCC_TEST_QA_CODEX_MODEL,
      before,
      after,
      unchangedUrl: url,
      defaultDeny: true,
      managedSkillApiRead: true,
      ceilingIntersection: true,
      separateAgentScopes: true,
      writesDenied: true,
      forgedOriginsDenied: true,
      replacement: true,
      controllerRestart: true,
      readerColdRestart: true,
      withdrawalIsolation: true,
      gaps: [
        "Known private repository live-provider proof",
        "Protected repository read/write coexistence",
        "Ten-minute expiry isolation",
      ],
    });
    return {
      evidence,
      outcome: "native Git public clone/fetch and real model turn through shipping OCE/OpenShell",
    };
  } catch (error) {
    throw redactQaError(error);
  }
}
