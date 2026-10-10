import { cleanupRepositoryJourney } from "./repository-remote-cleanup.mjs";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { verifyNativeRepositoryJourney } from "./repository-native-journey.mjs";
import { createGitHubAppRepositoryObserver } from "./github-app-observer.mjs";
import {
  createRepositoryObserver,
  readInstalledCredentialSession,
} from "./repository-credentials-installed.mjs";
import { loadYaml, dumpYaml, waitFor } from "./qa-utils.mjs";
import { protectedText, registerQaSecret } from "./qa-secrets.mjs";

export async function prepareQaRepository(f) {
  const input = f.repositoryInput;
  assert.ok(input, "OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY is required");
  const registry = JSON.parse(
    await protectedText(join(input, "registry.json"), "repository registry"),
  );
  assert.equal(
    registry.repositories.length,
    1,
    "select exactly one authorized disposable repository",
  );
  const entry = registry.repositories[0];
  assert.ok(entry.namespaces[0].profiles.includes("git-full"));
  assert.ok(entry.namespaces[0].profiles.includes("git-read"));
  f.repositoryEntry = entry;
  if (f.controlPlane === "kubernetes") {
    return;
  }
  entry.namespaces = [
    { ...entry.namespaces[0], namespaceId: f.namespace.id, profiles: ["git-read", "git-full"] },
  ];
  const directory = join(f.directory, "repository");
  for (const child of ["registry", "inputs", "ca", "control/private"]) {
    await mkdir(join(directory, child), { recursive: true, mode: 0o700 });
  }
  const write = async (name, value) =>
    writeFile(join(directory, name), typeof value === "string" ? value : JSON.stringify(value), {
      mode: 0o600,
    });
  await write("registry/registry.json", registry);
  await write(
    "inputs/private-key.pem",
    await protectedText(join(input, "private-key.pem"), "repository App key"),
  );
  const host = "git.oce-system.svc.cluster.local";
  await f.run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "inputs/tls.key"),
    "-out",
    join(directory, "ca/ca.crt"),
    "-days",
    "2",
    "-subj",
    `/CN=${host}`,
    "-addext",
    `subjectAltName=DNS:${host}`,
  ]);
  // OpenSSL follows the caller's umask; protected inputs must never be group-writable.
  await Promise.all([
    chmod(join(directory, "ca/ca.crt"), 0o600),
    chmod(join(directory, "inputs/tls.key"), 0o600),
  ]);
  await write("inputs/config.json", {
    gateway: {
      listen: "0.0.0.0:8443",
      publicOrigin: `https://${host}`,
      controlSocket: "/run/openclaw/repository-control/private/control.sock",
      tlsCertFile: "/etc/openclaw/repository-ca/ca.crt",
      tlsKeyFile: "/etc/openclaw/repository-inputs/tls.key",
    },
    sessionPolicy: {
      maximumDurationSeconds: registry.maximumDurationSeconds,
      defaultProfile: "git-full",
      allowedProfiles: ["git-read", "git-full"],
    },
    backend: {
      kind: "github-app-registry",
      backendId: registry.backendId,
      registryFile: "/etc/openclaw/repository-registry/registry.json",
      privateKeyFile: "/etc/openclaw/repository-inputs/private-key.pem",
    },
  });
  const path = join(f.stateDirectory, "compose.yaml");
  const compose = loadYaml(await readFile(path, "utf8"));
  const mount = (source, target, readOnly = true) => ({
    type: "bind",
    source: join(directory, source),
    target,
    read_only: readOnly,
  });
  const image = process.env.OCC_TEST_QA_REPOSITORY_IMAGE ?? `oce-qa-repository:${f.suffix}`;
  if (!process.env.OCC_TEST_QA_REPOSITORY_IMAGE) {
    await f.run(
      "docker",
      [
        "build",
        "-f",
        "deploy/runtime/Dockerfile",
        "--target",
        "repository-credentials-service",
        "-t",
        image,
        ".",
      ],
      { timeout: 1_200_000 },
    );
  }
  compose.services["repository-credentials"] = {
    image,
    entrypoint: ["node", "/app/dist/repository-credentials.js"],
    command: ["--config", "/etc/openclaw/repository-inputs/config.json"],
    networks: { development: {} },
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    volumes: [
      mount("registry", "/etc/openclaw/repository-registry"),
      mount("inputs", "/etc/openclaw/repository-inputs"),
      mount("ca", "/etc/openclaw/repository-ca"),
      mount("control", "/run/openclaw/repository-control", false),
    ],
  };
  for (const name of ["controller", "worker-kubernetes"]) {
    compose.services[name].volumes.push(
      mount("registry", "/etc/openclaw/repository-registry"),
      mount("ca", "/etc/openclaw/repository-ca"),
    );
    if (name === "worker-kubernetes") {
      compose.services[name].volumes.push(
        mount("control", "/run/openclaw/repository-control", false),
      );
    }
  }
  await writeFile(path, dumpYaml(compose), { mode: 0o600 });
  await f.compose("up", "-d", "--no-deps", "repository-credentials");
  const broker = (await f.compose("ps", "-a", "-q", "repository-credentials")).trim();
  assert.ok(broker, "Compose must create the real repository broker");
  await waitFor("Compose broker control socket ready", async () => {
    const state = JSON.parse(await f.run("docker", ["inspect", broker]))[0].State;
    assert.ok(state.Running, "the real repository broker exited during startup");
    try {
      return (await stat(join(directory, "control/private/control.sock"))).isSocket();
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return false;
    }
  });
  const ip = JSON.parse(await f.run("docker", ["inspect", broker]))[0].NetworkSettings.Networks[
    `${f.cluster}_development`
  ].IPAddress;
  const labels = { "app.kubernetes.io/name": "qa-repository-relay" };
  const compute = f.configuration.drivers.compute.configuration;
  // A TCP relay preserves broker TLS and authentication. It does not implement
  // credentials, Git, or authorization; the shipped broker handles every call.
  await f.apply({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "qa-repository-relay", namespace: "oce-system" },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "relay",
              image: compute.images.agent,
              imagePullPolicy: "Never",
              command: [
                "node",
                "-e",
                `const net=require('net');net.createServer(c=>{const u=net.connect(8443,'${ip}');c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(8443,'0.0.0.0')`,
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              ports: [{ name: "https", containerPort: 8443 }],
              readinessProbe: { tcpSocket: { port: "https" }, periodSeconds: 2 },
            },
          ],
        },
      },
    },
  });
  await f.apply({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "git", namespace: "oce-system" },
    spec: { selector: labels, ports: [{ name: "https", port: 443, targetPort: 8443 }] },
  });
  await f.apply({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "qa-repository-relay", namespace: "oce-system" },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "openclaw.dev/namespace": f.namespace.id } },
              podSelector: {
                matchExpressions: [
                  {
                    key: "openclaw.dev/workload-role",
                    operator: "In",
                    values: ["agent", "gateway"],
                  },
                ],
              },
            },
          ],
          ports: [{ protocol: "TCP", port: 8443 }],
        },
      ],
      egress: [
        { to: [{ ipBlock: { cidr: `${ip}/32` } }], ports: [{ protocol: "TCP", port: 8443 }] },
      ],
    },
  });
  await f.kubectl(
    "-n",
    "oce-system",
    "rollout",
    "status",
    "deployment/qa-repository-relay",
    "--timeout=120s",
  );
  f.configuration.backend = [
    {
      id: registry.backendId,
      type: "github",
      configuration: { registryPath: "/etc/openclaw/repository-registry/registry.json" },
      drivers: { repo: "repository-credentials" },
    },
  ];
  f.configuration.drivers.repo = {
    id: "repository-credentials",
    configuration: {
      controlSocket: "/run/openclaw/repository-control/private/control.sock",
      sessionDurationSeconds: registry.maximumDurationSeconds,
      publicCaPath: "/etc/openclaw/repository-ca/ca.crt",
    },
  };
  compute.network.repositoryCredentials = {
    namespace: "oce-system",
    podLabels: labels,
    port: 8443,
  };
  await f.saveInstallation(f.configuration);
}

export async function stopQaAgent(f, agent) {
  await f.api("POST", `/namespaces/${agent.namespaceId}/agents/${agent.id}/stop`);
  await waitFor("ordinary Agent stop removes every runtime Pod", async () => {
    const current = await f.api("GET", `/namespaces/${agent.namespaceId}/agents/${agent.id}`);
    const pods = JSON.parse(
      await f.kubectl("get", "pods", "-A", "-l", `openclaw.dev/agent=${agent.id}`, "-o", "json"),
    ).items;
    return (
      current.desiredRuntimeState === "stopped" && !current.activeRevisionId && pods.length === 0
    );
  });
  agent.stopped = true;
}

export async function verifyQaRepository(f, agent, profile = "git-full") {
  assert.ok(!f.retained, "unresolved repository cleanup prevents opening another session");
  assert.equal(
    process.env.OCC_TEST_QA_REPOSITORY_AUTHORIZED,
    "1",
    "explicit disposable remote-write authorization is required",
  );
  const entry = f.repositoryEntry;
  const repository = entry.repository;
  const observerTokenPath = process.env.OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE;
  const observerAppInput = process.env.OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY;
  const observerBinary = process.env.OCC_TEST_QA_GITHUB_OBSERVER_BINARY;
  if (process.env.QA_REPOSITORY_FIXTURE === "isolated") {
    assert.ok(observerAppInput, "isolated repository fixture requires App-backed observer input");
    assert.ok(
      !observerTokenPath,
      "isolated repository fixture must not use a static observer token",
    );
    assert.ok(!observerBinary, "isolated repository fixture must not use a managed gh wrapper");
  }
  const observerToken = observerTokenPath
    ? await protectedText(observerTokenPath, "independent GitHub observer credential")
    : undefined;
  const selectedObservers = [observerToken, observerAppInput, observerBinary].filter(Boolean);
  assert.equal(
    selectedObservers.length,
    1,
    "select exactly one independent observer credential, App input directory, or managed gh wrapper",
  );
  // A selected managed wrapper may authenticate from its caller's environment.
  // Forward credentials only to the host observer/Git calls, never the launcher
  // environment used for containers, Kubernetes, or model turns.
  const observerEnvironment = observerToken
    ? { GH_TOKEN: observerToken }
    : Object.fromEntries(
        observerAppInput
          ? []
          : ["GH_TOKEN", "GITHUB_TOKEN"]
              .filter((name) => process.env[name])
              .map((name) => [name, process.env[name]]),
      );
  for (const value of Object.values(observerEnvironment)) {
    registerQaSecret(value);
  }
  const runObserverCommand = (cmd, args, options) =>
    f.run(cmd, args, {
      ...options,
      env: { ...f.env, ...options?.env, ...observerEnvironment },
    });
  const observe = observerAppInput
    ? await createGitHubAppRepositoryObserver({
        repository,
        inputDirectory: observerAppInput,
        run: runObserverCommand,
      })
    : createRepositoryObserver({
        repository,
        binary: observerBinary ?? "gh",
        run: runObserverCommand,
      });
  const { data: remote } = await observe("GET");
  assert.equal(String(remote.id), String(entry.repositoryId));
  assert.equal(remote.full_name.toLowerCase(), repository.toLowerCase());
  const base = remote.default_branch;
  const { data: baseline } = await observe("GET", `git/ref/heads/${encodeURIComponent(base)}`);
  const baseSha = baseline.object.sha;
  assert.match(baseSha, /^[a-f0-9]{40}$/);
  const suffix = `${f.suffix}-${agent.preset.toLowerCase()}-${profile}`;
  const branch = `oce-qa-${suffix}`;
  const file = `qa-${suffix}.txt`;
  const content = `QA repository proof ${suffix}\n`;
  const marker = `<!-- oce-qa:${suffix} -->`;
  await observe("GET", `git/ref/heads/${branch}`, undefined, 404);
  const path = `/namespaces/${agent.namespaceId}/agents/${agent.id}`;
  const dedicated = agent.preset === "Codex";
  const currentConfiguration = await f.api(
    "GET",
    `/namespaces/${agent.namespaceId}/configurations/${agent.configuration.id}`,
  );
  const values = currentConfiguration.values;
  values.agents.defaults.workspace = dedicated
    ? "/home/node/workspace"
    : "/home/node/.openclaw/workspace";
  values.agents.defaults.sandbox = { mode: "off" };
  if (dedicated) {
    Object.assign(values.plugins.entries.codex.config.appServer, {
      approvalPolicy: "never",
      sandbox: "workspace-write",
      remoteWorkspaceRoot: "/home/node/workspace",
    });
  }
  values.tools = {
    ...values.tools,
    allow: dedicated ? ["*"] : ["exec", "process"],
    ...(dedicated ? { fs: { ...values.tools?.fs, workspaceOnly: true } } : {}),
    exec: {
      ...values.tools?.exec,
      mode: "full",
      ...(dedicated ? {} : { host: "gateway" }),
    },
  };
  await f.api(
    "PATCH",
    `/namespaces/${agent.namespaceId}/configurations/${agent.configuration.id}`,
    { values },
  );
  await f.api("PATCH", path, {
    configurationId: agent.configuration.id,
    repositoryBindings: [{ repositoryRef: entry.repositoryRef, profile }],
  });
  let workFailure;
  let remoteEvidence;
  let attempt;
  let readSession;
  try {
    // Deployment can open provider credentials even if its response is lost.
    // A rejected draft update above creates no session-cleanup obligation.
    f.pendingRepositories.add(agent.id);
    await f.deployAndWait(agent);
    const readOnly = profile === "git-read";
    const gateway = await f.pod(agent, "gateway");
    const consumer = dedicated ? await f.pod(agent, "agent") : gateway;
    const consumerName = dedicated ? "agent" : "gateway";
    const execIn = (pod, container, script, args = [], input, timeout = 30_000) =>
      f.run(
        "kubectl",
        [
          "--kubeconfig",
          join(f.stateDirectory, "kubeconfig"),
          "--context",
          `k3d-${f.cluster}`,
          "-n",
          pod.metadata.namespace,
          "exec",
          "-i",
          pod.metadata.name,
          "-c",
          container,
          "--",
          "env",
          "-u",
          "OPENAI_API_KEY",
          "node",
          "-e",
          script,
          ...args,
        ],
        { input, timeout },
      );
    const exec = (...args) => execIn(gateway, "gateway", ...args);
    const consumerExec = (...args) => execIn(consumer, consumerName, ...args);
    const material = JSON.parse(
      await consumerExec(
        "const fs=require('fs'),p='/run/oce/repository-credentials/manifest.json',m=JSON.parse(fs.readFileSync(p)),s=fs.statSync(p);console.log(JSON.stringify({uid:s.uid,mode:s.mode&511,bindings:m.bindings.map(b=>({repositoryRef:b.repositoryRef,sessionId:b.sessionId}))}))",
      ),
    );
    assert.equal(material.uid, 1000);
    assert.equal(material.mode, 0o600);
    assert.equal(material.bindings.length, 1);
    assert.equal(material.bindings[0].repositoryRef, entry.repositoryRef);
    attempt = material.bindings[0];
    const workers =
      f.controlPlane === "kubernetes"
        ? JSON.parse(
            await f.kubectl(
              "-n",
              f.state.platformNamespace,
              "get",
              "pods",
              "-l",
              "app.kubernetes.io/component=worker",
              "-o",
              "json",
            ),
          ).items
        : [];
    const workerPod = workers.find(
      (p) =>
        !p.metadata.deletionTimestamp &&
        p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
    );
    const executeWorker = (script, args, timeout) =>
      f.controlPlane === "compose"
        ? f.run(
            "docker",
            [
              "compose",
              "-p",
              f.cluster,
              "-f",
              join(f.stateDirectory, "compose.yaml"),
              "exec",
              "-T",
              "worker-kubernetes",
              "node",
              "-e",
              script,
              ...args,
            ],
            { timeout },
          )
        : f.run(
            "kubectl",
            [
              "--kubeconfig",
              join(f.stateDirectory, "kubeconfig"),
              "--context",
              `k3d-${f.cluster}`,
              "-n",
              f.state.platformNamespace,
              "exec",
              workerPod.metadata.name,
              "-c",
              "worker",
              "--",
              "node",
              "-e",
              script,
              ...args,
            ],
            { timeout },
          );
    readSession = (id) => readInstalledCredentialSession(executeWorker, id);
    assert.equal((await readSession(attempt.sessionId)).state, "OPEN");
    for (const pod of [gateway, consumer]) {
      assert.ok(
        !pod.spec.containers.some((c) =>
          c.env?.some((e) =>
            ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].includes(
              e.name,
            ),
          ),
        ),
        "no alternate provider credential in runtime",
      );
    }
    // Submit through the actual gateway's supported authenticated HTTP endpoint.
    // Execution and Git/gh remain entirely in the native Agent.
    const scenarioFixture = {
      ...f,
      suffix,
      gatewayHostname: undefined,
      record: (name, value) => f.record(`${suffix}-${name}`, value),
    };
    remoteEvidence = await verifyNativeRepositoryJourney({
      f: scenarioFixture,
      dedicated,
      readOnly,
      workspace: dedicated ? "/home/node/workspace" : "/home/node/.openclaw/workspace",
      repository,
      base,
      baseSha,
      branch,
      file,
      content,
      marker,
      commandTool: dedicated ? "bash" : "exec",
      toolNames: dedicated ? ["bash"] : ["exec", "process"],
      gateway,
      consumer,
      agent,
      revision: agent.revision,
      attempt,
      exec,
      submitTask: exec,
      consumerExec,
      observe,
      app: { repositoryId: String(entry.repositoryId) },
      remote,
      readSession,
      submitViaLoopback: true,
    });
  } catch (error) {
    workFailure = error;
  }
  let cleanupFailure;
  try {
    await stopQaAgent(f, agent);
    if (attempt && readSession) {
      const session = await waitFor("broker session DISPOSED", async () => {
        const value = await readSession(attempt.sessionId);
        return value.state === "DISPOSED" && value;
      });
      assert.equal(session.activeUses, 0);
      for (const counter of ["active", "pending", "uncertain"]) {
        assert.equal(session.cleanup[counter], 0, `session cleanup ${counter}`);
      }
      assert.equal(session.cleanup.auxiliaryPending, false);
      const materials = JSON.parse(
        await f.kubectl(
          "get",
          "secrets",
          "-A",
          "-l",
          `openclaw.dev/agent=${agent.id},openclaw.dev/repository-material=session`,
          "-o",
          "json",
        ),
      ).items;
      assert.equal(materials.length, 0);
      await f.record(`${suffix}-disposal`, session);
      f.pendingRepositories.delete(agent.id);
    }
    // Reconcile unknown task outcomes as well as successful remote writes.
    if (!f.pendingRepositories.has(agent.id)) {
      await cleanupRepositoryJourney({
        observe,
        repository,
        repositoryId: entry.repositoryId,
        branch,
        base,
        baseSha,
        file,
        content,
        marker,
        readOnly: profile === "git-read",
        commitMessage: `Installed credential proof ${suffix}`,
        expectedSha: remoteEvidence?.commitSha,
      });
    }
  } catch (error) {
    cleanupFailure = error;
  }
  if (f.pendingRepositories.has(agent.id)) {
    f.retained = true;
  }
  if (workFailure && cleanupFailure) {
    throw new AggregateError(
      [workFailure, cleanupFailure],
      "repository journey and cleanup failed",
      { cause: workFailure },
    );
  }
  if (cleanupFailure) {
    throw cleanupFailure;
  }
  if (workFailure) {
    throw workFailure;
  }
}
