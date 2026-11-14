import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";
import {
  AGENT_READINESS_ENTRYPOINT,
  AGENT_WITH_NODE_ENTRYPOINT as SANDBOX_AGENT_WITH_NODE_ENTRYPOINT,
  PROTECTED_CODEX_WITH_NODE_ENTRYPOINT as SANDBOX_PROTECTED_CODEX_WITH_NODE_ENTRYPOINT,
  COMPUTE_AGENT_RUNTIME_ENTRYPOINT as AGENT_RUNTIME_ENTRYPOINT,
  COMPUTE_AGENT_WITH_NODE_ENTRYPOINT as AGENT_WITH_NODE_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
  COMPUTE_PROTECTED_CODEX_RUNTIME_ENTRYPOINT as PROTECTED_CODEX_RUNTIME_ENTRYPOINT,
  COMPUTE_PROTECTED_CODEX_WITH_NODE_ENTRYPOINT as PROTECTED_CODEX_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
  SETUP_WRAPPER_COMMAND,
  gatewayRuntimeEntrypoint,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  compactNodeChildArguments,
  nodeProgramArguments,
  withoutLineComments,
} from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import type { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  options,
  routedRevision,
  labelSelectorLabels,
} from "../helpers/kubernetes-routed-scenarios.mjs";
import { workspaceSetupFixture } from "../helpers/kubernetes-workspace-setup.ts";

// Linux rejects a single exec argument or environment string above 128 KiB.
// Leave headroom for each controller-rendered string as the programs grow.
export const EXEC_STRING_BUDGET = 64 * 1024;

type KubernetesSdk = Awaited<ReturnType<typeof createKubernetesClientConfiguration>>["sdk"];
type CoreApi = InstanceType<KubernetesSdk["CoreV1Api"]>;
type WorkloadObject = {
  kind: string;
  metadata: { name: string };
  spec?: unknown;
};

function record(value: unknown) {
  const object = asRecord(value);
  assert.ok(object, "expected a rendered object");
  return object;
}

function records(value: unknown) {
  assert.ok(Array.isArray(value), "expected a rendered object array");
  return value.map(record);
}

function strings(value: unknown): readonly string[] {
  assert.ok(Array.isArray(value), "expected a rendered string array");
  return value.map((item: unknown) => {
    assert.ok(typeof item === "string", "expected a rendered string");
    return item;
  });
}

function deploymentPod(deployment: WorkloadObject) {
  return record(record(record(deployment.spec).template).spec);
}

function firstContainer(pod: Record<string, unknown>) {
  const [container] = records(pod.containers);
  assert.ok(container, "expected a rendered container");
  return container;
}

export function assertExecStringsWithinBudget(objects: Iterable<WorkloadObject>) {
  for (const object of objects) {
    const spec = asRecord(object.spec);
    const pod = object.kind === "Pod" ? spec : asRecord(asRecord(spec?.template)?.spec);
    for (const container of [
      ...records(pod?.initContainers ?? []),
      ...records(pod?.containers ?? []),
    ]) {
      const entries: [field: string, value: string][] = [
        ...strings(container.command ?? []).map<[string, string]>((value, index) => [
          `command[${index}]`,
          value,
        ]),
        ...strings(container.args ?? []).map<[string, string]>((value, index) => [
          `args[${index}]`,
          value,
        ]),
        ...records(container.env ?? [])
          .filter(({ value }) => value !== undefined)
          .map<[string, string]>(({ name, value }) => [`env ${name}`, `${name}=${value}`]),
        ...["readinessProbe", "livenessProbe", "startupProbe"].flatMap((probe) =>
          strings(asRecord(asRecord(container[probe])?.exec)?.command ?? []).map<[string, string]>(
            (value, index) => [`${probe} command[${index}]`, value],
          ),
        ),
      ];
      for (const [field, value] of entries) {
        const size = Buffer.byteLength(value);
        assert.ok(
          size <= EXEC_STRING_BUDGET,
          `${object.kind} ${object.metadata.name} container ${container.name} ${field} is ` +
            `${size} bytes; the per-string budget is ${EXEC_STRING_BUDGET}`,
        );
      }
    }
  }
}

// Controller-rendered programs reach node -e compressed behind a fixed loader.
export function containerProgram(container: { args?: unknown } | Record<string, unknown>) {
  const [loader, ...pieces] = strings(container.args);
  assert.equal(loader, nodeProgramArguments("")[0]);
  return inflateRawSync(Buffer.from(pieces.join(""), "base64")).toString("utf8");
}

// Compare the printed program with comments removed and the exact decoded payload.
export function checkRuntimeProgramComments() {
  const ts: typeof import("typescript") = createRequire(import.meta.url)("typescript");
  const printer = ts.createPrinter({ removeComments: true });
  const code = (text: string) =>
    printer.printFile(ts.createSourceFile("program.js", text, ts.ScriptTarget.Latest));
  for (const [name, program] of Object.entries({
    AGENT_READINESS_ENTRYPOINT,
    AGENT_RUNTIME_ENTRYPOINT,
    AGENT_WITH_NODE_ENTRYPOINT,
    NATIVE_WORKER_ENTRYPOINT,
    PROTECTED_CODEX_RUNTIME_ENTRYPOINT,
    PROTECTED_CODEX_WITH_NODE_ENTRYPOINT,
  })) {
    const sent = withoutLineComments(program);
    assert.doesNotMatch(sent, /^[ \t]*\/\//m, name);
    assert.equal(code(sent), code(program), name);
    const [, ...pieces] = nodeProgramArguments(program);
    assert.equal(inflateRawSync(Buffer.from(pieces.join(""), "base64")).toString("utf8"), sent);
  }
  // Both Sandbox and Compute wrap the Codex child inside the node supervisor.
  // Budget the complete serialized command so nesting cannot exceed exec limits.
  for (const [name, program] of Object.entries({
    AGENT_WITH_NODE_ENTRYPOINT,
    PROTECTED_CODEX_WITH_NODE_ENTRYPOINT,
    SANDBOX_AGENT_WITH_NODE_ENTRYPOINT,
    SANDBOX_PROTECTED_CODEX_WITH_NODE_ENTRYPOINT,
  })) {
    const bytes = Buffer.byteLength(
      JSON.stringify([...RUNTIME_WRAPPER_COMMAND, ...nodeProgramArguments(program)]),
    );
    assert.ok(bytes <= EXEC_STRING_BUDGET, `${name}: ${bytes} exceeds ${EXEC_STRING_BUDGET}`);
  }
  // A `//` line can sit inside a template literal, a continued string, a string with a raw
  // U+2028 or U+2029, or a block comment; a program with any of those (the Gateway
  // entrypoint has a "/*" glob) or a carriage return is left whole.
  for (const program of [
    GATEWAY_RUNTIME_ENTRYPOINT,
    "const text = `\n// kept\n`;\n",
    'const text = "a\\\n// kept";\n',
    'const text = "a\\\r// kept";\n',
    'const text = "a\u2028// kept";\n',
    'const text = "a\u2029// kept";\n',
    "/*\n// kept */\nrun();\n",
  ]) {
    assert.equal(withoutLineComments(program), program);
  }
  const sourceWithComments = "// gone\n  // gone\nrun(); // kept\n";
  const stripped = "run(); // kept\n";
  assert.match(sourceWithComments, /^[ \t]*\/\//m);
  assert.equal(withoutLineComments(sourceWithComments), stripped);
  assert.equal(code(stripped), code(sourceWithComments));
  assert.equal(containerProgram({ args: nodeProgramArguments(sourceWithComments) }), stripped);
}

export async function checkEmbeddedGatewayRecoveryKey() {
  for (const variant of ["embedded", "dedicated", "custom-environment"]) {
    const { driver, revision, objects, context } = workspaceSetupFixture(variant !== "dedicated");
    if (variant === "custom-environment") {
      driver.setLifecycleDrivers([
        {
          id: "custom-environment",
          capability: "configuration",
          implementation: "test",
          computeLifecycleHooks: {
            async beforeWorkloadStart(_revision, launch) {
              launch.environment.EXTRA_INPUT = "opaque-key";
            },
          },
        },
      ]);
    }
    await driver.prepareRevision(revision, { ...context, secretEnvironment: [] });
    const deployments = [...objects.values()].filter(({ kind }) => kind === "Deployment");
    assert.ok(deployments.length > 0);
    for (const deployment of deployments) {
      const pod = deploymentPod(deployment);
      const gateway = firstContainer(pod);
      const volumes = records(pod.volumes).filter(
        ({ name }) => typeof name === "string" && name.startsWith("gateway-owner-"),
      );
      const environment = records(gateway.env);
      const marker = environment.find(({ name }) => name === "OPENCLAW_EMBEDDED_GATEWAY_OWNER");
      if (variant !== "embedded") {
        assert.deepEqual(volumes, [], variant);
        assert.equal(marker, undefined, variant);
        continue;
      }
      assert.equal(marker?.value, "1");
      assert.equal(
        record(
          record(environment.find(({ name }) => name === "OPENCLAW_POD_UID")?.valueFrom).fieldRef,
        ).fieldPath,
        "metadata.uid",
      );
      assert.equal(records(pod.containers).length, 1);
      assert.equal(pod.shareProcessNamespace, undefined);
      assert.deepEqual(
        volumes.map(({ emptyDir }) => record(emptyDir).medium),
        ["Memory", "Memory"],
      );
      const key = { name: "gateway-owner-key", mountPath: "/run/oce-gateway-owner-key" };
      const scratch = { name: "gateway-owner-start", mountPath: "/run/oce-gateway-owner-start" };
      const mounts = (container: Record<string, unknown>) =>
        records(container.volumeMounts).filter(({ name }) =>
          volumes.some((volume) => volume.name === name),
        );
      assert.deepEqual(mounts(gateway), [{ ...key, readOnly: true }, scratch]);
      const keyInits = records(pod.initContainers).filter((init) => mounts(init).length > 0);
      assert.equal(keyInits.length, 1);
      // An init that also mounts the writable Agent state could follow a link planted there.
      assert.deepEqual(keyInits[0]?.volumeMounts, [key, scratch]);
    }
  }
}

export async function checkProductionExampleWorkloadResources() {
  // The example carries the profile renderer's values (profile-renderer.test.mjs keeps them equal).
  const { loadYaml }: Pick<KubernetesSdk, "loadYaml"> = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const example: unknown = loadYaml(
    await readFile(
      new URL("../../deploy/examples/production/installation.yaml", import.meta.url),
      "utf8",
    ),
  );
  const { resources } = record(record(record(record(example).drivers).compute).configuration);
  const { driver, revision, objects, context } = workspaceSetupFixture(false, true, undefined, {
    resources,
  });
  await driver.prepareRevision(revision, { ...context, secretEnvironment: [] });
  const container = (prefix: string) => {
    const deployment = [...objects.values()].find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith(prefix),
    );
    assert.ok(deployment, `${prefix} Deployment rendered`);
    return firstContainer(deploymentPod(deployment));
  };
  // A Gateway holds 2.3-2.4 GiB between turns and peaks at 2.8 GiB on its first turn.
  assert.deepEqual(container("gateway-").resources, {
    requests: { cpu: "100m", memory: "2560Mi" },
    limits: { cpu: "4", memory: "4Gi" },
  });
  // The Codex Harness held 0.45-0.57 GiB idle; lint, tsc and tests together were
  // OOM-killed at 2Gi and reached a 4Gi limit.
  assert.deepEqual(container("agent-").resources, {
    requests: { cpu: "100m", memory: "768Mi" },
    limits: { cpu: "4", memory: "6Gi" },
  });
}

export async function checkRenderedExecStringBudget() {
  for (const embedded of [true, false]) {
    const { driver, revision, objects, state, context } = workspaceSetupFixture(embedded);
    const revisionContext = { ...context, secretEnvironment: [] };
    await driver.prepareRevision(revision, revisionContext);
    // Readiness admits the dedicated workspace node, whose supervisor embeds Codex.
    state.ready = true;
    await driver.prepareRevision(revision, revisionContext);
    const workloads = [...objects.values()].filter(({ kind }) => kind === "Deployment");
    const setupInits: unknown[] = [];
    // Every runtime wrapper runs under tini, so it is never PID 1: a Pod stop's
    // SIGTERM ends it in every startup phase, not only once it installs a handler.
    for (const workload of workloads) {
      const pod = deploymentPod(workload);
      assert.deepEqual(firstContainer(pod).command, [...RUNTIME_WRAPPER_COMMAND]);
      // Setup runs under tini too, so a Pod deleted mid-setup stops promptly.
      const inits = records(pod.initContainers ?? []);
      for (const init of inits) {
        assert.deepEqual(init.command, [...SETUP_WRAPPER_COMMAND], String(init.name));
      }
      setupInits.push(...inits.map(({ name }) => name));
    }
    assert.ok(setupInits.includes("prepare-private-state"), setupInits.join());
    assert.ok(setupInits.includes("initialize-workspace"), setupInits.join());
    assertExecStringsWithinBudget(workloads);
    for (const workload of workloads) {
      // Runtime programs travel as bounded pieces and arrive intact.
      const program = containerProgram(firstContainer(deploymentPod(workload)));
      assert.ok(
        [
          gatewayRuntimeEntrypoint(revision.gatewayManagedMode),
          AGENT_RUNTIME_ENTRYPOINT,
          AGENT_WITH_NODE_ENTRYPOINT,
        ].some((entrypoint) => program.endsWith(withoutLineComments(entrypoint))),
      );
    }
  }
  // The supervisor carries its nested Codex program as independently bounded
  // pieces. That child omits native-only helpers used by the standalone command.
  const nestedArgumentsSource = AGENT_WITH_NODE_ENTRYPOINT.match(/args: (\["-e"[^\n]+\]),/u)?.[1];
  assert.ok(nestedArgumentsSource, "expected the embedded Codex command");
  const nestedArguments = strings(JSON.parse(nestedArgumentsSource));
  assert.equal(nestedArguments[1], nodeProgramArguments("")[0]);
  for (const argument of nestedArguments) {
    assert.ok(Buffer.byteLength(argument) <= EXEC_STRING_BUDGET);
  }
  const child = inflateRawSync(Buffer.from(nestedArguments.slice(2).join(""), "base64"));
  const syntax = spawnSync(process.execPath, ["--check", "-"], { input: child });
  assert.equal(syntax.status, 0, syntax.stderr.toString());
}

export function checkLinuxProgramLoader() {
  // Incompressible padding keeps several pieces after compression.
  // A string statement, since whole-line comments never reach the loader.
  const padding = `"${randomBytes(150 * 1024).toString("base64")}";\n`;
  const program = `${padding}const observed = { argv: process.argv.slice(1), file: __filename,
    required: typeof require("node:fs").readFileSync };
process.stdout.write(JSON.stringify(observed));
process.exitCode = 3;`;
  const oversized = spawnSync(process.execPath, ["-e", program]);
  assert.equal(asRecord(oversized.error)?.code, "E2BIG");
  const direct = spawnSync(process.execPath, ["-e", program.slice(padding.length)], {
    encoding: "utf8",
  });
  assert.equal(direct.status, 3);
  assert.deepEqual(JSON.parse(direct.stdout), {
    argv: [],
    file: "[eval]",
    required: "function",
  });
  for (const pack of [nodeProgramArguments, compactNodeChildArguments]) {
    const [loader, ...pieces] = pack(program);
    assert.ok(loader, pack.name);
    assert.ok(pieces.length > 1, pack.name);
    assert.ok(
      pieces.every((piece) => Buffer.byteLength(piece) <= 32 * 1024),
      pack.name,
    );
    const loaded = spawnSync(process.execPath, ["-e", loader, ...pieces], { encoding: "utf8" });
    assert.equal(loaded.stderr, "", pack.name);
    assert.deepEqual([loaded.status, loaded.stdout], [direct.status, direct.stdout], pack.name);
  }
}

export async function checkRuntimeImageProvenance() {
  const driver = new KubernetesComputeDriver(options());
  const revision = routedRevision(driver);
  const commit = "a".repeat(40);
  let generation = 1;
  let mode: "ready" | "restart" | "missing" | "timeout" = "ready";
  const clients = {
    core: {
      async listNamespace() {
        return { items: [] };
      },
      async listNamespacedPod({
        namespace,
        labelSelector,
      }: Parameters<CoreApi["listNamespacedPod"]>[0]) {
        assert.ok(labelSelector);
        const labels = labelSelectorLabels(labelSelector);
        const role = labels["openclaw.dev/workload-role"];
        assert.ok(role);
        return {
          items: [
            {
              metadata: { name: `${role}-pod`, namespace, labels, uid: `${role}-${generation}` },
              spec: {
                containers: [
                  { name: role, image: "runtime:mutable" },
                  { name: "sidecar", image: "sidecar:1" },
                ],
                initContainers: [{ name: "initialize", image: "runtime:mutable" }],
              },
              status: {
                phase: "Running",
                podIP: "10.42.0.13",
                containerStatuses: [
                  { name: role, imageID: "sha256:runtime", containerID: `${role}-${generation}` },
                  { name: "sidecar", imageID: "sha256:sidecar", containerID: "sidecar" },
                ],
                initContainerStatuses: [{ name: "initialize", imageID: "sha256:runtime" }],
              },
            },
          ],
        };
      },
      async connectGetNamespacedPodProxyWithPath() {
        if (mode === "restart") {
          generation += 1;
        }
        if (mode === "missing") {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        if (mode === "timeout") {
          return new Promise<never>((_resolve, reject) => {
            const signal = currentComputeAbortSignal();
            assert.ok(signal, "expected a metadata deadline");
            const timer = setTimeout(
              () => reject(new Error("metadata deadline was not applied")),
              15_000,
            );
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true },
            );
          });
        }
        return { commit, openclawCommit: "b".repeat(40), private: "must not escape" };
      },
    },
  };
  Object.assign(driver, { apiClients: Promise.resolve(clients) });
  const images = await driver.getRuntimeImages(revision);
  assert.equal(images.length, 6);
  assert.deepEqual(
    new Set(images.map((image) => image.workload)),
    new Set([
      `${kubernetesNamespaceName(revision.namespaceId)}/gateway-pod`,
      `${kubernetesNamespaceName(revision.namespaceId)}/agent-pod`,
    ]),
  );
  assert.equal(images.filter((image) => image.commit === commit).length, 4);
  assert.equal(images.filter((image) => image.openclawCommit === "b".repeat(40)).length, 4);
  assert.ok(
    images
      .filter((image) => image.container === "sidecar")
      .every((image) => image.commit === null && image.openclawCommit === null),
  );
  assert.doesNotMatch(JSON.stringify(images), /must not escape/);
  for (mode of ["restart", "missing", "timeout"] as const) {
    const observed = await driver.getRuntimeImages(revision);
    assert.equal(observed.length, 6);
    assert.ok(
      observed.every(
        (image) => image.imageId !== null && image.commit === null && image.openclawCommit === null,
      ),
      mode,
    );
  }
}

export async function checkEmbeddedMainRosterWorkspace() {
  const { driver, revision, objects, context } = workspaceSetupFixture(true);
  const configured = {
    ...revision,
    configuration: {
      ...revision.configuration,
      agents: {
        defaults: {
          ...record(record(revision.configuration.agents).defaults),
          workspace: "/srv/elsewhere",
        },
        entries: { Main: { workspace: "/home/node/.openclaw/workspace" } },
      },
    },
  };
  assert.equal(
    (await driver.prepareRevision(configured, { ...context, secretEnvironment: [] })).ready,
    false,
  );
  const gateway = [...objects.values()].find(
    ({ kind, metadata }) => kind === "Deployment" && metadata.name.startsWith("gateway-"),
  );
  assert.ok(gateway, "Gateway Deployment rendered");
  const pod = deploymentPod(gateway);
  const initializer = records(pod.initContainers).find(
    ({ name }) => name === "initialize-workspace",
  );
  assert.equal(
    records(initializer?.env).find(({ name }) => name === "OPENCLAW_WORKSPACE_DIR")?.value,
    "/home/node/.openclaw/workspace",
  );
  assert.equal(containerProgram(firstContainer(pod)).includes("/srv/elsewhere"), false);
}
