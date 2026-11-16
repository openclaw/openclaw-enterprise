import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { asRecord } from "../../packages/utils/src/objects.ts";
import { registryImage } from "../../scripts/ci/fixture-support-images.ts";
import { openclawBuildArguments, readOpenclawSource } from "../../scripts/lib/openclaw-source.ts";
import { availablePort } from "./available-port.ts";
import {
  configureModelProviderDNS,
  createModelProviderFiles,
  writeModelProviderTrust,
} from "./runtime-model-provider.mjs";

const repository = resolve(import.meta.dirname, "../..");
const ownerLabel = "dev.openclaw.model-provider-owner";
const nodeBaseImage =
  "docker.io/library/node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a";

export type CommandOptions = {
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeout?: number;
  killSignal?: NodeJS.Signals;
};

type LauncherCommandOptions = Pick<CommandOptions, "env" | "input" | "timeout">;
type CommandOutput = { stdout: string; stderr: string };

export type RunCommand = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<CommandOutput>;

type DockerCommand = (args: string[], options?: CommandOptions) => Promise<CommandOutput>;
type ResourceKind = "container" | "image" | "network";
type Resource = { kind: ResourceKind; name: string; uncertain?: true };
type CompletedTurn = {
  requestAt: number;
  completedAt: number;
  transport: "https" | "websocket";
  status: 200;
};

export type LauncherScope = {
  signal: AbortSignal;
  after: (cleanup: () => Promise<void>) => void;
};

type ProviderOptions = {
  directory: string;
  cluster: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  run?: RunCommand;
};

type ImageRole = "controller" | "runtime";
type LauncherCase = {
  provider: ReturnType<typeof createDevUpModelProvider>;
  execute: (
    program: string,
    args: string[],
    options?: LauncherCommandOptions,
  ) => Promise<CommandOutput>;
  signal: AbortSignal;
};

type LauncherOptions = {
  root: string;
  cluster: string;
  environment: NodeJS.ProcessEnv;
  run?: RunCommand;
};

function execute(
  command: string,
  args: string[],
  { env, input, signal, timeout = 120_000, killSignal = "SIGKILL" }: CommandOptions = {},
): Promise<CommandOutput> {
  signal?.throwIfAborted();
  return new Promise((resolveRun, reject) => {
    let result: (CommandOutput & { error: Error | null }) | undefined;
    const child = execFile(
      command,
      args,
      {
        cwd: repository,
        ...(env === undefined ? {} : { env }),
        ...(signal === undefined ? {} : { signal }),
        timeout,
        killSignal,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        result = { error, stdout, stderr };
      },
    );
    // execFile reports an abort before the process closes. Join the process,
    // including the launcher's graceful cancellation, before releasing its owner.
    const deadline = setTimeout(() => child.kill("SIGKILL"), timeout + 10_000);
    deadline.unref();
    let force: NodeJS.Timeout | undefined;
    const abort = () => {
      force = setTimeout(() => child.kill("SIGKILL"), 10_000);
      force.unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("close", (_code, terminationSignal) => {
      clearTimeout(force);
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      if (!result) {
        reject(new Error("Command closed without a result"));
        return;
      }
      const { error, stdout, stderr } = result;
      if (error) {
        Object.assign(error, {
          stdout,
          stderr,
          forcedTermination: killSignal === "SIGTERM" && terminationSignal === "SIGKILL",
        });
        reject(error);
      } else {
        resolveRun({ stdout, stderr });
      }
    });
    assert.ok(child.stdin, "Command must provide a standard input stream");
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function waitFor(
  description: string,
  operation: () => Promise<{ done: boolean }>,
  timeout: number,
  signal: AbortSignal,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await operation();
    if (result.done) {
      return;
    }
    await delay(1_000, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

// This owner exists before any creation request. The caller registers cleanup
// before prepare(), and retains this directory if either cluster or fixture
// teardown fails. The journal also covers creation with a lost engine response.
export function createDevUpModelProvider({
  directory,
  cluster,
  environment,
  signal,
  run = execute,
}: ProviderOptions) {
  const closing = new AbortController();
  const lifetime = signal ? AbortSignal.any([signal, closing.signal]) : closing.signal;
  const pending = new Set<Promise<unknown>>();
  let preparation: ReturnType<typeof prepare> | undefined;
  let cleaning: Promise<void> | undefined;
  const admitted = async <T>(operation: () => Promise<T>) => {
    lifetime.throwIfAborted();
    const work = Promise.resolve().then(() => {
      lifetime.throwIfAborted();
      return operation();
    });
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  };
  const stop = async () => {
    closing.abort();
    await Promise.allSettled([...pending]);
  };
  const owner = randomUUID();
  const prefix = `oce-dev-provider-${owner.slice(0, 8)}`;
  const resources: Resource[] = [];
  const env = { ...environment };
  const journal = join(directory, "resources.json");
  const modelDirectory = join(directory, "model");
  const network = `${prefix}-network`;
  const provider = `${prefix}-endpoint`;
  const node = `k3d-${cluster}-server-0`;
  // Match ordinary public-address model egress without opening NetworkPolicy.
  // This route exists only on the internal Docker network attached to our node.
  const octets = randomBytes(2);
  const subnetBase = `11.${octets[0]}.${octets[1]}`;
  const modelAddress = `${subnetBase}.2`;
  const nodeAddress = `${subnetBase}.3`;
  const command = (program: string, args: string[], options: CommandOptions = {}) => {
    lifetime.throwIfAborted();
    return run(program, args, { env, ...options, signal: lifetime });
  };
  const docker: DockerCommand = (args, options) => command("docker", args, options);
  // Cleanup has its own bounded commands; the cancelled producer signal must
  // never suppress recovery. Journal writes also serialize the two image builds.
  const cleanupDocker: DockerCommand = (args) => run("docker", args, { env });
  let recording = Promise.resolve();
  const record = (remaining = resources) => {
    const content = `${JSON.stringify({ owner, cluster, dockerHost: env.DOCKER_HOST, resources: remaining }, null, 2)}\n`;
    const next = recording
      .catch(() => {})
      .then(async () => {
        const temporary = `${journal}.tmp`;
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, journal);
      });
    recording = next;
    return next;
  };

  async function inspect(
    kind: ResourceKind,
    name: string,
    invoke: DockerCommand = docker,
  ): Promise<unknown> {
    try {
      const response: unknown = JSON.parse((await invoke([kind, "inspect", name])).stdout);
      // An unusable response cannot prove absence. Keep an empty result
      // distinct from an explicit null entry, which still blocks reservation.
      if (response === null) {
        throw new Error("Engine inspect returned null");
      }
      if (Array.isArray(response)) {
        const entries: readonly unknown[] = response;
        return entries[0];
      }
      return typeof response === "string" ? response[0] : asRecord(response)?.[0];
    } catch (error) {
      // Match Docker's whole not-found diagnostic for this resource. Other inspect
      // failures must leave the cleanup obligation in the recovery journal.
      const stderr = asRecord(error)?.stderr;
      const detail = typeof stderr === "string" ? stderr.trim() : "";
      if (
        detail === `Error response from daemon: No such ${kind}: ${name}` ||
        (kind === "network" && detail === `Error response from daemon: network ${name} not found`)
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async function create(
    name: string,
    args: string[],
    options?: CommandOptions,
    onCommandFailure?: (error: unknown) => void,
  ) {
    lifetime.throwIfAborted();
    const resource = resources.find((entry) => entry.name === name);
    assert.ok(resource, `Fixture resource not reserved: ${name}`);
    resource.uncertain = true;
    try {
      await record();
      lifetime.throwIfAborted();
    } catch (error) {
      // No command was dispatched, so absence can safely retire this reservation.
      delete resource.uncertain;
      throw error;
    }
    await Promise.resolve(docker(args, options)).catch((error: unknown) => {
      onCommandFailure?.(error);
      throw error;
    });
    delete resource.uncertain;
    await record();
  }

  async function reserve(kind: ResourceKind, name: string) {
    assert.equal(await inspect(kind, name), undefined, `Fixture resource already exists: ${name}`);
    lifetime.throwIfAborted();
    resources.push({ kind, name });
    await record();
  }

  function owned(resource: Resource, value: unknown) {
    const object = asRecord(value);
    assert.ok(object, `Fixture resource missing: ${resource.name}`);
    const labels = resource.kind === "network" ? object.Labels : asRecord(object.Config)?.Labels;
    assert.equal(
      asRecord(labels)?.[ownerLabel],
      owner,
      `Refusing unowned ${resource.kind} ${resource.name}`,
    );
    return object;
  }

  async function imageConfig(image: string) {
    const value = asRecord(await inspect("image", image));
    assert.ok(value, `Image missing: ${image}`);
    const config = asRecord(value.Config);
    assert.ok(config, `Image configuration missing: ${image}`);
    return config;
  }

  async function prepare() {
    Object.assign(env, environment);
    assert.equal(
      env.OCC_DEVELOPMENT_CONTAINER_ENGINE,
      "docker",
      "Provider fixture requires Docker",
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Pin the same local engine endpoint the launcher will record. Do not
    // mutate the selected Docker context or any process-global environment.
    if (!env.DOCKER_HOST || env.DOCKER_CONTEXT) {
      const context = env.DOCKER_CONTEXT ?? (await docker(["context", "show"])).stdout.trim();
      const contexts: unknown = JSON.parse((await docker(["context", "inspect", context])).stdout);
      const entries: { readonly length?: unknown; readonly [index: number]: unknown } | undefined =
        Array.isArray(contexts) ? contexts : asRecord(contexts);
      assert.equal(entries?.length, 1);
      const endpoints = asRecord(asRecord(entries[0])?.Endpoints);
      const host = asRecord(endpoints?.docker)?.Host;
      assert.ok(typeof host === "string", "Docker context has no engine host");
      env.DOCKER_HOST = host;
    }
    const dockerHost = env.DOCKER_HOST;
    assert.ok(typeof dockerHost === "string", "Docker context has no engine host");
    assert.match(dockerHost, /^unix:\/\/\//);
    delete env.DOCKER_CONTEXT;
    delete env.DOCKER_TLS_VERIFY;
    delete env.DOCKER_CERT_PATH;
    await record();
    const revision = (await command("git", ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    assert.match(revision, /^[a-f0-9]{40}$/);
    await createModelProviderFiles({ directory: modelDirectory, caName: prefix, run: command });
    const launcherPorts = new Set([
      env.OPENCLAW_DEV_PORT,
      env.OCC_DEVELOPMENT_BROWSER_PORT,
      env.OCC_DEVELOPMENT_KUBERNETES_API_PORT,
    ]);
    let registryPort = await availablePort();
    while (launcherPorts.has(String(registryPort))) {
      registryPort = await availablePort();
    }
    const registry = `127.0.0.1:${registryPort}`;
    const registryName = `${prefix}-registry`;
    await reserve("container", registryName);
    await create(registryName, [
      "run",
      "--detach",
      "--name",
      registryName,
      "--label",
      `${ownerLabel}=${owner}`,
      "--publish",
      `${registry}:5000`,
      registryImage,
    ]);
    const controllerTag = `${registry}/${prefix}/controller:${revision}`;
    const baseTag = `${registry}/${prefix}/runtime-base:${revision}`;
    const runtimeTag = `${registry}/${prefix}/runtime:${revision}`;
    const sourceArguments = openclawBuildArguments(await readOpenclawSource());
    // Same recipes and revision inputs as FirstAgentSmoke. Tags are private to
    // this invocation; the launcher receives only the resulting digest pair.
    for (const tag of [controllerTag, baseTag, runtimeTag]) {
      await reserve("image", tag);
    }
    const cache = (role: ImageRole) =>
      env.GITHUB_ACTIONS === "true" && env.ACTIONS_RUNTIME_TOKEN && env.ACTIONS_RESULTS_URL
        ? [
            "--cache-from",
            `type=gha,version=2,scope=oce-ci-${role}-${process.platform}-${process.arch}-v1,timeout=60s`,
          ]
        : // Reuse the installer's selected builder without passing hosted cache
          // credentials into the test. Local runs retain the engine builder.
          ["--builder", env.BUILDX_BUILDER || "default"];
    const build = async (role: ImageRole, tag: string, args: string[], budgetMs: number) => {
      const started = performance.now();
      let processFailure: Partial<Record<"code" | "signal" | "killed", unknown>> = {};
      try {
        await create(tag, args, { timeout: budgetMs }, (error) => {
          // Read only command-owned data fields, never accessors. Journal and
          // pre-dispatch cancellation errors do not describe a child process.
          try {
            for (const key of ["code", "signal", "killed"] as const) {
              const value: unknown = Object.getOwnPropertyDescriptor(error, key)?.value;
              if (
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean"
              ) {
                processFailure[key] = value;
              }
            }
          } catch {
            processFailure = {};
          }
        });
      } catch (error) {
        // Only fixed labels and process metadata enter CI output. The original
        // errors retain their private command output for local inspection.
        const exit =
          typeof processFailure.code === "number" &&
          Number.isInteger(processFailure.code) &&
          processFailure.code >= 0 &&
          processFailure.code <= 255
            ? processFailure.code
            : "unknown";
        const code =
          typeof processFailure.code === "string" &&
          [
            "ENOENT",
            "EACCES",
            "ENOMEM",
            "EAGAIN",
            "ABORT_ERR",
            "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          ].includes(processFailure.code)
            ? processFailure.code
            : "unknown";
        const signal =
          typeof processFailure.signal === "string" &&
          ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGPIPE", "SIGINT", "SIGHUP"].includes(
            processFailure.signal,
          )
            ? processFailure.signal
            : "unknown";
        const killed =
          typeof processFailure.killed === "boolean" ? processFailure.killed : "unknown";
        const elapsedMs = Math.round(performance.now() - started);
        throw new Error(
          `${role}: exit=${exit} code=${code} signal=${signal} killed=${killed} elapsedMs=${elapsedMs} budgetMs=${budgetMs}`,
          { cause: error },
        );
      }
    };
    const builds = await Promise.allSettled([
      build(
        "controller",
        controllerTag,
        [
          "buildx",
          "build",
          "--load",
          ...cache("controller"),
          "--pull=false",
          "--target",
          "runtime",
          "--build-arg",
          `NODE_BASE_IMAGE=${nodeBaseImage}`,
          "--label",
          `org.opencontainers.image.revision=${revision}`,
          "--label",
          `${ownerLabel}=${owner}`,
          "--tag",
          controllerTag,
          ".",
        ],
        600_000,
      ),
      build(
        "runtime",
        baseTag,
        [
          "buildx",
          "build",
          "--load",
          ...cache("runtime"),
          ...sourceArguments,
          "--pull=false",
          "--file",
          "deploy/runtime/Dockerfile",
          "--build-arg",
          `OCC_BUILD_REVISION=${revision}`,
          "--label",
          `${ownerLabel}=${owner}`,
          "--tag",
          baseTag,
          ".",
        ],
        600_000,
      ),
    ]);
    const failures = builds
      .filter((result) => result.status === "rejected")
      .map((result) => {
        const reason: unknown = result.reason;
        assert.ok(reason instanceof Error);
        return reason;
      });
    if (failures.length) {
      throw new AggregateError(
        failures.map((failure): unknown => failure.cause),
        `Checkout image builds failed: ${failures.map((failure) => failure.message).join("; ")}`,
      );
    }
    const context = join(directory, "runtime-trust");
    await writeModelProviderTrust({ context, caPath: join(modelDirectory, "ca.pem") });
    await create(runtimeTag, [
      "buildx",
      "build",
      "--builder",
      "default",
      "--load",
      "--build-arg",
      `RUNTIME_IMAGE=${baseTag}`,
      "--tag",
      runtimeTag,
      context,
    ]);
    const base = await imageConfig(baseTag);
    const trusted = await imageConfig(runtimeTag);
    for (const key of ["Labels", "User", "Entrypoint", "Cmd", "WorkingDir"]) {
      assert.deepEqual(trusted[key], base[key], `Runtime trust layer changed ${key}`);
    }
    const push = async (tag: string) => {
      await docker(["push", tag], { timeout: 120_000 });
      const image = asRecord(await inspect("image", tag));
      const labels = asRecord(asRecord(image?.Config)?.Labels);
      assert.equal(labels?.["org.opencontainers.image.revision"], revision);
      const refs = image?.RepoDigests;
      assert.ok(Array.isArray(refs), `Image digests missing: ${tag}`);
      const repositoryTag = tag.slice(0, tag.lastIndexOf(":"));
      const digests: readonly unknown[] = refs;
      const digest = digests.find((ref) => {
        assert.ok(typeof ref === "string", `Invalid image digest: ${tag}`);
        return ref.startsWith(`${repositoryTag}@`);
      });
      assert.ok(typeof digest === "string", `Repository digest missing: ${tag}`);
      assert.match(digest, /@sha256:[a-f0-9]{64}$/);
      return digest;
    };
    const controllerImage = await push(controllerTag);
    const runtimeImage = await push(runtimeTag);
    await reserve("network", network);
    await create(network, [
      "network",
      "create",
      "--internal",
      "--subnet",
      `${subnetBase}.0/29`,
      "--label",
      `${ownerLabel}=${owner}`,
      network,
    ]);
    await reserve("container", provider);
    await create(provider, [
      "run",
      "--detach",
      "--name",
      provider,
      "--label",
      `${ownerLabel}=${owner}`,
      "--network",
      network,
      "--ip",
      modelAddress,
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
    await waitFor(
      "provider listener",
      async () => ({ done: (await events()).some(({ event }) => event === "listening") }),
      60_000,
      lifetime,
    );
    return {
      DOCKER_HOST: dockerHost,
      OCC_DEVELOPMENT_CONTROLLER_IMAGE: controllerImage,
      OCC_KUBERNETES_RUNTIME_IMAGE: runtimeImage,
    };
  }

  async function route(stateDirectory: string) {
    const parsed: unknown = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    const state = asRecord(parsed);
    assert.ok(state, "Development state is missing");
    assert.equal(state.cluster, cluster);
    assert.equal(state.containerEngine, "docker");
    assert.equal(state.dockerHost, env.DOCKER_HOST);
    const server = asRecord(await inspect("container", node));
    const labels = asRecord(asRecord(server?.Config)?.Labels);
    assert.equal(labels?.["k3d.cluster"], cluster, "Refusing unrelated k3d node");
    const id = server?.Id;
    assert.ok(typeof id === "string", "k3d node has no engine ID");
    await docker(["network", "connect", "--ip", nodeAddress, network, id]);
    const platformNamespace = state.platformNamespace;
    assert.ok(typeof platformNamespace === "string", "Development state has no platform namespace");
    await configureModelProviderDNS({
      kubectl: (args, options) =>
        command(
          "kubectl",
          [
            "--kubeconfig",
            join(stateDirectory, "kubeconfig"),
            "--context",
            `k3d-${cluster}`,
            ...args,
          ],
          options,
        ),
      waitFor: (description, operation, timeout) =>
        waitFor(description, operation, timeout, lifetime),
      modelAddress,
      platformNamespace,
      serverFile: `${prefix}.server`,
    });
  }

  async function events() {
    const value = owned(
      { kind: "container", name: provider },
      await inspect("container", provider),
    );
    const id = value.Id;
    assert.ok(typeof id === "string", "Provider has no engine ID");
    const { stdout } = await docker(["logs", id]);
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        const event = asRecord(parsed);
        assert.ok(event, "Provider log line is not an object");
        return event;
      });
  }

  async function assertAnswered(): Promise<CompletedTurn> {
    const observed = await events();
    let answer: Pick<CompletedTurn, "completedAt" | "transport" | "status"> | undefined;
    for (const { event, status, at, transport } of observed) {
      if (
        event === "turn-answered" &&
        status === 200 &&
        typeof at === "number" &&
        Number.isSafeInteger(at) &&
        (transport === "https" || transport === "websocket")
      ) {
        answer = { completedAt: at, transport, status };
        break;
      }
    }
    const message = "Dedicated startup did not receive a completed fixture response";
    assert.ok(answer, message);
    for (const { event, turn, at, transport } of observed) {
      if (
        event === "request" &&
        turn === true &&
        typeof at === "number" &&
        Number.isSafeInteger(at) &&
        at <= answer.completedAt &&
        transport === answer.transport
      ) {
        // Whitelist receipts: never serialize request bodies, headers or auth values.
        return { requestAt: at, ...answer };
      }
    }
    assert.fail(message);
  }

  async function reconcile() {
    await stop();
    const failures: unknown[] = [];
    for (const resource of [...resources].reverse()) {
      try {
        const value = await inspect(resource.kind, resource.name, cleanupDocker);
        if (value) {
          const object = owned(resource, value);
          delete resource.uncertain;
          if (resource.kind === "network") {
            const endpoints = object.Containers ?? {};
            const members: [string, unknown][] = Object.entries(endpoints);
            for (const [id, endpoint] of members) {
              assert.equal(
                asRecord(endpoint)?.Name,
                node,
                "Refusing to disconnect an unrelated network member",
              );
              const server = asRecord(await inspect("container", id, cleanupDocker));
              const labels = asRecord(asRecord(server?.Config)?.Labels);
              assert.equal(labels?.["k3d.cluster"], cluster);
              const networkId = object.Id;
              assert.ok(typeof networkId === "string", "Fixture network has no engine ID");
              await cleanupDocker(["network", "disconnect", networkId, id]);
            }
          }
          const target = resource.kind === "image" ? resource.name : object.Id;
          assert.ok(
            typeof target === "string",
            `Fixture resource has no engine ID: ${resource.name}`,
          );
          // Remove owned containers with anonymous storage, and image tags
          // without forcing deletion or pruning unowned parent images.
          await cleanupDocker([
            resource.kind,
            "rm",
            ...(resource.kind === "container" ? ["--force", "--volumes"] : []),
            ...(resource.kind === "image" ? ["--no-prune"] : []),
            target,
          ]);
        } else if (resource.uncertain) {
          throw new Error(`Creation outcome remains uncertain: ${resource.name}`);
        }
        await record(resources.filter((entry) => entry !== resource));
        resources.splice(resources.indexOf(resource), 1);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        `Provider cleanup failed; recovery journal retained at ${journal}`,
      );
    }
  }

  return {
    prepare: async () => {
      lifetime.throwIfAborted();
      return (preparation ??= admitted(prepare));
    },
    route: (stateDirectory: string) => admitted(() => route(stateDirectory)),
    assertAnswered: () => admitted(assertAnswered),
    stop,
    cleanup: () =>
      (cleaning ??= reconcile().finally(() => {
        cleaning = undefined;
      })),
  };
}

// Own the complete real launcher case, because node:test can run after hooks
// on timeout while the async test body is still producing effects.
export async function runDevUpModelProviderCase<T>(
  t: LauncherScope,
  { root, cluster, environment, run = execute }: LauncherOptions,
  body: (scope: LauncherCase) => T | PromiseLike<T>,
): Promise<T> {
  const closing = new AbortController();
  const signal = AbortSignal.any([t.signal, closing.signal]);
  const stateDirectory = environment.OCC_DEVELOPMENT_STATE_DIRECTORY;
  const provider = createDevUpModelProvider({
    directory: join(root, "provider"),
    cluster,
    environment,
    signal,
    run,
  });
  let forcedTermination = false;
  let commandFailed = false;
  const command: LauncherCase["execute"] = async (program, args, options = {}) => {
    signal.throwIfAborted();
    try {
      return await run(program, args, {
        env: environment,
        ...options,
        signal,
        killSignal: "SIGTERM",
      });
    } catch (error) {
      commandFailed = true;
      forcedTermination ||= asRecord(error)?.forcedTermination === true;
      throw error;
    }
  };
  const work = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return body({ provider, execute: command, signal });
  });
  t.after(async () => {
    closing.abort();
    await Promise.allSettled([work]);
    await provider.stop();
    if (forcedTermination) {
      throw new Error(`Command required forced termination; recovery state preserved at ${root}.`);
    }
    if (stateDirectory !== undefined && existsSync(stateDirectory)) {
      // A failed or cancelled launcher can deliberately retain an unresolved
      // creation journal. Process closure and an absent cluster inspection do
      // not settle that obligation; automatic dev-down would erase it.
      if (commandFailed) {
        throw new Error(
          `Command outcome remains uncertain; recovery state preserved at ${stateDirectory}.`,
        );
      }
      try {
        await run(join(repository, "scripts", "dev-down"), [], {
          env: environment,
          timeout: 300_000,
        });
      } catch (error) {
        throw new Error(
          `Development cleanup failed; recovery state preserved at ${stateDirectory}.`,
          {
            cause: error,
          },
        );
      }
    }
    await provider.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return await work;
}
