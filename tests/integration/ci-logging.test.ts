import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  ciOtelBackendResourceKind,
  cleanupLogging,
  collectorImage,
  fixture,
  prepareLogging,
  readJsonlPayloads,
  type LoggingResource,
} from "../helpers/ci-logging.ts";

type CommandCall = [command: string, args: string[]];
const ownedId = "c".repeat(64);
const engineId = "test-engine";
const env = {
  OCC_DOCKER_BIN: "docker",
  OCC_TEST_LOGGING_COLLECTOR_IMAGE: collectorImage,
  OCC_CI_OTEL_BACKEND_HOST: "host.docker.internal",
  OCC_CI_OTEL_BACKEND_BIND_ADDRESS: "127.0.0.1",
};

function custodyExecutor(
  delegate: (command: string, args: string[]) => Promise<{ stdout: string }> = async () => ({
    stdout: "",
  }),
) {
  let present = false;
  let nonce = "";
  return async (command: string, input: string[]) => {
    const args = input[0] === "--context" || input[0] === "--host" ? input.slice(2) : input;
    if (command === "docker") {
      if (args[0] === "context" && args[1] === "show") return { stdout: "test-context\n" };
      if (args[0] === "context" && args[1] === "inspect")
        return { stdout: JSON.stringify("unix:///test-docker.sock") };
      if (args[0] === "info") return { stdout: engineId };
      if (args[0] === "container" && args[1] === "ls") return { stdout: present ? ownedId : "" };
      if (args[0] === "container" && args[1] === "inspect")
        return { stdout: JSON.stringify([ownedId, collectorImage, nonce]) };
    }
    const result = await delegate(command, args);
    if (command === "docker" && args[0] === "run") {
      nonce =
        args
          .find((arg) => arg.startsWith("org.openclaw.enterprise.ci.otel-attempt="))
          ?.split("=")[1] ?? "";
      const cidIndex = args.indexOf("--cidfile");
      if (cidIndex !== -1) {
        await writeFile(args[cidIndex + 1]!, ownedId, { mode: 0o600, flag: "wx" });
      }
      present = true;
      return { stdout: `${ownedId}\n` };
    }
    if (command === "docker" && args[0] === "rm") present = false;
    return result;
  };
}

async function prepared(root: string, execFile = custodyExecutor()) {
  return prepareLogging({
    directory: root,
    env,
    execFile,
    waitForReady: false,
    registerResource: async (kind, resource) => ({ id: "resource-1", kind, ...resource }),
  });
}

test("prepareLogging registers an owned Collector backend before starting Docker", async (t) => {
  const root = await fixture(t);
  const calls: CommandCall[] = [];
  const registered: { kind: string; resource: LoggingResource }[] = [];
  const execFile = custodyExecutor(async (command: string, args: string[]) => {
    calls.push([command, args]);
    return { stdout: "container-id\n", stderr: "" };
  });
  const registerResource = async (kind: string, resource: LoggingResource) => {
    assert.equal(calls.length, 0, "resource must be persisted before Docker mutation");
    registered.push({ kind, resource });
    return { id: "resource-1", kind, owner: "openclaw-ci-local-test", ...resource };
  };

  const result = await prepareLogging({
    laneName: "docker-model",
    directory: root,
    env: {
      OCC_DOCKER_BIN: "docker",
      OCC_TEST_LOGGING_COLLECTOR_IMAGE: collectorImage,
      OCC_CI_OTEL_BACKEND_HOST: "host.docker.internal",
      OCC_CI_OTEL_BACKEND_BIND_ADDRESS: "127.0.0.1",
    },
    execFile,
    registerResource,
    waitForReady: false,
  });

  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.kind, ciOtelBackendResourceKind);
  assert.equal(result.resourceId, "resource-1");
  assert.equal(result.env.OCC_TEST_OTEL_LOGS, "1");
  assert.match(result.env.OCC_TEST_OTEL_LOGS_JSONL, /logs[.]jsonl$/);
  assert.match(
    result.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    /^http:\/\/host[.]docker[.]internal:\d+\/v1\/logs$/,
  );
  assert.equal(Object.hasOwn(result.env, "OCC_TEST_OTEL_LOGS_URL"), false);
  assert.match(result.artifacts.containerName, /^openclaw-ci-otel-docker-model-/);

  const run = calls.find(([command, args]) => command === "docker" && args[0] === "run");
  assert.ok(run, "prepareLogging starts a Docker Collector backend");
  assert.deepEqual(run[1].slice(0, 4), [
    "run",
    "--detach",
    "--name",
    result.artifacts.containerName,
  ]);
  assert.ok(run[1].includes(collectorImage));
  assert.ok(run[1].includes("--publish"));

  assert.equal((await stat(result.artifacts.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(result.artifacts.outputDirectory)).mode & 0o777, 0o700);
  assert.match(await readFile(result.artifacts.configPath, "utf8"), /path: \/out\/logs[.]jsonl/);
});

test("prepareLogging pulls the Collector image only when the engine lacks its digest", async (t) => {
  // `docker pull` asks the registry even for a held digest; the logging-collector lane
  // pulls the image in prepare, so a stalled registry must not reach the test timeout.
  const otherDigest = collectorImage.replace(/sha256:[a-f0-9]{64}$/, `sha256:${"b".repeat(64)}`);
  for (const { name, repoDigests, pulled } of [
    { name: "held digest", repoDigests: [collectorImage], pulled: false },
    { name: "other digest", repoDigests: [otherDigest], pulled: true },
    { name: "missing image", repoDigests: undefined, pulled: true },
  ]) {
    await t.test(name, async (t) => {
      const root = await fixture(t);
      const calls: string[][] = [];
      const execFile = custodyExecutor(async (command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "image" && args[1] === "inspect") {
          if (repoDigests === undefined) {
            throw Object.assign(new Error("inspect failed"), {
              stderr: `Error response from daemon: No such image: ${collectorImage}`,
            });
          }
          return { stdout: `${JSON.stringify(repoDigests)}\n`, stderr: "" };
        }
        return { stdout: "container-id\n", stderr: "" };
      });
      await prepareLogging({
        laneName: "logging-collector",
        directory: root,
        env: {
          OCC_DOCKER_BIN: "docker",
          OCC_TEST_LOGGING_COLLECTOR_IMAGE: collectorImage,
          OCC_CI_OTEL_BACKEND_BIND_ADDRESS: "127.0.0.1",
        },
        execFile,
        registerResource: async (kind: string, resource: LoggingResource) => ({
          id: "resource-1",
          kind,
          ...resource,
        }),
        waitForReady: false,
      });
      const inspect = calls.findIndex(([command, sub]) => command === "image" && sub === "inspect");
      const pull = calls.findIndex(([command]) => command === "pull");
      const run = calls.findIndex(([command]) => command === "run");
      assert.equal(calls[inspect]?.at(-1), collectorImage);
      assert.notEqual(run, -1);
      assert.ok(inspect < run);
      if (pulled) {
        assert.deepEqual(calls[pull], ["pull", collectorImage]);
        assert.ok(inspect < pull && pull < run);
      } else {
        assert.equal(pull, -1);
      }
    });
  }
});

test("prepareLogging stops when the engine cannot answer the image inspect", async (t) => {
  // Only a missing image reads as absent; a hung or unreachable engine is not pulled past.
  for (const { name, failure } of [
    { name: "inspect timeout", failure: { timedOut: true, stderr: "" } },
    {
      name: "engine unreachable",
      failure: { stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." },
    },
  ]) {
    await t.test(name, async (t) => {
      const root = await fixture(t);
      const calls: string[][] = [];
      const execFile = custodyExecutor(async (command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "image" && args[1] === "inspect") {
          throw Object.assign(new Error(`${name} at inspect`), failure);
        }
        return { stdout: "container-id\n", stderr: "" };
      });
      await assert.rejects(
        prepareLogging({
          laneName: "logging-collector",
          directory: root,
          env: {
            OCC_DOCKER_BIN: "docker",
            OCC_TEST_LOGGING_COLLECTOR_IMAGE: collectorImage,
            OCC_CI_OTEL_BACKEND_BIND_ADDRESS: "127.0.0.1",
          },
          execFile,
          registerResource: async (kind: string, resource: LoggingResource) => ({
            id: "resource-1",
            kind,
            ...resource,
          }),
          waitForReady: false,
        }),
        new RegExp(`${name} at inspect`),
      );
      assert.equal(
        calls.some(([command]) => command === "pull" || command === "run"),
        false,
      );
    });
  }
});

test("prepareLogging installs k3d Collector from the canonical Helm template", async (t) => {
  const root = await fixture(t);
  const clusterName = "openclaw-k8s-oteltest";
  const clusterDirectory = join(root, `${clusterName}-state`);
  const kubeconfig = join(clusterDirectory, "kubeconfig");
  await mkdir(clusterDirectory, { mode: 0o700 });
  await writeFile(kubeconfig, "apiVersion: v1\n", { mode: 0o600 });
  const calls: CommandCall[] = [];
  const registered: { kind: string; resource: LoggingResource }[] = [];
  const execFile = custodyExecutor(async (command: string, args: string[]) => {
    calls.push([command, args]);
    if (command === "docker" && args[0] === "inspect") {
      return { stdout: "172.18.0.23\n", stderr: "" };
    }
    if (command === "kubectl" && args.includes("endpointslices")) {
      return {
        stdout: JSON.stringify({
          items: [
            {
              ports: [{ protocol: "TCP", port: 6443 }],
              endpoints: [{ conditions: { ready: true }, addresses: ["10.89.0.2"] }],
            },
          ],
        }),
        stderr: "",
      };
    }
    if (command === "helm") {
      return {
        stdout:
          "apiVersion: apps/v1\nkind: DaemonSet\nmetadata:\n  name: openclaw-enterprise-collector\n",
        stderr: "",
      };
    }
    return { stdout: "container-id\n", stderr: "" };
  });
  const registerResource = async (kind: string, resource: LoggingResource) => {
    assert.equal(
      calls.length,
      0,
      "resource must be persisted before Docker or Kubernetes mutation",
    );
    registered.push({ kind, resource });
    return { id: "resource-1", kind, owner: "openclaw-ci-local-test", ...resource };
  };

  const result = await prepareLogging({
    // This lane would exceed Helm's release name limit at the default name length.
    laneName: "k3d-otel-custom-logging-smoke",
    cluster: {
      name: clusterName,
      directory: clusterDirectory,
      kubeconfig,
      context: `k3d-${clusterName}`,
    },
    env: {
      OCC_DOCKER_BIN: "docker",
      OCC_HELM_BIN: "helm",
      OCC_KUBECTL_BIN: "kubectl",
      OCC_TEST_LOGGING_COLLECTOR_IMAGE: collectorImage,
    },
    execFile,
    registerResource,
    waitForReady: false,
  });

  assert.equal(registered[0]?.resource.network, `k3d-${clusterName}`);
  assert.equal(registered[0]?.resource.namespace, result.artifacts.containerName);
  assert.equal(result.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, "http://172.18.0.23:4318/v1/logs");
  const dockerRun = calls.find(([command, args]) => command === "docker" && args[0] === "run");
  assert.ok(dockerRun);
  assert.ok(dockerRun[1].includes("--network"));
  assert.ok(dockerRun[1].includes(`k3d-${clusterName}`));
  const helm = calls.find(([command]) => command === "helm");
  assert.ok(helm);
  const [helmCommand, releaseName] = helm[1];
  assert.equal(helmCommand, "template");
  assert.ok(releaseName);
  assert.ok(releaseName.length <= 53, "Helm release names must fit within 53 characters");
  assert.equal(releaseName, registered[0]?.resource.namespace);
  assert.match(releaseName, /-[a-f0-9]{12}$/);
  assert.ok(helm[1].includes("--show-only"));
  assert.ok(helm[1].includes("templates/collector.yaml"));
  assert.ok(helm[1].includes("--values"));
  assert.ok(helm[1].includes("logging.collector.exporter.cidr=172.18.0.23/32"));
  assert.ok(helm[1].includes("logging.collector.exporter.port=4318"));
  assert.ok(helm[1].includes("--set-json"));
  assert.ok(helm[1].includes('cluster.cidrs=["10.89.0.2/32"]'));
  assert.ok(helm[1].includes("cluster.port=6443"));
  const manifestPath = result.artifacts.manifestPath;
  assert.ok(manifestPath);
  const collectorApply = calls.find(
    ([command, args]) =>
      command === "kubectl" && args.includes("apply") && args.includes(manifestPath),
  );
  assert.ok(collectorApply, "the rendered Collector manifest is applied");
  assert.equal(
    collectorApply[1][collectorApply[1].indexOf("--namespace") + 1],
    registered[0]?.resource.namespace,
    "Collector resources must share the namespace of their Secrets and rollout checks",
  );
  assert.ok(result.artifacts.secretsManifestPath);
  const secretManifest = await readFile(result.artifacts.secretsManifestPath, "utf8");
  assert.match(secretManifest, /kind: Namespace/);
  assert.match(secretManifest, /collector[.]yaml: \|-/);
  assert.match(secretManifest, /kubernetes[.]yaml: \|-/);
  assert.match(secretManifest, /exporter[.]yaml: \|-/);
  assert.match(
    secretManifest,
    /OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http:\/\/172[.]18[.]0[.]23:4318\/v1\/logs"/,
  );
});

test("cleanupLogging removes the owned Collector backend and rejects foreign paths", async (t) => {
  const root = await fixture(t);
  const calls: CommandCall[] = [];
  const execFile = custodyExecutor(async (command, args) => {
    calls.push([command, args]);
    return { stdout: "" };
  });
  const result = await prepared(root, execFile);
  const resource = result.resource!;
  await cleanupLogging(resource, { execFile, env });
  await cleanupLogging(resource, { execFile, env });
  assert.deepEqual(
    calls.filter(([, args]) => args[0] === "rm"),
    [["docker", ["rm", "--force", ownedId]]],
  );
  await assert.rejects(() => stat(result.artifacts.directory), { code: "ENOENT" });

  const foreignDirectory = resolve(root, "foreign-state");
  const sentinelPath = join(foreignDirectory, "sentinel");
  const sentinel = Buffer.from("foreign state must remain intact\n");
  await mkdir(foreignDirectory, { mode: 0o700 });
  await writeFile(sentinelPath, sentinel);
  await assert.rejects(
    cleanupLogging({ ...resource, directory: foreignDirectory }, { execFile, env }),
    /outside ownership/,
  );
  await assert.rejects(
    cleanupLogging(
      {
        kind: ciOtelBackendResourceKind,
        containerName: result.artifacts.containerName,
        directory: result.artifacts.directory,
      },
      { execFile, env },
    ),
    /unbound custody/,
  );
  assert.deepEqual(await readFile(sentinelPath), sentinel);
});

test("cleanupLogging does not require Kubernetes when a k3d backend is cleaned", async (t) => {
  const root = await fixture(t);
  const calls: CommandCall[] = [];
  const execFile = custodyExecutor(async (command, args) => {
    calls.push([command, args]);
    if (command === "kubectl") throw new Error("dead cluster");
    return { stdout: "" };
  });
  const result = await prepared(root, execFile);
  await cleanupLogging(
    {
      ...result.resource,
      namespace: result.artifacts.containerName,
      cluster: { name: "openclaw-k8s-deadcluster" },
    },
    { execFile, env },
  );
  assert.deepEqual(
    calls.filter(([, args]) => args[0] === "rm"),
    [["docker", ["rm", "--force", ownedId]]],
  );
  assert.equal(
    calls.some(([command]) => command === "kubectl"),
    false,
  );
  await assert.rejects(() => stat(result.artifacts.directory), { code: "ENOENT" });
});

// The Collector's file exporter can be read mid-write; a cut line waits for its newline.
test("readJsonlPayloads ignores an unterminated last line until it is complete", async (t) => {
  const root = await fixture(t);
  const path = join(root, "logs.jsonl");
  assert.deepEqual(await readJsonlPayloads(path), []);

  const first = JSON.stringify({ resourceLogs: [{ id: "first" }] });
  const second = JSON.stringify({ resourceLogs: [{ id: "second" }] });
  const cut = second.indexOf("second") + 3;
  await writeFile(path, `${first}\n${second.slice(0, cut)}`);
  assert.deepEqual(await readJsonlPayloads(path), [JSON.parse(first)]);

  await appendFile(path, `${second.slice(cut)}\n\n`);
  assert.deepEqual(await readJsonlPayloads(path), [JSON.parse(first), JSON.parse(second)]);
});

test("prepareLogging retains an unknown creation without removing a foreign name", async (t) => {
  const root = await fixture(t);
  let resource: unknown;
  const removals: string[][] = [];
  const execFile = custodyExecutor(async (_command, args) => {
    if (args[0] === "run") throw new Error("name conflict");
    if (args[0] === "rm") removals.push(args);
    return { stdout: "" };
  });
  await assert.rejects(
    prepareLogging({
      directory: root,
      env,
      execFile,
      waitForReady: false,
      registerResource: async (kind, details) => {
        const entry = { id: "resource-1", kind, ...details };
        resource = entry;
        return entry;
      },
    }),
    /cleanup is unresolved/,
  );
  await assert.rejects(cleanupLogging(resource, { env, execFile }), /create outcome is unknown/);
  assert.deepEqual(removals, []);
});

test("prepareLogging recovers a lost command result from its private container ID", async (t) => {
  const root = await fixture(t);
  const removals: string[][] = [];
  const command = custodyExecutor(async (_command, args) => {
    if (args[0] === "rm") removals.push(args);
    return { stdout: "" };
  });
  const execFile = async (program: string, args: string[]) => {
    const result = await command(program, args);
    if (args.includes("run")) throw new Error("lost run response");
    return result;
  };
  await assert.rejects(prepared(root, execFile), /lost run response/);
  assert.deepEqual(removals, [["rm", "--force", ownedId]]);
});

test("cleanupLogging retains an uncertain removal and never replays it", async (t) => {
  const root = await fixture(t);
  let removes = 0;
  const command = custodyExecutor();
  const execFile = async (program: string, args: string[]) => {
    if (args.includes("rm")) {
      removes += 1;
      throw new Error("remove transport lost before known result");
    }
    return command(program, args);
  };
  const result = await prepared(root, execFile);
  await assert.rejects(
    cleanupLogging(result.resource, { env, execFile }),
    /remove outcome is unknown/,
  );
  await assert.rejects(
    cleanupLogging(result.resource, { env, execFile }),
    /remove outcome is unknown/,
  );
  assert.equal(removes, 1);
  assert.ok((await stat(result.artifacts.directory)).isDirectory());
  const custody = (result.resource as { custody: { receiptPath: string } }).custody;
  assert.equal(JSON.parse(await readFile(custody.receiptPath, "utf8")).phase, "remove-intent");
});

test("prepareLogging rejects cluster directory aliases and pins an independent recovery root", async (t) => {
  const root = await fixture(t);
  const name = "openclaw-k8s-custody";
  const directory = join(root, `${name}-state`);
  const clusterAlias = join(root, `${name}-alias`);
  const recoveryAlias = join(root, "recovery-alias");
  const independent = join(root, "independent");
  const independentAlias = join(root, "independent-alias");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, "nested"), { mode: 0o700 });
  await mkdir(independent, { mode: 0o700 });
  await symlink(directory, clusterAlias, "dir");
  await symlink(directory, recoveryAlias, "dir");
  await symlink(independent, independentAlias, "dir");
  const cluster = {
    name,
    directory: clusterAlias,
    kubeconfig: join(clusterAlias, "kubeconfig"),
    context: `k3d-${name}`,
  };
  let commands = 0;
  let registered = 0;
  let receiptPath: string | undefined;
  const stop = new Error("stop after planned registration");
  const command = custodyExecutor();
  const options = {
    cluster,
    env,
    waitForReady: false,
    execFile: async (program: string, args: string[]) => {
      commands += 1;
      return command(program, args);
    },
    registerResource: async (_kind: string, resource: LoggingResource) => {
      registered += 1;
      receiptPath = (resource as { custody: { receiptPath: string } }).custody.receiptPath;
      throw stop;
    },
  };
  for (const base of [directory, recoveryAlias, join(recoveryAlias, "nested")]) {
    await assert.rejects(
      prepareLogging({ ...options, directory: base }),
      /outside the k3d resource directory/,
    );
  }
  assert.equal(commands, 0);
  assert.equal(registered, 0);

  // Use the actual canonical creation path so retargeting the caller's alias
  // cannot strand the planned receipt under the independently retired cluster.
  await assert.rejects(
    prepareLogging({ ...options, directory: independentAlias }),
    (error: unknown) => error === stop,
  );
  assert.equal(registered, 1);
  assert.ok(receiptPath);
  assert.equal(dirname(receiptPath), await realpath(independent));
  const before = await readFile(receiptPath, "utf8");
  assert.equal(JSON.parse(before).phase, "planned");
  await rm(independentAlias);
  await symlink(directory, independentAlias, "dir");
  await rm(directory, { recursive: true, force: true });
  assert.equal(await readFile(receiptPath, "utf8"), before);
});

test("cluster-default logging custody survives retirement of its separate k3d resource", async (t) => {
  for (const phase of ["create-intent", "remove-intent"] as const) {
    await t.test(phase, async (t) => {
      const root = await fixture(t);
      const name = "openclaw-k8s-custody";
      const directory = join(root, `${name}-state`);
      await mkdir(directory, { mode: 0o700 });
      const cluster = {
        name,
        directory,
        kubeconfig: join(directory, "kubeconfig"),
        context: `k3d-${name}`,
      };
      let resource: unknown;
      let creates = 0;
      let removes = 0;
      const command = custodyExecutor();
      const execFile = async (program: string, args: string[]) => {
        if (program === "docker" && args.includes("run")) {
          creates += 1;
          if (phase === "create-intent") {
            throw new Error("unreceived create result");
          }
        }
        if (program === "docker" && args.includes("rm")) {
          removes += 1;
          throw new Error("unreceived remove result");
        }
        // The backend was received, but subsequent cluster preparation failed.
        // Its automatic cleanup must retain an uncertain remove.
        if (program === "kubectl") {
          throw new Error("cluster unavailable");
        }
        return command(program, args);
      };
      await assert.rejects(
        prepareLogging({
          cluster,
          env: { ...env, RUNNER_TEMP: root },
          execFile,
          waitForReady: false,
          registerResource: async (kind, details) => {
            const entry = { id: "cluster-logging", kind, ...details };
            resource = entry;
            return entry;
          },
        }),
        /cleanup is unresolved/,
      );
      const custody = (resource as { custody: { receiptPath: string; cidPath: string } }).custody;
      const before = JSON.parse(await readFile(custody.receiptPath, "utf8"));
      assert.equal(before.phase, phase);
      if (phase === "remove-intent") {
        assert.equal(before.containerId, ownedId);
      }

      // The genuine lane cleanup continues to the independently owned k3d
      // resource after an OTel error. Exercise that resource's filesystem effect.
      await rm(directory, { recursive: true, force: true });
      assert.deepEqual(JSON.parse(await readFile(custody.receiptPath, "utf8")), before);
      if (phase === "remove-intent") {
        assert.equal(await readFile(custody.cidPath, "utf8"), ownedId);
      }
      await assert.rejects(cleanupLogging(resource, { env, execFile }), /outcome is unknown/);
      assert.equal(creates, 1);
      assert.equal(removes, phase === "remove-intent" ? 1 : 0);
    });
  }
});

test("cleanupLogging reconciles a completed removal whose command result was lost", async (t) => {
  const root = await fixture(t);
  let removes = 0;
  const command = custodyExecutor();
  const execFile = async (program: string, args: string[]) => {
    const result = await command(program, args);
    if (args.includes("rm")) {
      removes += 1;
      throw new Error("lost remove response");
    }
    return result;
  };
  const result = await prepared(root, execFile);
  await cleanupLogging(result.resource, { env, execFile });
  await cleanupLogging(result.resource, { env, execFile });
  assert.equal(removes, 1);
  await assert.rejects(stat(result.artifacts.directory), { code: "ENOENT" });
});

test("cleanupLogging refuses a changed Docker engine before removal", async (t) => {
  const root = await fixture(t);
  let changed = false;
  let removes = 0;
  const command = custodyExecutor(async (_program, args) => {
    if (args[0] === "rm") removes += 1;
    return { stdout: "" };
  });
  const execFile = async (program: string, args: string[]) => {
    if (changed && args.includes("info")) return { stdout: "replacement-engine" };
    return command(program, args);
  };
  const result = await prepared(root, execFile);
  changed = true;
  await assert.rejects(cleanupLogging(result.resource, { env, execFile }), /engine changed/);
  assert.equal(removes, 0);
  assert.ok((await stat(result.artifacts.directory)).isDirectory());
});

test("cleanupLogging pins the recorded endpoint and refuses a retargeted context", async (t) => {
  const root = await fixture(t);
  let retargeted = false;
  const removes: string[][] = [];
  const command = custodyExecutor();
  const execFile = async (program: string, args: string[]) => {
    if (retargeted && args[0] === "context" && args[1] === "inspect") {
      return { stdout: JSON.stringify("unix:///foreign-docker.sock") };
    }
    if (args.includes("rm")) removes.push(args);
    return command(program, args);
  };
  const result = await prepared(root, execFile);
  retargeted = true;
  await assert.rejects(cleanupLogging(result.resource, { env, execFile }), /context changed/);
  assert.deepEqual(removes, []);
  retargeted = false;
  await cleanupLogging(result.resource, {
    env: { ...env, DOCKER_CONTEXT: "foreign-context" },
    execFile,
  });
  assert.deepEqual(removes, [["--host", "unix:///test-docker.sock", "rm", "--force", ownedId]]);
});

test("cleanupLogging preserves a directory replacement after container cleanup", async (t) => {
  const root = await fixture(t);
  const execFile = custodyExecutor();
  const result = await prepared(root, execFile);
  const directory = result.artifacts.directory;
  const original = `${directory}-renamed`;
  await rename(directory, original);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "sentinel"), "replacement");
  await assert.rejects(
    cleanupLogging(result.resource, { env, execFile }),
    /directory identity changed/,
  );
  await assert.rejects(
    cleanupLogging(result.resource, { env, execFile }),
    /directory identity changed/,
  );
  assert.equal(await readFile(join(directory, "sentinel"), "utf8"), "replacement");
  assert.ok((await stat(original)).isDirectory());
});
