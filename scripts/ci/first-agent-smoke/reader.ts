import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PUBLIC_GITHUB_READ_SKILL } from "../../../apps/controller/src/drivers/repo/github/public-read/codex.ts";
import { installPublicGithubReadFixture } from "../../../tests/helpers/public-github-read-k3d.mjs";
import { compareEvents, eventObservedTime } from "../kubernetes-event-time.ts";
import {
  log,
  minute,
  agentStopDiagnostic,
  type AgentStopState,
  modelContainer,
  root,
  run,
  waitFor,
} from "./process.ts";
import {
  kubectl,
  wireField,
  podList,
  type LocalSetup,
  type SmokeStack,
  type SmokeAgent,
  type Pod,
} from "./setup.ts";
import {
  agentPods,
  cli,
  deployAgent,
  gatewayChat,
  idHash,
  readyGateway,
  type GatewayPod,
  type CodexAdmission,
} from "./agents.ts";

interface Reader {
  peer: {
    namespace: string;
    podLabels: Record<string, string>;
    address: string;
  };
  marker: string;
}

interface HelmValues {
  images: { controller: string };
  controlPlane?: Record<string, unknown>;
}

interface InstallationValues {
  drivers: { compute: { configuration: { network: { publicGithubRead?: Reader["peer"] } } } };
}

// Local Setup installs the controller first. Use its generated Installation and
// chart values to add the reserved reader peer before admitting a revision.
export async function enablePublicReader(stack: LocalSetup): Promise<Reader> {
  const valuesPath = join(stack.directory, "helm-values.json");
  const chartValues: unknown = JSON.parse(await readFile(valuesPath, "utf8"));
  const values = chartValues as HelmValues;
  const fixture: unknown = await installPublicGithubReadFixture({
    namespace: stack.state.platformNamespace,
    controllerImage: values.images.controller,
    kubectl: async (...args: string[]) => (await kubectl(stack, args)).stdout,
    applyManifest: (input: string) => kubectl(stack, ["apply", "-f", "-"], { input }),
    waitFor: (description: string, operation: () => PromiseLike<unknown>, timeout: number) =>
      waitFor(description, async () => ({ done: await operation() }), timeout),
    observeRequests: true,
  });
  const reader = fixture as Reader;
  const installationPath = join(stack.directory, "installation.yaml");
  const installed: unknown = JSON.parse(
    (await run("yq", ["-o=json", ".", installationPath])).stdout,
  );
  const installation = installed as InstallationValues;
  installation.drivers.compute.configuration.network.publicGithubRead = reader.peer;
  const installationData = JSON.stringify(installation);
  await writeFile(installationPath, installationData);
  const patchPath = join(stack.directory, `installation-patch-${randomUUID()}.json`);
  try {
    await writeFile(
      patchPath,
      JSON.stringify({ stringData: { "installation.yaml": installationData } }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    await kubectl(stack, [
      "-n",
      stack.state.platformNamespace,
      "patch",
      "secret",
      "occ-installation-startup",
      "--type=merge",
      `--patch-file=${patchPath}`,
    ]);
  } finally {
    await rm(patchPath, { force: true });
  }
  values.controlPlane = {
    ...values.controlPlane,
    installationChecksum: createHash("sha256").update(installationData).digest("hex"),
  };
  await writeFile(valuesPath, JSON.stringify(values));
  await run("helm", [
    "upgrade",
    "openclaw-enterprise",
    "deploy/helm/openclaw-enterprise",
    "--namespace",
    stack.state.platformNamespace,
    "--kubeconfig",
    stack.kubeconfig,
    "--kube-context",
    stack.context,
    "-f",
    valuesPath,
    "--wait",
    "--timeout",
    "5m",
  ]);
  return reader;
}

interface ReaderRequest {
  event: "reader";
  path: string;
  connection: number;
}

type ReaderEvent =
  | ReaderRequest
  | { event: "provider"; path: string }
  | { event: "connection" | "closed"; connection: number; path?: never };

function readerRequests(events: ReaderEvent[], number: number) {
  return events.filter(
    (event): event is ReaderRequest =>
      event.event === "reader" && event.path.endsWith(`/${number}`),
  );
}

async function readerEvents(stack: LocalSetup): Promise<ReaderEvent[]> {
  const { stdout } = await kubectl(stack, [
    "-n",
    stack.state.platformNamespace,
    "logs",
    "deployment/openclaw-enterprise-public-github-read",
  ]);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      const event: unknown = JSON.parse(line);
      return event as ReaderEvent;
    });
}

async function gatewaySkillStatus(
  stack: LocalSetup,
  gateway: GatewayPod,
): Promise<{ skills: { name: string }[] }> {
  const { stdout } = await kubectl(
    stack,
    [
      "exec",
      "-n",
      gateway.namespace,
      gateway.pod,
      "-c",
      "gateway",
      "--",
      "node",
      "/app/openclaw.mjs",
      "gateway",
      "call",
      "skills.status",
      "--params",
      JSON.stringify({ agentId: "main" }),
      "--json",
      "--timeout",
      "180000",
    ],
    { timeout: 4 * minute },
  );
  const status: unknown = JSON.parse(stdout);
  return status as { skills: { name: string }[] };
}

// Inspect the persisted admission, or invoke the exact Compute withdrawal boundary.
// An Installation change alone does not schedule this observation.
async function observeReaderPeer(
  stack: SmokeStack,
  selected: CodexAdmission,
  action: "inspect" | "withdraw",
) {
  const input = {
    namespaceId: stack.namespaceId,
    agentId: selected.agent.id,
    revisionId: selected.revisionId,
  };
  const script = `
import assert from "node:assert/strict";
import { createPostgresPool, PostgresPlatformState } from "/app/packages/occ/src/index.ts";
import { loadStartupConfigurationSnapshot, loadInstallationConfiguration } from "/app/apps/controller/src/composition/installation-config.ts";
const input = ${JSON.stringify(input)};
const pool = await createPostgresPool(process.env.OCC_DATABASE_URL);
try {
  const state = new PostgresPlatformState(pool);
  const revision = await state.read((view) => view.revisions.findRevision(input.namespaceId, input.agentId, input.revisionId));
  assert.ok(revision, "admitted revision is unavailable");
  const startup = await loadStartupConfigurationSnapshot({ mode: "production" });
  const selected = await loadInstallationConfiguration({ mode: "production", startupConfiguration: startup });
  assert.ok(revision.compute.admission && selected.computeDriver.admitRevision(revision) === revision.compute.admission, "revision did not select the installed reader");
  if (${JSON.stringify(action)} === "withdraw") {
    const configuration = structuredClone(startup.configuration);
    delete configuration.drivers.compute.configuration.network.publicGithubRead;
    const withdrawn = await loadInstallationConfiguration({ mode: "production", startupConfiguration: { ...startup, configuration } });
    await assert.rejects(withdrawn.computeDriver.prepareRevision(revision), (error) => {
      assert.equal(error.message, "Public GitHub reader peer was withdrawn; deploy a new AgentRevision.");
      assert.equal(withdrawn.computeDriver.describePrepareRevisionFailure(error).code, "KUBERNETES_CONFIGURATION_INVALID");
      return true;
    });
  }
  console.log("reader-peer-observed");
} finally { await pool.end(); }
`;
  const admission = await kubectl(
    stack,
    [
      "exec",
      "-i",
      "-n",
      stack.state.platformNamespace,
      "deployment/openclaw-enterprise-worker",
      "-c",
      "worker",
      "--",
      "node",
      "--input-type=module",
      "-",
    ],
    { input: script, timeout: 4 * minute },
  );
  assert.match(admission.stdout, /reader-peer-observed/);
}

async function assertSelectedReaderProjection(
  stack: SmokeStack,
  selected: CodexAdmission,
  gateway: GatewayPod,
) {
  await observeReaderPeer(stack, selected, "inspect");
  log("public reader admission: confirmed");
  const harness = await revisionHarness(stack, selected.agent, selected.revisionId);
  const skillPath = "/home/node/.openclaw/skills/public-github-read/SKILL.md";
  const policy = `allow-public-github-read-${idHash(selected.agent.id)}-rev-${idHash(selected.revisionId)}`;
  const granted = await kubectl(stack, [
    "-n",
    harness.metadata.namespace,
    "get",
    "networkpolicy",
    policy,
    "-o",
    "name",
  ]);
  assert.ok(granted.stdout.trim(), "selected revision has no reader policy");
  log("public reader policy: present");
  for (const [namespace, pod, container] of [
    [gateway.namespace, gateway.pod, "gateway"],
    [harness.metadata.namespace, harness.metadata.name, "agent"],
  ] as const) {
    const observed: unknown = JSON.parse(
      (await kubectl(stack, ["-n", namespace, "get", "pod", pod, "-o", "json"])).stdout,
    );
    const { spec } = observed as {
      spec: {
        containers: Array<{
          name: string;
          volumeMounts?: { mountPath: string; readOnly?: boolean; subPath?: string }[];
        }>;
      };
    };
    const mounts = spec.containers.find(({ name }) => name === container)?.volumeMounts ?? [];
    const mount = mounts.find(({ mountPath }) => mountPath === skillPath);
    assert.ok(
      mount?.readOnly && mount.subPath === PUBLIC_GITHUB_READ_SKILL,
      `${container} skill mount missing`,
    );
    await kubectl(stack, [
      "exec",
      "-n",
      namespace,
      pod,
      "-c",
      container,
      "--",
      "test",
      "-r",
      skillPath,
    ]);
    log(`public reader ${container} mount: present`);
  }
}

export async function publicReadTurn(stack: SmokeStack, selected: CodexAdmission, reader: Reader) {
  const gateway = await readyGateway(stack, selected.agent.id, selected.revisionId);
  await assertSelectedReaderProjection(stack, selected, gateway);
  const status = await gatewaySkillStatus(stack, gateway);
  assert.ok(
    status.skills.some(({ name }) => name === "public-github-read"),
    "managed skill was not discovered",
  );
  log("public reader Gateway discovery: confirmed");
  const prompt =
    "OCE_PUBLIC_READ_JOURNEY: Use the managed public GitHub read skill to obtain pull request 27 in example/public-project and return its title.";
  const result = await gatewayChat(stack, gateway, prompt);
  assert.equal(wireField(result, "status"), 200, "public read model turn failed");
  assert.ok(
    (wireField(result, "content") as string | null | undefined)?.includes(reader.marker),
    "model did not return the provider-only title",
  );
  const events = await readerEvents(stack);
  for (const event of ["reader", "provider"] as const) {
    assert.ok(
      events.some((item) => item.event === event && item.path.endsWith("/27")),
      `${event} did not receive selected read`,
    );
  }
}

async function revisionHarness(stack: LocalSetup, agent: SmokeAgent, revisionId: string) {
  const pods = (await agentPods(stack, agent.id)).filter(
    (pod) =>
      pod.metadata.labels?.["openclaw.dev/workload-role"] === "agent" &&
      pod.metadata.labels?.["openclaw.dev/revision"] === revisionId &&
      pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"),
  );
  assert.equal(pods.length, 1, `expected one ready Harness for ${agent.label}`);
  return pods[0]!;
}

// Keep one Agent-to-reader socket busy, avoiding the reader's idle timeout.
// A second selected Agent performs the same requests throughout the interval.
function holdReaderSocket(stack: LocalSetup, pod: Pod, address: string, number: number) {
  const script = `const http = require('node:http');
const agent = new http.Agent({keepAlive:true, maxSockets:1});
let busy = false;
function read() {
  if (busy) return;
  busy = true;
  const req = http.get({host:${JSON.stringify(address)}, port:8080, path:'/repos/example/public-project/pulls/${number}', agent}, res => {
    res.resume(); res.on('end', () => { if (res.statusCode !== 200) process.exit(2); busy = false; console.log('ok'); });
  });
  req.on('error', () => process.exit(3));
  req.setTimeout(3000, () => req.destroy());
}
read(); const interval = setInterval(read, 1000);
process.stdin.on('data', () => { clearInterval(interval); agent.destroy(); process.exit(0); });`;
  const child = spawn(
    "kubectl",
    [
      "--kubeconfig",
      stack.kubeconfig,
      "--context",
      stack.context,
      "exec",
      "-i",
      "-n",
      pod.metadata.namespace,
      pod.metadata.name,
      "-c",
      "agent",
      "--",
      "node",
      "-e",
      script,
    ],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let closed = false;
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.resume();
  const done = new Promise<void>((resolveDone, reject: (reason: unknown) => void) => {
    child.once("error", reject);
    child.once("close", () => {
      closed = true;
      resolveDone();
    });
  });
  return { child, done, count: () => (output.match(/^ok$/gm) ?? []).length, closed: () => closed };
}

// One line per proveRetirement sub-wait, so a slow retirement step names its slow wait
// (61fba7ca2 spent 357 s of that step in silence). Logged on failure too.
async function retirementWait<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let outcome = "FAILED";
  try {
    const result = await operation();
    outcome = "ok";
    return result;
  } finally {
    log(
      `reader retirement: ${name} ${outcome} at ${new Date().toISOString()} after ${Date.now() - started} ms`,
    );
  }
}

export async function proveRetirement(
  stack: SmokeStack,
  selected: CodexAdmission,
  control: CodexAdmission,
  reader: Reader,
  proofResults: string[],
) {
  const old = await revisionHarness(stack, selected.agent, selected.revisionId);
  const live = await revisionHarness(stack, control.agent, control.revisionId);
  const held = holdReaderSocket(stack, old, reader.peer.address, 28);
  const stillSelected = holdReaderSocket(stack, live, reader.peer.address, 30);
  try {
    await retirementWait("held sockets", () =>
      waitFor(
        "both selected Harness sockets",
        async () => ({
          done: held.count() >= 2 && stillSelected.count() >= 2,
          state: { held: held.count(), control: stillSelected.count() },
        }),
        minute,
      ),
    );
    const before = await readerEvents(stack);
    const oldRequests = readerRequests(before, 28);
    const oldConnection = oldRequests.at(-1)?.connection;
    assert.ok(oldConnection, "selected Harness did not use a reader socket");
    assert.ok(
      !before.some((event) => event.event === "closed" && event.connection === oldConnection),
      "selected socket was not held before retirement",
    );
    const controlRequests = readerRequests(before, 30);
    const controlConnection = controlRequests.at(-1)?.connection;
    assert.ok(controlConnection, "selected control did not use a reader socket");
    assert.notEqual(oldConnection, controlConnection, "held and control sockets must be distinct");
    assert.ok(
      oldRequests.filter((event) => event.connection === oldConnection).length >= 2,
      "selected Harness did not complete two requests on the held socket",
    );
    assert.ok(
      controlRequests.filter((event) => event.connection === controlConnection).length >= 2,
      "control Harness did not complete two requests on its held socket",
    );
    await retirementWait("observeReaderPeer withdraw", () =>
      observeReaderPeer(stack, selected, "withdraw"),
    );
    const deployment = `agent-${idHash(selected.agent.id)}-rev-${idHash(selected.revisionId)}`;
    const { stdout: oldDeployment } = await kubectl(stack, [
      "-n",
      old.metadata.namespace,
      "get",
      "deployment",
      deployment,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    assert.equal(oldDeployment.trim(), "", "withdrawn revision still has a Deployment");
    await retirementWait("old Harness Pod termination", () =>
      waitFor(
        "old Harness Pod to terminate",
        async () => {
          const { stdout } = await kubectl(stack, [
            "-n",
            old.metadata.namespace,
            "get",
            "pods",
            "-l",
            `openclaw.dev/agent=${selected.agent.id},openclaw.dev/revision=${selected.revisionId},openclaw.dev/workload-role=agent`,
            "-o",
            "json",
          ]);
          return { done: podList(stdout).length === 0 };
        },
        2 * minute,
      ),
    );
    const policy = `allow-public-github-read-${idHash(selected.agent.id)}-rev-${idHash(selected.revisionId)}`;
    const { stdout: oldPolicy } = await kubectl(stack, [
      "-n",
      old.metadata.namespace,
      "get",
      "networkpolicy",
      policy,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    assert.equal(oldPolicy.trim(), "", "retired revision still has a reader policy");
    // Capture effects immediately at the absent Deployment, Pod, and policy barrier.
    const barrier = await readerEvents(stack);
    const count = (events: ReaderEvent[], event: "reader" | "provider", number: number) =>
      events.filter((item) => item.event === event && item.path.endsWith(`/${number}`)).length;
    const oldReaderAtBarrier = count(barrier, "reader", 28);
    const oldProviderAtBarrier = count(barrier, "provider", 28);
    const controlReaderAtBarrier = count(barrier, "reader", 30);
    const controlProviderAtBarrier = count(barrier, "provider", 30);
    await retirementWait("retired sockets closed", () =>
      waitFor(
        "retired Harness process and sockets to close",
        async () => {
          const events = await readerEvents(stack);
          const connections = new Set(readerRequests(events, 28).map((event) => event.connection));
          const closed = new Set(
            events.flatMap((event) => (event.event === "closed" ? [event.connection] : [])),
          );
          return {
            done:
              held.closed() &&
              connections.size > 0 &&
              [...connections].every((connection) => closed.has(connection)),
          };
        },
        minute,
      ),
    );
    assert.ok(!stillSelected.closed(), "selected control stopped during withdrawal");
    const unselected = structuredClone(selected.values);
    unselected.plugins.entries.codex.config.appServer.networkProxy!.domains = {};
    await stack.api(
      "PATCH",
      `/namespaces/${stack.namespaceId}/configurations/${selected.configurationId}`,
      { values: unselected },
    );
    const successor = await retirementWait("successor deploy", () =>
      deployAgent(stack, selected.agent),
    );
    const current = await revisionHarness(stack, selected.agent, successor);
    const successorPolicy = `allow-public-github-read-${idHash(selected.agent.id)}-rev-${idHash(successor)}`;
    const { stdout: currentPolicy } = await kubectl(stack, [
      "-n",
      current.metadata.namespace,
      "get",
      "networkpolicy",
      successorPolicy,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    assert.equal(currentPolicy.trim(), "", "unselected successor acquired a reader policy");
    await kubectl(stack, [
      "exec",
      "-n",
      current.metadata.namespace,
      current.metadata.name,
      "-c",
      "agent",
      "--",
      "sh",
      "-c",
      "test ! -e /home/node/.openclaw/skills/public-github-read/SKILL.md",
    ]);
    const successorGateway = await readyGateway(stack, selected.agent.id, successor);
    await kubectl(stack, [
      "exec",
      "-n",
      successorGateway.namespace,
      successorGateway.pod,
      "-c",
      "gateway",
      "--",
      "sh",
      "-c",
      "test ! -e /home/node/.openclaw/skills/public-github-read/SKILL.md",
    ]);
    const successorStatus = await gatewaySkillStatus(stack, successorGateway);
    assert.ok(
      !successorStatus.skills.some(({ name }) => name === "public-github-read"),
      "unselected successor discovered the reader skill",
    );
    log("unselected Gateway and Harness skill: absent");
    const negative = `const http = require('node:http');
const req = http.get({host:${JSON.stringify(reader.peer.address)}, port:8080, path:'/repos/example/public-project/pulls/29'}, res => {res.resume(); process.exit(1)});
const timer = setTimeout(() => req.destroy(new Error('probe-deadline')), 5000);
req.on('error', error => { clearTimeout(timer); process.exit(error.message === 'probe-deadline' || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code) ? 0 : 2); });`;
    const controlBeforeNegative = stillSelected.count();
    await kubectl(
      stack,
      [
        "exec",
        "-n",
        current.metadata.namespace,
        current.metadata.name,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        negative,
      ],
      { timeout: 15_000 },
    );
    await retirementWait("selected control after unselected probe", () =>
      waitFor(
        "selected control after unselected probe",
        async () => {
          const events = await readerEvents(stack);
          return {
            done:
              stillSelected.count() > controlBeforeNegative &&
              count(events, "reader", 30) > controlReaderAtBarrier &&
              count(events, "provider", 30) > controlProviderAtBarrier,
          };
        },
        minute,
      ),
    );
    const after = await readerEvents(stack);
    assert.equal(
      after.filter(
        (event) =>
          (event.event === "reader" || event.event === "provider") && event.path.endsWith("/29"),
      ).length,
      0,
      "unselected request reached reader or provider",
    );
    assert.equal(
      count(after, "reader", 28),
      oldReaderAtBarrier,
      "retired Harness sent a later read",
    );
    assert.equal(
      count(after, "provider", 28),
      oldProviderAtBarrier,
      "retired Harness caused a later provider request",
    );
    const proof =
      `revision=${selected.revisionId} environment=local-setup-k3d skips=0 ` +
      "selected=ok peer-withdrawal=confirmed held-socket=closed old-deployment-pod-policy=gone retired-reader-delta=0 retired-provider-delta=0 unselected-reader=0 unselected-provider=0 selected-control=ok controlled-model-provider";
    proofResults.push(proof);
    log(`public reader: ${proof}`);
    return successor;
  } finally {
    const cleanup = setTimeout(() => {
      held.child.kill("SIGKILL");
      stillSelected.child.kill("SIGKILL");
    }, 5_000);
    try {
      held.child.stdin.end("stop");
      stillSelected.child.stdin.end("stop");
      await Promise.all([held.done, stillSelected.done]);
    } finally {
      clearTimeout(cleanup);
    }
  }
}

// Finding 2224: `kubectl --sort-by=.lastTimestamp` put events that carry only eventTime (written
// through events.k8s.io) first, so the 20 kB tail printed could drop the newest of them. Order by the
// last observed instant (compareEvents), newest last; equal instants keep the API's order.
type EventTimestamps = NonNullable<Parameters<typeof compareEvents>[0]>;

type ClusterEvent = EventTimestamps & {
  metadata?: (NonNullable<EventTimestamps["metadata"]> & { namespace?: string | null }) | null;
  series?: (NonNullable<EventTimestamps["series"]> & { count?: number | null }) | null;
  involvedObject?: { kind?: string | null; name?: string | null } | null;
  count?: number | null;
  type?: string | null;
  reason?: string | null;
  message?: string | null;
};

export function clusterEventLines(list: { items?: readonly ClusterEvent[] | null }) {
  return [...(list.items ?? [])]
    .sort(compareEvents)
    .map((event) => {
      const time = eventObservedTime(event) ?? "unknown-time";
      const object = event.involvedObject ?? {};
      const count = event.series?.count ?? event.count ?? 1;
      return `${time} ${event.metadata?.namespace ?? "-"} ${event.type ?? "-"} ${
        event.reason ?? "-"
      } ${object.kind ?? "-"}/${object.name ?? "-"}${count > 1 ? ` x${count}` : ""}: ${
        event.message ?? ""
      }`;
    })
    .join("\n");
}

export async function diagnostics(stack: (LocalSetup & Partial<SmokeStack>) | undefined) {
  log("collecting diagnostics");
  const attempt = async (label: string, operation: () => Promise<{ stdout: string }>) => {
    try {
      const result = await operation();
      process.stdout.write(`----- ${label}\n${result.stdout.slice(-20_000)}\n`);
    } catch (error) {
      process.stdout.write(
        `----- ${label} unavailable: ${(error as Error).message.slice(0, 500)}\n`,
      );
    }
  };
  await attempt("stand-in provider events", () =>
    run("docker", ["logs", "--tail", "200", modelContainer]),
  );
  if (!stack) {
    return;
  }
  await attempt("pods", () => kubectl(stack, ["get", "pods", "-A", "-o", "wide"]));
  await attempt("events", async () => {
    const { stdout } = await kubectl(stack, ["get", "events", "-A", "-o", "json"]);
    const list: unknown = JSON.parse(stdout);
    return { stdout: clusterEventLines(list as Parameters<typeof clusterEventLines>[0]) };
  });
  for (const agent of stack.agents ?? []) {
    const stopState = await agentStopDiagnostic(
      async () =>
        (await stack.api(
          "GET",
          `/namespaces/${stack.namespaceId}/agents/${agent.id}`,
        )) as AgentStopState,
    );
    process.stdout.write(`----- ${agent.label} Agent stop state\n${JSON.stringify(stopState)}\n`);
    await attempt(`${agent.label} deployment status`, () =>
      cli(stack, ["agent", "deployment-status", agent.id, "-o", "json"]),
    );
    for (const source of ["gateway", "agent"]) {
      await attempt(`${agent.label} ${source} logs`, () =>
        cli(stack, ["agent", "logs", agent.id, "--source", source, "--tail", "300"]),
      );
    }
    for (const [index, output] of (agent.stoppedGatewayLogs ?? []).entries()) {
      process.stdout.write(`----- ${agent.label} stopped gateway ${index + 1} logs\n${output}\n`);
    }
  }
  try {
    const { stdout } = await kubectl(stack, [
      "-n",
      stack.state.platformNamespace,
      "get",
      "pods",
      "-o",
      "jsonpath={.items[*].metadata.name}",
    ]);
    for (const pod of stdout.split(/\s+/).filter(Boolean)) {
      await attempt(`platform Pod ${pod} logs`, () =>
        kubectl(stack, [
          "-n",
          stack.state.platformNamespace,
          "logs",
          pod,
          "--all-containers",
          "--tail",
          "200",
        ]),
      );
    }
  } catch (error) {
    process.stdout.write(
      `----- platform Pods unavailable: ${(error as Error).message.slice(0, 500)}\n`,
    );
  }
}
