#!/usr/bin/env node
/**
 * Installed acceptance of the OpenShell request-phase Git route (opt-in, advisory).
 *
 * `occ dev up` with OCC_DEVELOPMENT_OPENSHELL_GIT=1 installs stock OpenShell 0.1.4 with native
 * PKI, the OCE worker's `oce-prepared-git` middleware and its Gateway registration. This script
 * answers github.com and api.github.com from the synthetic private Git origin and api.openai.com
 * from the stand-in model, both on one fixture network, then drives one dedicated Codex Agent's
 * OpenShell Sandbox through the Gateway's ExecSandbox: clone, push of the review ref, a draft
 * pull request through the image's helper, one refused push, and withdrawal of the binding.
 * The origin's own witness confirms each effect. Only synthetic credentials exist here.
 *
 * Needs the images `node scripts/ci/first-agent-smoke.mjs prepared-git-images` exports, Docker
 * 28 or newer and a kernel with Landlock ABI v3 (Linux 6.2+). Prints phase timings.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import { kubectl, run, waitFor, workDirectory } from "./first-agent-smoke.mjs";

const env = process.env;
const lane = "openshell-git-installed";
const minute = 60_000;
const root = resolve(import.meta.dirname, "../..");
const occ = join(root, "bin", "occ");
const started = Date.now();
const timings = [];
const proof = [];
const progress = (message) => console.log(`OpenShell Git acceptance: ${message}`);
const output = async (command, args, options) => (await run(command, args, options)).stdout.trim();

const sourceCommit = await output("git", ["rev-parse", "HEAD"]);
const id = createHash("sha256")
  .update(
    sourceCommit + ":" + (env.GITHUB_RUN_ID ?? "local") + ":" + randomBytes(8).toString("hex"),
  )
  .digest("hex")
  .slice(0, 10);
const cluster = "occ-dev-osgit-" + id;
const directory = join(workDirectory, cluster);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const runtimeImage = env.OCC_KUBERNETES_RUNTIME_IMAGE;
const modelDirectory = env.OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY;
for (const name of [
  "OCC_DEVELOPMENT_CONTROLLER_IMAGE",
  "OCC_KUBERNETES_RUNTIME_IMAGE",
  "OCC_DEVELOPMENT_REPOSITORY_IMAGE",
  "OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY",
]) {
  assert.ok(env[name], `${name} is required: run first-agent-smoke.mjs prepared-git-images`);
}

// A dedicated network whose addresses OpenShell does not classify as internal: the Sandbox
// boundary refuses private, loopback and special-use upstreams. Containers take their fixed
// addresses before occ dev up attaches the node, which Docker then gives a free one.
const fixture = {
  network: "oce-openshell-git-fixture-" + id,
  subnet: "11.113.0.0/29",
  origin: "11.113.0.2",
  model: "11.113.0.3",
  originContainer: "oce-openshell-git-origin-" + id,
  modelContainer: "oce-openshell-git-model-" + id,
};
const repository = "fixture/openshell-git-" + id;
const reviewBranch = "review/openshell-git-" + id;
const approvalRef = "refs/heads/" + reviewBranch;
const ports = { kubernetes: 6443, api: 3000, browser: 8443 };

const cleanup = [];
async function phase(name, operation) {
  const begin = Date.now();
  progress(`${name}...`);
  try {
    const result = await operation();
    timings.push({ phase: name, seconds: Math.round((Date.now() - begin) / 1000) });
    progress(`${name}: ok (${Math.round((Date.now() - begin) / 1000)}s)`);
    return result;
  } catch (error) {
    timings.push({ phase: name, seconds: Math.round((Date.now() - begin) / 1000), failed: true });
    error.phase ??= name;
    throw error;
  }
}
const record = (name) => {
  proof.push(name);
  progress(`proved ${name}`);
};

async function writePrivate(name, value) {
  const path = join(directory, name);
  await writeFile(path, value, { mode: 0o600, flag: "wx" });
  return path;
}

// One CA signs the origin's github.com/api.github.com leaf. The worker trusts it as the
// prepared Git issuer CA; the supervisor trusts it (and the model CA) through the derived image.
async function createOriginPki() {
  const pki = join(directory, "pki");
  await mkdir(pki, { mode: 0o755 });
  const file = (name) => join(pki, name);
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:3072",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=oce-openshell-git-acceptance-ca",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    file("ca-key.pem"),
    "-out",
    file("ca.pem"),
  ]);
  await run("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=github.com",
    "-keyout",
    file("github-key.pem"),
    "-out",
    file("github.csr"),
  ]);
  await writeFile(
    file("github.ext"),
    "subjectAltName=DNS:github.com,DNS:api.github.com\nbasicConstraints=critical,CA:FALSE\n" +
      "extendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n",
  );
  await run("openssl", [
    "x509",
    "-req",
    "-in",
    file("github.csr"),
    "-CA",
    file("ca.pem"),
    "-CAkey",
    file("ca-key.pem"),
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    file("github.ext"),
    "-out",
    file("github.pem"),
  ]);
  await rm(file("ca-key.pem"));
  // The origin container runs as this user; nothing else reads the leaf key.
  await chmod(file("github-key.pem"), 0o600);
  return pki;
}

async function startFixtures(pki) {
  await run("docker", ["network", "create", "--subnet", fixture.subnet, fixture.network]);
  cleanup.push(() => run("docker", ["network", "rm", fixture.network]));
  const out = join(directory, "origin");
  await mkdir(out, { mode: 0o700 });
  const user = `${process.getuid()}:${process.getgid()}`;
  await run("docker", [
    "run",
    "--detach",
    "--name",
    fixture.originContainer,
    "--network",
    fixture.network,
    "--ip",
    fixture.origin,
    "--user",
    user,
    "--sysctl",
    "net.ipv4.ip_unprivileged_port_start=0",
    "--volume",
    `${root}:/oce:ro`,
    "--volume",
    `${pki}:/pki:ro`,
    "--volume",
    `${out}:/out`,
    "--env",
    `OCE_FIXTURE_REPOSITORY=${repository}`,
    "--env",
    `OCE_FIXTURE_APPROVAL_REF=${approvalRef}`,
    "--entrypoint",
    "node",
    runtimeImage,
    "/oce/scripts/ci/openshell-git-origin.mjs",
    "/pki",
    "/out",
  ]);
  cleanup.push(() => run("docker", ["rm", "--force", fixture.originContainer]));
  await run("docker", [
    "run",
    "--detach",
    "--name",
    fixture.modelContainer,
    "--network",
    fixture.network,
    "--ip",
    fixture.model,
    "--sysctl",
    "net.ipv4.ip_unprivileged_port_start=0",
    "--volume",
    `${modelDirectory}:/fixture:ro`,
    "--env",
    "PROBE_ENDPOINT_MODE=answer",
    "--env",
    "PROBE_ENDPOINT_HOST=0.0.0.0",
    "--entrypoint",
    "node",
    runtimeImage,
    "/fixture/endpoint.mjs",
  ]);
  cleanup.push(() => run("docker", ["rm", "--force", fixture.modelContainer]));
  const originFile = join(out, "origin.json");
  const origin = await waitFor(
    "the synthetic origin to listen",
    async () => {
      const value = await readFile(originFile, "utf8").catch(() => undefined);
      return { done: value !== undefined, value: value && JSON.parse(value) };
    },
    2 * minute,
  );
  return { ...origin, privateKey: await readFile(join(out, "private-key.pem"), "utf8") };
}

async function witness(path) {
  const response = await fetch(`http://${fixture.origin}:8080${path}`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `witness ${path}`);
  return response.json();
}

async function repositoryInputs(pki, origin) {
  const inputs = join(directory, "repository-inputs");
  await mkdir(inputs, { mode: 0o700 });
  const registry = {
    version: 1,
    backendId: "openshell-git-acceptance",
    providerInstanceId: "fixture",
    appId: origin.appId,
    githubInstallationId: origin.installationId,
    maximumDurationSeconds: 3600,
    repositories: [
      {
        repositoryRef: origin.repositoryRef,
        repository,
        repositoryId: origin.repositoryId,
        namespaces: [
          {
            namespaceId: "${OCC_INITIAL_NAMESPACE_ID}",
            profiles: ["git-write"],
            pushRefAllowlist: [approvalRef],
            transport: "git-and-draft-pr",
            pullRequestBase: "main",
          },
        ],
      },
    ],
  };
  for (const [name, value] of Object.entries({
    "registry.json": JSON.stringify(registry),
    "upstream-cidrs.json": JSON.stringify([fixture.origin + "/32"]),
    "private-key.pem": origin.privateKey,
    "issuer-ca.crt": await readFile(join(pki, "ca.pem"), "utf8"),
  })) {
    await writeFile(join(inputs, name), value, { mode: 0o600, flag: "wx" });
  }
  return inputs;
}

async function developmentUp(pki, inputs) {
  const supervisorCA = await writePrivate(
    "supervisor-ca.pem",
    (await readFile(join(pki, "ca.pem"), "utf8")) +
      (await readFile(join(modelDirectory, "ca.pem"), "utf8")),
  );
  // The route replaces the default source-control policy; the Driver needs at least one.
  const policies = await writePrivate(
    "sandbox-network-policies.yaml",
    "networkPolicies:\n  - name: example-fetch\n    binaries:\n      - path: /usr/bin/curl\n" +
      "    endpoints:\n      - host: example.com\n        ports: [443]\n",
  );
  const install = {
    ...env,
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
    OCC_DEVELOPMENT_CONTROL_PLANE: "kubernetes",
    OCC_DEVELOPMENT_SANDBOX_DRIVER: "openshell",
    OCC_DEVELOPMENT_PROTECTED_EGRESS: "0",
    OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker",
    OCC_DEVELOPMENT_KUBERNETES_API_PORT: String(ports.kubernetes),
    OPENCLAW_DEV_PORT: String(ports.api),
    OCC_DEVELOPMENT_BROWSER_PORT: String(ports.browser),
    OCC_DEVELOPMENT_KUBERNETES_CLUSTER: cluster,
    OCC_DEVELOPMENT_STATE_DIRECTORY: join(directory, "local-setup"),
    OCC_DEVELOPMENT_STARTUP_TIMEOUT_SECONDS: "1200",
    OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY: inputs,
    OCC_DEVELOPMENT_OPENSHELL_GIT: "1",
    OCC_DEVELOPMENT_OPENSHELL_GIT_FIXTURE_NETWORK: fixture.network,
    OCC_DEVELOPMENT_OPENSHELL_SUPERVISOR_CA_FILE: supervisorCA,
  };
  delete install.OPENAI_API_KEY;
  delete install.OCC_DEVELOPMENT_PREPARED_GIT_PROVIDER_ORIGIN;
  // occ dev down removes the cluster even when dev up failed half way; a dev up refused
  // before it wrote any state left nothing to remove.
  cleanup.push(async () => {
    if (
      await stat(install.OCC_DEVELOPMENT_STATE_DIRECTORY).then(
        () => true,
        () => false,
      )
    ) {
      await run(occ, ["dev", "down"], { env: install, timeout: 12 * minute });
    }
    const names = await output("docker", ["ps", "-a", "--format", "{{.Names}}"]);
    assert.ok(!names.split("\n").some((name) => name.startsWith(`k3d-${cluster}-`)));
  });
  await run(occ, ["dev", "up", "--sandbox-network-policy-file", policies], {
    env: install,
    timeout: 30 * minute,
    label: env.OCC_OPENSHELL_GIT_ACCEPTANCE_VERBOSE === "1" ? "dev-up" : undefined,
  });
  const stateDirectory = install.OCC_DEVELOPMENT_STATE_DIRECTORY;
  const state = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
  assert.equal(state.cluster, cluster);
  assert.equal(state.sandboxDriver, "openshell");
  assert.equal(state.openShellGit, true);
  assert.ok(!state.protectedEgress);
  const key = JSON.parse(await readFile(state.keyPath, "utf8")).data.key;
  return {
    state,
    keyPath: state.keyPath,
    kubeconfig: join(stateDirectory, "kubeconfig"),
    context: `k3d-${cluster}`,
    origin: `http://127.0.0.1:${state.apiPort}`,
    key,
  };
}

async function api(stack, method, path, body) {
  const response = await fetch(new URL(path, stack.origin), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "x-api-key": stack.key,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const envelope = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(envelope.error)}`);
  }
  return envelope.data;
}

async function cli(stack, args, file) {
  const path =
    file === undefined ? [] : ["--file", await writePrivate(file.name, JSON.stringify(file.value))];
  const result = await run(occ, [...args, ...path, "-o", "json"], {
    env: {
      ...env,
      OCC_URL: stack.origin,
      OCC_SERVICE_KEY_FILE: stack.keyPath,
      OCC_NAMESPACE: stack.namespaceId,
    },
    timeout: 2 * minute,
  });
  return JSON.parse(result.stdout);
}

// The stand-in model answers api.openai.com. Merge, never replace: occ dev up's
// coredns-custom key pins the GitHub hosts to the origin.
async function routeModel(stack) {
  const server = `api.openai.com:53 {\n    hosts {\n        ${fixture.model} api.openai.com\n    }\n}\n`;
  await kubectl(stack, [
    "-n",
    "kube-system",
    "patch",
    "configmap",
    "coredns-custom",
    "--type",
    "merge",
    "-p",
    JSON.stringify({ data: { "oce-openshell-git-model.server": server } }),
  ]);
  const data = JSON.parse(
    await output("kubectl", [
      "--kubeconfig",
      stack.kubeconfig,
      "--context",
      stack.context,
      "-n",
      "kube-system",
      "get",
      "configmap",
      "coredns-custom",
      "-o",
      "jsonpath={.data}",
    ]),
  );
  assert.ok(data["occ-openshell-git.server"]?.includes(fixture.origin));
  await kubectl(stack, ["-n", "kube-system", "rollout", "restart", "deployment/coredns"]);
  await kubectl(stack, [
    "-n",
    "kube-system",
    "rollout",
    "status",
    "deployment/coredns",
    "--timeout=180s",
  ]);
  // The development API proxy resolves Services per connection; wait until it answers again.
  await waitFor(
    "the API after the resolver restart",
    async () => ({
      done: await api(stack, "GET", "/namespaces").then(
        () => true,
        () => false,
      ),
    }),
    3 * minute,
  );
}

async function createAgent(stack, origin) {
  const namespaces = await api(stack, "GET", "/namespaces");
  const ready = namespaces.filter((n) => n.name === "default" && n.status === "ready");
  assert.equal(ready.length, 1);
  stack.namespaceId = ready[0].id;
  const secret = await cli(stack, ["secret", "create"], {
    name: "model-secret.json",
    value: {
      name: "openshell-git-model",
      value: "sk-oce-acceptance-" + randomBytes(12).toString("hex"),
    },
  });
  const source = await cli(stack, ["credential-source", "create"], {
    name: "credential-source.json",
    value: { name: "openai", type: "openai", config: {}, secrets: { api_key: secret.ref } },
  });
  const model = defaultAgentModel;
  const configuration = await cli(stack, ["configuration", "create"], {
    name: "configuration.json",
    value: {
      kind: "agent",
      values: {
        gateway: {
          mode: "local",
          bind: "lan",
          controlUi: { enabled: false },
          auth: {
            password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
          },
          http: { endpoints: { chatCompletions: { enabled: true } } },
        },
        agents: {
          defaults: {
            model: `codex/${model}`,
            models: { [`codex/${model}`]: { agentRuntime: { id: "codex" } } },
          },
        },
        models: {
          providers: {
            codex: {
              baseUrl: "http://127.0.0.1:9",
              api: "openai-responses",
              models: [{ id: model, name: model }],
            },
          },
        },
        plugins: {
          allow: ["codex"],
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: {
                  mode: "guardian",
                  approvalPolicy: "never",
                  sandbox: "workspace-write",
                  transport: "websocket",
                  url: "${APP_SERVER_URL}",
                  authToken: "${APP_SERVER_TOKEN}",
                },
              },
            },
          },
        },
      },
    },
  });
  const agent = await cli(stack, ["agent", "create"], {
    name: "agent.json",
    value: {
      name: "openshell-git-acceptance",
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
      repositoryBindings: [{ repositoryRef: origin.repositoryRef, profile: "git-write" }],
    },
  });
  const role = await cli(stack, ["iam", "role", "create"], {
    name: "role.json",
    value: {
      name: "Use a credential source",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    },
  });
  await cli(stack, ["iam", "access-binding", "create"], {
    name: "binding.json",
    value: {
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: role.id,
      resourceKind: "credential_source",
      resourceId: source.id,
    },
  });
  return { id: agent.id, configurationId: configuration.id };
}

async function deploy(stack, agent) {
  const revision = await cli(stack, ["agent", "deploy", agent.id]);
  assert.match(revision.id ?? "", /^rev_/);
  const base = `/namespaces/${stack.namespaceId}/agents/${agent.id}`;
  await waitFor(
    `revision ${revision.id}`,
    async () => {
      const [deployment, current] = await Promise.all([
        api(stack, "GET", `${base}/deployments/${revision.id}`),
        api(stack, "GET", base),
      ]);
      if (deployment.status === "failed") {
        throw new Error(`deployment failed: ${JSON.stringify(deployment.error)}`);
      }
      return {
        done: deployment.status === "succeeded" && current.activeRevisionId === revision.id,
        state: { deployment: deployment.status, active: current.activeRevisionId },
      };
    },
    15 * minute,
  );
  return revision.id;
}

// The Gateway's own ExecSandbox, through a port-forward: its server certificate names
// localhost, and the controller's client certificate is the Workspace member.
async function gatewayClient(stack) {
  const namespace = stack.state.platformNamespace;
  const secret = JSON.parse(
    await output("kubectl", [
      "--kubeconfig",
      stack.kubeconfig,
      "--context",
      stack.context,
      "-n",
      namespace,
      "get",
      "secret",
      "openshell-client-tls",
      "-o",
      "json",
    ]),
  );
  const tls = join(directory, "gateway-client");
  await mkdir(tls, { mode: 0o700 });
  for (const name of ["ca.crt", "tls.crt", "tls.key"]) {
    await writeFile(join(tls, name), Buffer.from(secret.data[name], "base64"), { mode: 0o600 });
  }
  const forward = spawn(
    "kubectl",
    [
      "--kubeconfig",
      stack.kubeconfig,
      "--context",
      stack.context,
      "-n",
      namespace,
      "port-forward",
      "svc/openshell-gateway",
      ":8080",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = once(forward, "exit");
  cleanup.push(async () => {
    forward.kill();
    await exited;
  });
  const lines = createInterface({ input: forward.stdout });
  const line = await Promise.race([
    once(lines, "line", { signal: AbortSignal.timeout(30_000) }).then(([value]) => value),
    exited.then(() => {
      throw new Error("Gateway port-forward exited");
    }),
  ]);
  const [, port] = /^Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+) -> 8080$/.exec(line) ?? [];
  assert.ok(port, "Gateway port-forward reported no local port");
  return new GrpcOpenShellGatewayClient({
    endpoint: `https://localhost:${port}`,
    rootCertificatePath: join(tls, "ca.crt"),
    auth: {
      mode: "mtls",
      certificatePath: join(tls, "tls.crt"),
      privateKeyPath: join(tls, "tls.key"),
    },
    requestTimeoutMs: 30_000,
  });
}

// The Agent's Sandbox Pod carries the Agent label and is owned by its OpenShell Sandbox,
// whose name and Kubernetes namespace are the Gateway's Sandbox and Workspace names.
async function agentSandbox(stack, agent) {
  const owners = JSON.parse(
    await output("kubectl", [
      "--kubeconfig",
      stack.kubeconfig,
      "--context",
      stack.context,
      "get",
      "pods",
      "--all-namespaces",
      "-l",
      `openclaw.dev/agent=${agent.id}`,
      "-o",
      "json",
    ]),
  ).items.flatMap((pod) =>
    pod.metadata.deletionTimestamp
      ? []
      : (pod.metadata.ownerReferences ?? [])
          .filter(
            (owner) => owner.kind === "Sandbox" && owner.apiVersion.startsWith("agents.x-k8s.io/"),
          )
          .map((owner) => ({ workspace: pod.metadata.namespace, sandbox: owner.name })),
  );
  assert.equal(owners.length, 1, "expected one Sandbox Pod for the Agent");
  return owners[0];
}

// Each step is one shell script whose exit code is the only result: the origin's witness
// observes the effects independently. The sandbox's Git environment (credential helper,
// draft PATH) comes from its spec; when an exec session lacks it, adopt it from the
// harness process, which carries exactly that environment.
const prelude = `set -u
if [ -z "\${GIT_CONFIG_COUNT:-}" ]; then
  for f in /proc/[0-9]*/environ; do
    if tr '\\0' '\\n' < "$f" 2>/dev/null | grep -q '^GIT_CONFIG_COUNT='; then
      while IFS= read -r -d '' kv; do
        case $kv in GITHUB_TOKEN=*|GIT_*|OCE_OPENSHELL_GIT_*|SSL_CERT_FILE=*|PATH=*) export "$kv";; esac
      done < "$f"
      break
    fi
  done
fi
[ -n "\${GIT_CONFIG_COUNT:-}" ] || exit 90
work="$HOME/openshell-git-acceptance"
`;
const scripts = {
  environment: `[ -n "\${GIT_CONFIG_COUNT:-}" ] && [ -n "\${GITHUB_TOKEN:-}" ]`,
  clone: `${prelude}rm -rf "$work"; git clone -q https://github.com/${repository}.git "$work" || exit 10
cd "$work"; test "$(git rev-parse HEAD)" = "$1" || exit 11`,
  push: `${prelude}cd "$work" || exit 20
git switch -q -c ${reviewBranch} origin/main || exit 21
git -c user.email=agent@example.invalid -c user.name=acceptance commit -q --allow-empty -m "Acceptance change $1" || exit 22
git push -q origin HEAD:${approvalRef} || exit 23`,
  draft: `${prelude}cd "$work" || exit 30
/opt/oce/repository-credentials/bin/oce-github pr-create --draft --head ${reviewBranch} --base main \\
  --title "Acceptance change" --body "OpenShell Git acceptance draft." >/dev/null 2>&1 || exit 31`,
  refusedPush: `${prelude}cd "$work" || exit 40
git push -q origin HEAD:refs/heads/main >/dev/null 2>&1 && exit 41
exit 0`,
  fetch: `${prelude}cd "$work" || exit 50
git fetch -q origin >/dev/null 2>&1`,
};

async function exec(client, target, name, args = []) {
  return client.execSandbox(
    {
      ...target,
      command: ["/bin/bash", "-c", scripts[name], name, ...args],
      // The Sandbox user's home, as the Driver's own workspace setup exec selects it.
      environment: { HOME: "/sandbox/.openclaw-runtime/home" },
      stdin: "",
      timeoutSeconds: 120,
    },
    AbortSignal.timeout(3 * minute),
  );
}

async function diagnose(stack) {
  const print = (label, result) => {
    const text = String(result.stdout ?? "") + String(result.stderr ?? "");
    console.error(`--- ${label}\n${text.trim().split("\n").slice(-40).join("\n")}`);
  };
  for (const container of [fixture.originContainer, fixture.modelContainer]) {
    print(
      container,
      await run("docker", ["logs", "--tail", "40", container]).catch((error) => error.result ?? {}),
    );
  }
  if (!stack) {
    return;
  }
  const show = async (label, args) =>
    print(label, await kubectl(stack, args).catch((error) => error.result ?? {}));
  await show("pods", ["get", "pods", "--all-namespaces", "-o", "wide"]);
  await show("worker log", [
    "-n",
    stack.state.platformNamespace,
    "logs",
    "deployment/openclaw-enterprise-worker",
    "--tail=400",
  ]);
}

let stack;
let failed = false;
let evidence;
try {
  const pki = await phase("fixture PKI", createOriginPki);
  const origin = await phase("synthetic origin and model", () => startFixtures(pki));
  const inputs = await phase("repository inputs", () => repositoryInputs(pki, origin));
  stack = await phase("occ dev up (OpenShell Git route)", () => developmentUp(pki, inputs));
  record("stock-gateway-registered-worker-middleware");
  await phase("route the stand-in model", () => routeModel(stack));
  const agent = await phase("create the dedicated Codex Agent", () => createAgent(stack, origin));
  await phase("deploy", () => deploy(stack, agent));
  record("revision-active-git-route-verified");
  const client = await phase("Gateway exec client", () => gatewayClient(stack));
  const target = await phase("find the Sandbox", () => agentSandbox(stack, agent));
  const sessionEnvironment = await exec(client, target, "environment");
  progress(
    `exec sessions ${sessionEnvironment === 0 ? "carry" : "lack"} the Sandbox Git environment`,
  );

  await phase("clone", async () => {
    assert.equal(
      await exec(client, target, "clone", [origin.initialSha]),
      0,
      "clone through the route",
    );
  });
  record("clone-through-route");
  const nonce = randomBytes(6).toString("hex");
  await phase("push the review ref", async () => {
    assert.equal(await exec(client, target, "push", [nonce]), 0, "push of the review ref");
    const refs = await witness("/refs");
    assert.ok(refs[approvalRef] && refs[approvalRef] !== origin.initialSha, "review ref moved");
    assert.equal(refs["refs/heads/main"], origin.initialSha, "main unchanged");
    await witness("/fetch"); // The origin re-reads the pushed commit itself.
  });
  record("review-ref-pushed-and-witnessed");
  await phase("draft through the helper", async () => {
    assert.equal(await exec(client, target, "draft"), 0, "oce-github pr-create --draft");
    const pull = await witness("/pull");
    const refs = await witness("/refs");
    assert.equal(pull?.draft, true);
    assert.equal(pull.head.sha, refs[approvalRef]);
    assert.equal(pull.base.ref, "main");
  });
  record("draft-pull-request-through-helper");
  await phase("refused push to main", async () => {
    const before = await witness("/evidence");
    assert.equal(await exec(client, target, "refusedPush"), 0, "push to main must fail");
    const after = await witness("/evidence");
    assert.equal((await witness("/refs"))["refs/heads/main"], origin.initialSha);
    // The middleware refuses before forwarding: the origin sees no receive-pack upload.
    assert.equal(
      after.endpoints["receive-pack:200"] ?? 0,
      before.endpoints["receive-pack:200"] ?? 0,
    );
  });
  record("push-to-other-ref-refused-before-origin");
  await phase("withdraw the binding", async () => {
    const base = `/namespaces/${stack.namespaceId}/agents/${agent.id}`;
    const removed = await api(stack, "PATCH", base, {
      configurationId: agent.configurationId,
      repositoryBindings: [],
    });
    assert.equal(Object.hasOwn(removed, "repositoryBindings"), false);
    await waitFor(
      "a fetch refused after withdrawal",
      async () => ({ done: (await exec(client, target, "fetch")) !== 0 }),
      2 * minute,
    );
    // Withdrawal is not a transient: the next fetch is refused too.
    await delay(5_000);
    assert.notEqual(await exec(client, target, "fetch"), 0, "fetch after withdrawal");
  });
  record("fetch-refused-after-withdrawal");
  evidence = await witness("/evidence");
} catch (error) {
  failed = true;
  console.error(
    `OpenShell Git acceptance failed in ${error.phase ?? "setup"}: ${String(error.message).slice(0, 4000)}`,
  );
  await diagnose(stack).catch(() => {});
} finally {
  for (const release of cleanup.reverse()) {
    try {
      await release();
    } catch (error) {
      failed = true;
      console.error(
        `OpenShell Git acceptance: cleanup failed: ${String(error.message).slice(0, 500)}`,
      );
    }
  }
  await rm(directory, { recursive: true, force: true });
}

const seconds = Math.round((Date.now() - started) / 1000);
for (const { phase: name, seconds: s, failed: bad } of timings) {
  console.log(`  ${bad ? "FAILED" : "ok"} ${name}: ${s}s`);
}
console.log(`OpenShell Git acceptance ${failed ? "failed" : "passed"} in ${seconds}s`);
if (failed) {
  process.exitCode = 1;
} else {
  const receipt = {
    lane,
    sourceSha: sourceCommit,
    status: "passed",
    seconds,
    timings,
    proof,
    origin: {
      requests: evidence?.requests,
      issued: evidence?.issued,
      pulls: evidence?.pullCreateRequests,
    },
  };
  const results = join(env.RUNNER_TEMP ?? workDirectory, "results");
  await mkdir(results, { recursive: true });
  await writeFile(join(results, `${lane}.json`), JSON.stringify(receipt, null, 2));
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      [
        "### OpenShell Git route acceptance",
        "",
        `Source: ${sourceCommit}`,
        `Runtime: ${seconds}s`,
        "",
        ...proof.map((p) => `- ${p}`),
        "",
      ].join("\n"),
    );
  }
}
