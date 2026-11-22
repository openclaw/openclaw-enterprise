import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { admitAcceptance, networkProxyAcceptance } from "./network-proxy-acceptance.ts";
import {
  captureAcceptanceRoots,
  reconcileAcceptanceActivity,
  type RootInventory,
} from "./network-proxy-acceptance-ledger.ts";

const command = promisify(execFile);
const markerName = `network-proxy-acceptance-posts-${networkProxyAcceptance.source}`;
const candidate = resolve("network-proxy-candidate");
const root = join(process.env.RUNNER_TEMP ?? "/tmp", "network-proxy-acceptance");
const statePath = join(root, "state.json");
const laneState = join(root, "lane-state.json");
const laneEnv = join(root, "lane.env");
const fileEnv = join(root, "file.env");
const qaTmp = join(root, "qa-tmp");
const imageJournals = join(root, "image-journals");
const gatePath = join(root, "gate.sock");
const zeroFile = "tests/integration/channel-egress-kubernetes-real.test.ts";
const zeroCases = [
  "channel egress isolates current Driver generations and retires real Agent bindings",
  "a real Slack Gateway uses its admitted upstream proxy and never falls back directly",
];
const postingFiles = {
  topology: "tests/integration/harness-topology-k3d-slack-real.test.mjs",
  helm: "tests/integration/channel-egress-helm-real.test.ts",
  qa: "tests/integration/qa-matrix-real.test.mjs",
} as const;
type Stage = keyof typeof postingFiles;
const stageTests: Record<Stage, string[]> = {
  topology: [
    "production k3d gateway replies once to a real Slack message through its assigned Envoy listener and Codex Agent",
  ],
  helm: [
    "Helm-installed OCC and PostgreSQL deploy isolated Slack routing through real model cutover",
  ],
  qa: [
    "shipped installations: canonical QA matrix",
    "slack",
    "single Slack ingress, one threaded reply and native outbound root",
  ],
};
const overlayPaths = [
  "tests/integration/channel-egress-kubernetes-real.test.ts",
  "tests/integration/qa-matrix-real.test.mjs",
  "tests/helpers/slack-delivery.ts",
  "tests/helpers/qa-slack.mjs",
].sort();
const trustedPaths = [
  "scripts/ci/full-integration-preflight.ts",
  "scripts/ci/network-proxy-acceptance.ts",
  "scripts/ci/network-proxy-acceptance-run.ts",
  "scripts/ci/network-proxy-acceptance-ledger.ts",
  ".github/actions/network-proxy-acceptance/action.yml",
  "tests/fixtures/network-proxy-acceptance/overlay.patch",
  "tests/fixtures/network-proxy-acceptance/acceptance-gate.ts",
  "tests/fixtures/network-proxy-acceptance/select-shipped-runtime.ts",
  "tests/fixtures/network-proxy-acceptance/qa-preflight.mjs",
];
type Checkpoint = {
  stage: Stage;
  reserved: number;
  cumulative: number;
  gates: string[];
  selected: string[];
  sender: number;
  receiver: number;
  fixtureEvidence: true;
};
type Activity = { total: number; receiver: number; sender: number };
const expectedActivity: Record<number, Activity> = {
  0: { total: 0, sender: 0, receiver: 0 },
  2: { total: 2, sender: 1, receiver: 1 },
  4: { total: 4, sender: 2, receiver: 2 },
  6: { total: 6, sender: 3, receiver: 3 },
  7: { total: 7, sender: 3, receiver: 4 },
};
type State = {
  version: 1;
  source: string;
  runId: string;
  attempt: string;
  baseline: string;
  deadline: number;
  roots: RootInventory | null;
  seen: string[];
  observed: Activity;
  zero: string[];
  controller: { hostImageId: string; reference: string } | null;
  qaPreflight: boolean;
  checkpoints: Checkpoint[];
  armed: boolean;
  confirmed: boolean;
  identitiesVerified: boolean;
  apiKeyModelVerified: boolean;
  helloClosed: boolean;
  cleanup: boolean;
  failed: boolean;
};

async function loadState(): Promise<State> {
  const value = JSON.parse(await readFile(statePath, "utf8")) as State;
  assert.ok(
    value.version === 1 &&
      value.source === networkProxyAcceptance.source &&
      value.runId === process.env.GITHUB_RUN_ID &&
      value.attempt === "1",
    "Acceptance state identity is invalid",
  );
  return value;
}

async function saveState(state: State): Promise<void> {
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
}

export async function initializeAcceptance(): Promise<void> {
  assert.ok(
    process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT === "1",
    "Acceptance run identity is missing",
  );
  await mkdir(root, { mode: 0o700, recursive: false });
  const baseline = (Date.now() / 1000).toFixed(6);
  const state: State = {
    version: 1,
    source: networkProxyAcceptance.source,
    runId: process.env.GITHUB_RUN_ID,
    attempt: "1",
    baseline,
    deadline: Date.now() + 150 * 60_000,
    roots: null,
    seen: [],
    observed: { total: 0, receiver: 0, sender: 0 },
    zero: [],
    controller: null,
    qaPreflight: false,
    checkpoints: [],
    armed: false,
    confirmed: false,
    identitiesVerified: false,
    apiKeyModelVerified: false,
    helloClosed: false,
    cleanup: false,
    failed: false,
  };
  await saveState(state);
}

export async function recordIdentityBaseline(): Promise<void> {
  const state = await loadState();
  assert.ok(state.armed && state.confirmed, "The durable marker is not confirmed");
  state.roots = await captureAcceptanceRoots(process.env.SLACK_BOT_TOKEN ?? "", state.baseline);
  state.identitiesVerified = true;
  await saveState(state);
}

export async function recordAcceptancePreflight(kind: "model" | "hello"): Promise<void> {
  const state = await loadState();
  assert.ok(
    state.confirmed && state.identitiesVerified,
    "Protected fixture identity was not verified",
  );
  if (kind === "model") {
    state.apiKeyModelVerified = true;
  } else {
    assert.ok(state.apiKeyModelVerified, "API-key model binding was not verified");
    state.helloClosed = true;
  }
  await saveState(state);
}

function systemEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "RUNNER_TEMP",
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
  ]) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }
  env.CI = "1";
  env.OCC_CI_SUITE_VIEW = "full-integration";
  return env;
}

function candidateEnvironment(posting: boolean): NodeJS.ProcessEnv {
  const env = systemEnvironment();
  Object.assign(env, {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    OCC_TEST_SLACK_CHANNEL_ID: networkProxyAcceptance.channel,
    OCC_TEST_OPENAI_MODEL: process.env.OCC_TEST_OPENAI_MODEL,
    NODE_BASE_IMAGE: process.env.NODE_BASE_IMAGE,
    OCC_TEST_KUBERNETES_GATEWAY_IMAGE: networkProxyAcceptance.runtime,
    OCC_TEST_KUBERNETES_AGENT_IMAGE: networkProxyAcceptance.runtime,
    OCC_TEST_SLACK_LIVE: "1",
  });
  if (posting) {
    env.OCC_TEST_SLACK_SENDER_BOT_TOKEN = process.env.SLACK_SENDER_TOKEN;
    env.OCC_TEST_ACCEPTANCE_GATE = gatePath;
  } else {
    env.OCC_TEST_ZERO_POST_APPROVED = "1";
  }
  assert.ok(
    !env.GITHUB_TOKEN && !env.GH_TOKEN && !env.ACTIONS_RUNTIME_TOKEN,
    "Candidate environment contains a GitHub credential",
  );
  return env;
}

async function readPrepared(path: string): Promise<NodeJS.ProcessEnv> {
  const parsed = parseEnv(await readFile(path, "utf8"));
  return Object.fromEntries(
    Object.entries(parsed).filter(
      ([name]) =>
        name.startsWith("OCC_TEST_") ||
        name.startsWith("OPENCLAW_ENTERPRISE_CI_") ||
        name === "NODE_EXTRA_CA_CERTS",
    ),
  );
}

async function trustedCommand(binary: string, args: string[], cwd = candidate): Promise<string> {
  const result = await command(binary, args, {
    cwd,
    env: systemEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  return result.stdout;
}

async function candidateSource(): Promise<void> {
  assert.equal(
    (await trustedCommand("git", ["rev-parse", "HEAD"])).trim(),
    networkProxyAcceptance.source,
    "Candidate checkout changed",
  );
  const changed = (
    await trustedCommand("git", [
      "diff",
      "--name-only",
      "--",
      "apps",
      "packages",
      "deploy",
      "Dockerfile",
    ])
  ).trim();
  assert.equal(changed, "", "Candidate product source changed");
}

async function verifyTrustedCode(): Promise<void> {
  const sha = process.env.GITHUB_SHA;
  assert.match(sha ?? "", /^[a-f0-9]{40}$/u, "Trusted main revision is missing");
  for (const path of trustedPaths) {
    const expected = (
      await trustedCommand("git", ["rev-parse", `${sha}:${path}`], process.cwd())
    ).trim();
    const actual = (await trustedCommand("git", ["hash-object", "--", path], process.cwd())).trim();
    assert.equal(actual, expected, "Trusted main acceptance code changed after candidate setup");
  }
}

async function applyOverlay(): Promise<void> {
  await candidateSource();
  const fixture = resolve("tests/fixtures/network-proxy-acceptance");
  await trustedCommand("git", ["apply", "--check", join(fixture, "overlay.patch")]);
  await trustedCommand("git", ["apply", join(fixture, "overlay.patch")]);
  await copyFile(
    join(fixture, "acceptance-gate.ts"),
    join(candidate, "tests/helpers/acceptance-gate.ts"),
  );
  const changed = (await trustedCommand("git", ["diff", "--name-only"]))
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    changed,
    overlayPaths,
    "The exact-head overlay changed unexpected candidate files",
  );
  await candidateSource();
}

async function setup(): Promise<void> {
  await admitAcceptance();
  await verifyTrustedCode();
  await candidateSource();
  const selectedDocker = process.env.DOCKER_HOST;
  assert.ok(
    !selectedDocker || selectedDocker.startsWith("unix:///"),
    "Acceptance requires a VM-local Docker socket",
  );
  const context = JSON.parse(await trustedCommand("docker", ["context", "inspect"]));
  const endpoint = selectedDocker || context[0]?.Endpoints?.docker?.Host;
  assert.ok(
    typeof endpoint === "string" && endpoint.startsWith("unix:///"),
    "Acceptance cannot use a remote Docker daemon",
  );
  const socket = await lstat(endpoint.slice("unix://".length));
  assert.ok(socket.isSocket(), "Acceptance Docker endpoint is not a local socket");
  const state = await loadState();
  const observer = process.env.SLACK_BOT_TOKEN ?? "";
  requireActivity(await reconcile(state, 0, observer), 0);
  for (const args of [["install", "--frozen-lockfile"], ["cli:build"]]) {
    await runCandidate(args, systemEnvironment(), state, 0, observer, [], undefined, "pnpm");
  }
  await runCandidate(
    ["scripts/ci/setup-tools.sh", "browser"],
    systemEnvironment(),
    state,
    0,
    observer,
    [],
    undefined,
    "bash",
  );
  await verifyTrustedCode();
  await candidateSource();
}

async function contexts(): Promise<{ kubeconfig: string; context: string }[]> {
  const result: { kubeconfig: string; context: string }[] = [];
  try {
    const journal = JSON.parse(await readFile(laneState, "utf8"));
    for (const resource of journal.resources ?? []) {
      if (resource.kind === "k3d-cluster" && resource.kubeconfig && resource.context) {
        result.push({ kubeconfig: resource.kubeconfig, context: resource.context });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    for (const entry of await readdir(qaTmp, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^occ-dev-qa-k-[a-f0-9]{8}-/u.test(entry.name)) {
        continue;
      }
      const directory = join(qaTmp, entry.name, "state");
      let journal;
      try {
        journal = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      assert.ok(
        typeof journal.cluster === "string" && /^occ-dev-qa-k-[a-f0-9]{8}$/u.test(journal.cluster),
        "QA cluster ownership is invalid",
      );
      result.push({ kubeconfig: join(directory, "kubeconfig"), context: `k3d-${journal.cluster}` });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return result;
}

type GatewayPod = {
  metadata: { namespace: string; name: string };
  spec: { containers: { name: string; env?: { name: string }[] }[] };
  status?: {
    phase?: string;
    containerStatuses?: { name: string; state?: { running?: unknown } }[];
  };
};
async function consumerPods(): Promise<{ pod: GatewayPod; prefix: string[] }[]> {
  const result: { pod: GatewayPod; prefix: string[] }[] = [];
  for (const item of await contexts()) {
    const prefix = ["--kubeconfig", item.kubeconfig, "--context", item.context];
    const list = JSON.parse(
      await trustedCommand("kubectl", [
        ...prefix,
        "get",
        "pods",
        "-A",
        "-l",
        "openclaw.dev/workload-role=gateway",
        "-o",
        "json",
      ]),
    ) as { items?: GatewayPod[] };
    assert.ok(Array.isArray(list.items), "Owned Gateway Pod inventory is invalid");
    for (const pod of list.items) {
      assert.ok(
        Array.isArray(pod.spec?.containers) &&
          typeof pod.metadata?.namespace === "string" &&
          typeof pod.metadata?.name === "string",
        "Owned Gateway Pod metadata is invalid",
      );
      const gateway = pod.spec.containers.find((container) => container.name === "gateway");
      assert.ok(
        gateway && (gateway.env === undefined || Array.isArray(gateway.env)),
        "Owned Gateway container metadata is invalid",
      );
      if (gateway.env?.some((entry) => entry.name === "SLACK_APP_TOKEN")) {
        result.push({ pod, prefix });
      }
    }
  }
  return result;
}

async function gatewayConsumers(): Promise<number> {
  return (await consumerPods()).length;
}

async function checkConsumerWarnings(expected: number): Promise<void> {
  const consumers = await consumerPods();
  assert.ok(consumers.length <= expected, "Unexpected owned Slack Gateway count");
  for (const { pod, prefix } of consumers) {
    const running = pod.status?.containerStatuses?.some(
      (item) => item.name === "gateway" && item.state?.running,
    );
    if (!running) {
      continue;
    }
    const logs = await trustedCommand("kubectl", [
      ...prefix,
      "-n",
      pod.metadata.namespace,
      "logs",
      pod.metadata.name,
      "-c",
      "gateway",
      "--tail=200",
    ]);
    const counts = [...logs.matchAll(/num_connections[^0-9]*(\d+)/giu)].map((match) =>
      Number(match[1]),
    );
    assert.ok(
      counts.every((count) => count <= expected) &&
        !/unexpected (?:socket mode )?consumer/iu.test(logs),
      "Gateway reported an unexpected Socket Mode consumer",
    );
  }
}

let reconciliation: Promise<unknown> = Promise.resolve();
export function assertObservedActivityPersists(
  previous: { seen: string[]; observed: Activity },
  next: Activity & { seenIds: string[] },
): void {
  assert.ok(
    previous.seen.every((id) => next.seenIds.includes(id)) &&
      next.total >= previous.observed.total &&
      next.receiver >= previous.observed.receiver &&
      next.sender >= previous.observed.sender,
    "Previously observed Slack activity disappeared or regressed",
  );
}
async function reconcile(state: State, maximum: number, token: string): Promise<Activity> {
  const work = reconciliation.then(async () => {
    assert.ok(state.roots, "Acceptance root baseline is missing");
    const result = await reconcileAcceptanceActivity(token, state.baseline, state.roots);
    const activity = { total: result.total, receiver: result.receiver, sender: result.sender };
    assertObservedActivityPersists(state, result);
    state.seen = result.seenIds;
    state.observed = activity;
    await saveState(state);
    assert.ok(
      activity.total <= maximum,
      "Acceptance observed unexpected or extra channel activity",
    );
    return activity;
  });
  reconciliation = work.catch(() => {});
  return work;
}

function requireActivity(activity: Activity, count: number): void {
  assert.deepEqual(activity, expectedActivity[count], "Acceptance actor counts did not reconcile");
}

type ProcessResult = {
  tests: number;
  pass: number;
  skipped: number;
  selected: string[];
  selectedSkipped: string[];
};
export function recordAcceptanceTap(
  result: ProcessResult,
  line: string,
  expected: readonly string[],
): void {
  const summary = /^\s*#\s+(tests|pass|skipped)\s+(\d+)\s*$/u.exec(line);
  if (summary) {
    result[summary[1] as "tests" | "pass" | "skipped"] = Number(summary[2]);
  }
  const item = /^\s*ok\s+\d+\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO)\b.*)?\s*$/u.exec(line);
  if (item && expected.includes(item[1]!)) {
    (item[2] ? result.selectedSkipped : result.selected).push(item[1]!);
  }
}

async function runCandidate(
  args: string[],
  env: NodeJS.ProcessEnv,
  state: State,
  maximum: number,
  observer: string,
  expected: readonly string[] = [],
  consumerCheck?: () => Promise<void>,
  binary = process.execPath,
): Promise<ProcessResult> {
  const remaining = Math.min(45 * 60_000, state.deadline - Date.now());
  assert.ok(remaining > 0, "Acceptance execution deadline elapsed; cleanup time is reserved");
  const child = spawn(binary, args, {
    cwd: candidate,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const summary: ProcessResult = {
    tests: 0,
    pass: 0,
    skipped: 0,
    selected: [],
    selectedSkipped: [],
  };
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      recordAcceptanceTap(summary, line, expected);
    }
    if (pending.length > 8192) {
      pending = "";
    }
  });
  child.stderr.on("data", () => {});
  let guardFailure: unknown;
  let checking = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* The process group already exited. */
      }
      killTimer ??= setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* The process group already exited. */
        }
      }, 5_000);
    }
  };
  const timer = setInterval(async () => {
    if (checking) {
      return;
    }
    checking = true;
    try {
      await reconcile(state, maximum, observer);
      await consumerCheck?.();
    } catch (error) {
      guardFailure = error;
      stop();
    } finally {
      checking = false;
    }
  }, 30_000);
  const deadline = setTimeout(() => {
    guardFailure = new Error("Acceptance stage exceeded its deadline");
    stop();
  }, remaining);
  let result: number | null;
  try {
    result = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
    clearTimeout(killTimer);
  }
  if (guardFailure) {
    throw guardFailure;
  }
  assert.equal(result, 0, "Candidate acceptance stage failed");
  if (expected.length) {
    assert.ok(
      summary.tests > 0 &&
        summary.pass > 0 &&
        summary.selectedSkipped.length === 0 &&
        expected.every((name) => summary.selected.filter((value) => value === name).length === 1),
      "An intended selected acceptance test did not pass or was skipped",
    );
  }
  return summary;
}

async function prepareFile(
  path: string,
  base: NodeJS.ProcessEnv,
  state: State,
  maximum: number,
  observer: string,
): Promise<NodeJS.ProcessEnv> {
  await rm(fileEnv, { force: true });
  const prep = {
    ...base,
    OCC_TEST_SLACK_SENDER_BOT_TOKEN:
      base.OCC_TEST_SLACK_SENDER_BOT_TOKEN || "approved-sender-withheld-from-zero-post",
  };
  await runCandidate(
    [
      "scripts/ci/prepare.ts",
      "--lane",
      "slack",
      "--file",
      path,
      "--state",
      laneState,
      "--github-env",
      fileEnv,
    ],
    prep,
    state,
    maximum,
    observer,
  );
  return { ...base, ...(await readPrepared(laneEnv)), ...(await readPrepared(fileEnv)) };
}

async function zero(): Promise<void> {
  await admitAcceptance();
  await verifyTrustedCode();
  const state = await loadState();
  assert.ok(state.armed && state.confirmed, "The durable marker is not confirmed");
  assert.ok(
    state.identitiesVerified && state.apiKeyModelVerified && state.helloClosed,
    "Protected identity, API-key model, or isolated hello/closure evidence is missing",
  );
  const observer = process.env.SLACK_BOT_TOKEN ?? "";
  requireActivity(await reconcile(state, 0, observer), 0);
  await applyOverlay();
  const base = candidateEnvironment(false);
  const prep = {
    ...base,
    OCC_TEST_SLACK_SENDER_BOT_TOKEN: "approved-sender-withheld-from-zero-post",
  };
  await runCandidate(
    ["scripts/ci/prepare.ts", "--lane", "slack", "--state", laneState, "--github-env", laneEnv],
    prep,
    state,
    0,
    observer,
  );
  state.controller = await validatePreparedController();
  await saveState(state);
  await admitAcceptance();
  const env = await prepareFile(zeroFile, base, state, 0, observer);
  delete env.OCC_TEST_SLACK_SENDER_BOT_TOKEN;
  const summary = await runCandidate(
    ["--test", "--test-reporter=tap", zeroFile],
    env,
    state,
    0,
    observer,
    zeroCases,
    () => checkConsumerWarnings(2),
  );
  assert.ok(
    summary.tests === 2 && summary.pass === 2 && summary.skipped === 0,
    "Both zero-post tests must pass without skips",
  );
  assert.equal(await gatewayConsumers(), 0, "A zero-post Gateway consumer remains after teardown");
  requireActivity(await reconcile(state, 0, observer), 0);
  state.zero.push(...zeroCases);
  await saveState(state);
}

type Artifact = { name?: string; expired?: boolean; workflow_run?: { id?: number } };
async function artifactList(): Promise<Artifact[]> {
  const token = process.env.GITHUB_TOKEN;
  assert.ok(token, "GitHub artifact reader is required");
  const url = `https://api.github.com/repos/${networkProxyAcceptance.repository}/actions/artifacts?name=${markerName}&per_page=100`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, "Acceptance marker lookup failed");
  const result = await response.json();
  assert.ok(
    Array.isArray(result.artifacts) && result.total_count === result.artifacts.length,
    "Acceptance marker lookup is incomplete",
  );
  return result.artifacts as Artifact[];
}

async function arm(): Promise<void> {
  await admitAcceptance();
  const { acceptanceHistory } = await import("./network-proxy-acceptance.ts");
  const history = await acceptanceHistory(process.env.GITHUB_TOKEN ?? "");
  assert.ok(
    history.orphaned.length === 0 &&
      history.acceptance.every((run) => String(run.id) === process.env.GITHUB_RUN_ID),
    "A prior acceptance job exists; redispatch is forbidden even if its marker was deleted",
  );
  assert.equal(
    (await artifactList()).length,
    0,
    "A prior post marker exists; automatic redispatch is forbidden",
  );
  await initializeAcceptance();
  const state = await loadState();
  await writeFile(
    join(root, "post-marker.json"),
    JSON.stringify({ source: state.source, runId: state.runId, attempt: state.attempt }),
    { mode: 0o600, flag: "wx" },
  );
  state.armed = true;
  await saveState(state);
}

async function confirm(): Promise<void> {
  const state = await loadState();
  assert.ok(state.armed, "Acceptance marker was not armed");
  await confirmMarker(state);
  state.confirmed = true;
  await saveState(state);
}

async function confirmMarker(state: State): Promise<void> {
  const list = await artifactList();
  assert.ok(
    list.length === 1 &&
      list[0]!.name === markerName &&
      String(list[0]!.workflow_run?.id) === state.runId &&
      list[0]!.expired === false,
    "The durable current-run marker was not confirmed",
  );
}

async function gateServer(state: State, stage: Stage, expected: number, observer: string) {
  await rm(gatePath, { force: true });
  const gates: string[] = [];
  let failure: unknown;
  const server = createServer(async (request, response) => {
    try {
      assert.ok(request.method === "POST" && request.url === "/gate", "Invalid post gate request");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        assert.ok(body.length <= 256, "Post gate request is oversized");
      }
      const operation = JSON.parse(body).operation;
      const required =
        operation === "sender" ? expected : stage === "qa" && operation === "qa-root" ? 6 : -1;
      assert.ok(
        required >= 0 && !gates.includes(operation),
        "Post gate request is repeated or invalid",
      );
      await admitAcceptance();
      await verifyTrustedCode();
      await candidateSource();
      requireActivity(await reconcile(state, required, observer), required);
      assert.equal(await gatewayConsumers(), 1, "Posting requires exactly one owned Slack Gateway");
      await checkConsumerWarnings(1);
      gates.push(operation);
      response.writeHead(204).end();
    } catch (error) {
      failure = error;
      response.writeHead(409).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(gatePath, resolve);
  });
  await chmod(gatePath, 0o600);
  return {
    gates,
    failure: () => failure,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(gatePath, { force: true });
    },
  };
}

async function validatePreparedController(): Promise<{ hostImageId: string; reference: string }> {
  const journal = JSON.parse(await readFile(laneState, "utf8")) as {
    resources?: { kind?: string; reference?: string; sourceImage?: string; hostImageId?: string }[];
  };
  const resource = (journal.resources ?? []).find(
    (item) => item.kind === "k3d-image" && String(item.reference).includes("/controller@"),
  );
  assert.ok(
    resource?.sourceImage &&
      /^sha256:[a-f0-9]{64}$/u.test(resource?.hostImageId ?? "") &&
      /^\S+@sha256:[a-f0-9]{64}$/u.test(resource?.reference ?? ""),
    "Candidate controller image ownership is missing",
  );
  const inspected = JSON.parse(
    await trustedCommand("docker", ["image", "inspect", resource.sourceImage]),
  )[0];
  assert.equal(inspected.Id, resource.hostImageId, "Host controller image identity changed");
  return { hostImageId: resource.hostImageId!, reference: resource.reference! };
}

async function qaPreflight(): Promise<void> {
  await admitAcceptance();
  await verifyTrustedCode();
  await candidateSource();
  const state = await loadState();
  assert.deepEqual(state.zero, zeroCases, "Zero-post transport proof is incomplete");
  assert.ok(
    state.controller && process.env.CODEX_PAT && process.env.OCC_TEST_QA_CODEX_MODEL,
    "Canonical QA model prerequisites are missing",
  );
  const observer = process.env.SLACK_BOT_TOKEN ?? "";
  requireActivity(await reconcile(state, 0, observer), 0);
  await mkdir(qaTmp, { recursive: true, mode: 0o700 });
  const file = join(root, "codex-preflight.secret");
  await writeFile(file, process.env.CODEX_PAT, { mode: 0o600, flag: "wx" });
  try {
    const env = {
      ...systemEnvironment(),
      TMPDIR: qaTmp,
      NODE_BASE_IMAGE: process.env.NODE_BASE_IMAGE,
      OCC_TEST_QA_CODEX_TOKEN_FILE: file,
      OCC_TEST_QA_CODEX_MODEL: process.env.OCC_TEST_QA_CODEX_MODEL,
      OCC_TEST_QA_SOURCE_SHA: networkProxyAcceptance.source,
      OCC_TEST_ACCEPTANCE_IMAGE_JOURNAL_DIR: imageJournals,
    };
    const selected =
      "network proxy QA qualifies canonical Codex PAT and shipped runtime before any Slack post";
    const summary = await runCandidate(
      [
        "--test",
        "--test-reporter=tap",
        resolve("tests/fixtures/network-proxy-acceptance/qa-preflight.mjs"),
      ],
      env,
      state,
      0,
      observer,
      [selected],
      () => checkConsumerWarnings(0),
    );
    assert.ok(
      summary.tests === 1 && summary.pass === 1 && summary.skipped === 0,
      "Canonical QA auth qualification did not pass alone",
    );
    assert.equal(await gatewayConsumers(), 0, "Canonical QA preflight left a Slack consumer");
    requireActivity(await reconcile(state, 0, observer), 0);
    state.qaPreflight = true;
    await saveState(state);
  } finally {
    await rm(file, { force: true });
  }
}

async function qaEnvironment(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  await mkdir(qaTmp, { mode: 0o700, recursive: true });
  const secrets = {
    codex: process.env.CODEX_PAT,
    app: process.env.SLACK_APP_TOKEN,
    bot: process.env.SLACK_BOT_TOKEN,
    sender: process.env.SLACK_SENDER_TOKEN,
  };
  for (const [name, value] of Object.entries(secrets)) {
    assert.ok(value, "QA credential is missing");
    await writeFile(join(root, `${name}.secret`), value, { mode: 0o600, flag: "wx" });
  }
  const env: NodeJS.ProcessEnv = {
    ...base,
    TMPDIR: qaTmp,
    OCC_TEST_QA_MATRIX: "1",
    OCC_TEST_QA_INSTALLATION: "kubernetes",
    OCC_TEST_QA_PRESET: "Codex",
    OCC_TEST_QA_SCENARIOS: "slack",
    OCC_TEST_NETWORK_PROXY_ACCEPTANCE: "1",
    OCC_TEST_ACCEPTANCE_RUNTIME_SELECTOR: pathToFileURL(
      resolve("tests/fixtures/network-proxy-acceptance/select-shipped-runtime.ts"),
    ).href,
    OCC_TEST_ACCEPTANCE_IMAGE_JOURNAL_DIR: imageJournals,
    OCC_TEST_QA_CUSTOM_PERMISSION_PROFILES: "1",
    OCC_TEST_QA_CODEX_TOKEN_FILE: join(root, "codex.secret"),
    OCC_TEST_QA_SLACK_APP_TOKEN_FILE: join(root, "app.secret"),
    OCC_TEST_QA_SLACK_BOT_TOKEN_FILE: join(root, "bot.secret"),
    OCC_TEST_QA_SLACK_SENDER_TOKEN_FILE: join(root, "sender.secret"),
    OCC_TEST_QA_SLACK_CHANNEL_ID: networkProxyAcceptance.channel,
    OCC_TEST_QA_CODEX_MODEL: process.env.OCC_TEST_QA_CODEX_MODEL,
    OCC_TEST_QA_SOURCE_SHA: networkProxyAcceptance.source,
    OCC_TEST_QA_ARTIFACTS: join(root, "qa-evidence"),
  };
  delete env.OPENAI_API_KEY;
  delete env.SLACK_APP_TOKEN;
  delete env.SLACK_BOT_TOKEN;
  delete env.OCC_TEST_SLACK_SENDER_BOT_TOKEN;
  return env;
}

async function fixtureEvidence(stage: Stage): Promise<void> {
  const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const delivery = await read(
    stage === "qa"
      ? join(root, "qa-evidence", "kubernetes-Codex-slack.json")
      : join(root, `${stage}-delivery.json`),
  );
  assert.ok(
    delivery.channel === networkProxyAcceptance.channel &&
      delivery.botId === networkProxyAcceptance.receiverBot &&
      delivery.senderId === networkProxyAcceptance.sender &&
      delivery.initialMessages === 1 &&
      delivery.visibleResponses === 1 &&
      delivery.replyMode === (stage === "qa" ? "thread" : "root") &&
      delivery.observationMs >= 60_000 &&
      /^\d+\.\d+$/u.test(delivery.originalThreadTs) &&
      /^\d+\.\d+$/u.test(delivery.responseTs),
    "Selected delivery fixture evidence is invalid",
  );
  if (stage === "helm") {
    assert.ok(
      delivery.workflow === "production-helm" && delivery.deliveries?.length === 1,
      "The selected Helm fixture was not the non-upgrade one-delivery case",
    );
  }
  if (stage === "qa") {
    const proxy = await read(
      join(root, "qa-evidence", "kubernetes-Codex-channel-upstream-proxy.json"),
    );
    const outbound = await read(
      join(root, "qa-evidence", "kubernetes-Codex-slack-outbound-root.json"),
    );
    assert.ok(
      proxy.authenticatedConnections >= 2 &&
        proxy.agentId === outbound.agentId &&
        proxy.revisionId === outbound.revisionId &&
        delivery.native?.agentId === outbound.agentId &&
        outbound.channel === networkProxyAcceptance.channel &&
        outbound.botId === networkProxyAcceptance.receiverBot &&
        outbound.visibleMessages === 1 &&
        outbound.observationMs >= 60_000,
      "The named QA proxy, threaded delivery, and outbound-root evidence is incomplete",
    );
    const revision = String(outbound.revisionId).replaceAll(/[^a-zA-Z0-9-]/gu, "-");
    const pods = await read(
      join(root, "qa-evidence", `kubernetes-network-proxy-shipped-pods-${revision}.json`),
    );
    assert.ok(
      Array.isArray(pods) &&
        pods.length === 2 &&
        ["gateway", "agent"].every((role) =>
          pods.some(
            (item) =>
              item.role === role &&
              String(item.image).endsWith(
                "@sha256:6d2af2efbc2e0ceb8435e5dfe4bcb22b2dd38d09fd31c1374652d4094adb432e",
              ) &&
              /sha256:(?:6d2af2efbc2e0ceb8435e5dfe4bcb22b2dd38d09fd31c1374652d4094adb432e|e4c1426181a2bf471688d7e85041f041926631187e8596f3a48c86bdb6b07a10)$/u.test(
                String(item.imageID),
              ),
          ),
        ),
      "The Slack-enabled QA revision did not run the qualified shipped Gateway and Harness",
    );
  }
}

async function postings(): Promise<void> {
  const state = await loadState();
  assert.ok(state.armed && state.confirmed, "Acceptance post marker was not confirmed");
  assert.deepEqual(state.zero, zeroCases, "Zero-post evidence is incomplete");
  assert.ok(
    state.qaPreflight && state.controller,
    "Canonical QA auth and controller qualification must pass before posting",
  );
  await confirmMarker(state);
  const observer = process.env.SLACK_SENDER_TOKEN ?? "";
  const stages: { name: Stage; before: number; reserve: number }[] = [
    { name: "topology", before: 0, reserve: 2 },
    { name: "helm", before: 2, reserve: 2 },
    { name: "qa", before: 4, reserve: 3 },
  ];
  for (const stage of stages) {
    await admitAcceptance();
    await verifyTrustedCode();
    await candidateSource();
    requireActivity(await reconcile(state, stage.before, observer), stage.before);
    assert.equal(await gatewayConsumers(), 0, "A prior posting consumer remains");
    const gate = await gateServer(state, stage.name, stage.before, observer);
    try {
      let env = candidateEnvironment(true);
      if (stage.name === "qa") {
        env = await qaEnvironment(env);
      } else {
        env = await prepareFile(postingFiles[stage.name], env, state, stage.before, observer);
        env.OCC_TEST_SLACK_EVIDENCE_PATH = join(root, `${stage.name}-delivery.json`);
      }
      const expected = stageTests[stage.name];
      const summary = await runCandidate(
        ["--test", "--test-reporter=tap", postingFiles[stage.name]],
        env,
        state,
        stage.before + stage.reserve,
        observer,
        expected,
        () => checkConsumerWarnings(gate.gates.length ? 1 : 2),
      );
      if (stage.name !== "qa") {
        assert.ok(
          summary.tests === 1 && summary.pass === 1 && summary.skipped === 0,
          "The focused delivery test did not pass alone",
        );
      }
      if (gate.failure()) {
        throw gate.failure();
      }
      assert.deepEqual(
        gate.gates,
        stage.name === "qa" ? ["sender", "qa-root"] : ["sender"],
        "Required post gates were not exercised",
      );
      assert.equal(await gatewayConsumers(), 0, "Posting consumer teardown is incomplete");
      const activity = await reconcile(state, stage.before + stage.reserve, observer);
      requireActivity(activity, stage.before + stage.reserve);
      await fixtureEvidence(stage.name);
      state.checkpoints.push({
        stage: stage.name,
        reserved: stage.reserve,
        cumulative: activity.total,
        sender: activity.sender,
        receiver: activity.receiver,
        fixtureEvidence: true,
        gates: [...gate.gates],
        selected: expected,
      });
      await saveState(state);
    } finally {
      await gate.close();
    }
  }
}

async function cleanup(): Promise<void> {
  let state: State;
  try {
    state = await loadState();
  } catch {
    return;
  }
  const failures: string[] = [];
  const ownedClusters = new Set<string>();
  const attempt = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch {
      failures.push(name);
    }
  };
  await attempt("inventory", async () => {
    for (const item of await contexts()) {
      assert.ok(item.context.startsWith("k3d-"));
      ownedClusters.add(item.context.slice(4));
    }
  });
  for (const entry of await readdir(imageJournals, { withFileTypes: true }).catch(() => [])) {
    await attempt("image-journal", async () => {
      const match = /^(occ-dev-qa-k-[a-f0-9]{8})\.json$/u.exec(entry.name);
      assert.ok(entry.isFile() && match, "Unexpected QA image journal identity");
      const cluster = match[1]!;
      ownedClusters.add(cluster);
      const journal = JSON.parse(await readFile(join(imageJournals, entry.name), "utf8"));
      assert.ok(
        journal.prefix === `network-proxy-${cluster}` &&
          /^sha256:[a-f0-9]{64}$/u.test(journal.hostImageId ?? ""),
        "QA image journal ownership is invalid",
      );
      for (const resource of journal.resources ?? []) {
        if (resource.kind !== "image-tag") {
          continue;
        }
        assert.ok(
          typeof resource.name === "string" &&
            resource.name.startsWith(`localhost/${cluster}/`) &&
            resource.name.endsWith(":local"),
          "QA host tag ownership is invalid",
        );
        const current = await trustedCommand("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          resource.name,
        ]).catch(() => undefined);
        if (current !== undefined) {
          assert.equal(current.trim(), journal.hostImageId, "QA host tag identity changed");
          await trustedCommand("docker", ["image", "rm", resource.name]);
        }
      }
    });
  }
  for (const entry of await readdir(qaTmp, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^occ-dev-qa-k-[a-f0-9]{8}-/u.test(entry.name)) {
      continue;
    }
    await attempt("qa-installation", async () => {
      const directory = join(qaTmp, entry.name, "state");
      let journal;
      try {
        journal = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return;
        }
        throw error;
      }
      assert.ok(
        typeof journal.cluster === "string" && entry.name.startsWith(journal.cluster + "-"),
        "QA installation ownership changed",
      );
      ownedClusters.add(journal.cluster);
      await command(join(candidate, "scripts/dev-down"), [], {
        cwd: candidate,
        env: { ...systemEnvironment(), OCC_DEVELOPMENT_STATE_DIRECTORY: directory },
        timeout: 300_000,
      });
    });
  }
  await attempt("lane", async () => {
    try {
      await readFile(laneState);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    await command(process.execPath, ["scripts/ci/cleanup.ts", "--state", laneState], {
      cwd: candidate,
      env: systemEnvironment(),
      timeout: 600_000,
    });
  });
  await attempt("retirement", async () => {
    assert.equal((await contexts()).length, 0, "Owned acceptance state remains");
    if (ownedClusters.size > 0) {
      const clusters = JSON.parse(await trustedCommand("k3d", ["cluster", "list", "-o", "json"]));
      assert.ok(
        Array.isArray(clusters) && clusters.every((item) => !ownedClusters.has(item.name)),
        "An owned acceptance cluster remains",
      );
    }
  });
  for (const name of ["codex", "codex-preflight", "app", "bot", "sender"]) {
    await attempt("credential-file", () => rm(join(root, `${name}.secret`), { force: true }));
  }
  for (const path of [
    laneEnv,
    fileEnv,
    join(root, "topology-delivery.json"),
    join(root, "helm-delivery.json"),
  ]) {
    await attempt("private-file", () => rm(path, { force: true }));
  }
  await attempt("qa-evidence", () =>
    rm(join(root, "qa-evidence"), { recursive: true, force: true }),
  );
  if (failures.length === 0) {
    await attempt("qa-directory", () => rm(qaTmp, { recursive: true, force: true }));
    await attempt("image-directory", () => rm(imageJournals, { recursive: true, force: true }));
  }
  const failure = failures.length > 0;
  state.cleanup = !failure;
  state.failed =
    failure || state.zero.length !== 2 || !state.qaPreflight || state.checkpoints.length !== 3;
  await saveState(state);
  const receipt = {
    version: 1,
    source: state.source,
    runId: state.runId,
    attempt: state.attempt,
    identitiesVerified: state.identitiesVerified,
    apiKeyModelVerified: state.apiKeyModelVerified,
    hello: {
      app: networkProxyAcceptance.app,
      numConnections: 1,
      closed: state.helloClosed,
      continuousAuthoritativeMonitoring: false,
    },
    zero: state.zero,
    qaPreflight: { auth: "codex_pat", passed: state.qaPreflight },
    controller: state.controller,
    checkpoints: state.checkpoints,
    cleanup: state.cleanup,
    status: state.failed ? "failed" : "passed",
    subscriptions: "unverified; accepted off-channel App Home/Assistant risk",
    limitations:
      "observational intended seven-post budget; no Slack-side hard cap; transient between-poll posts/deletions and off-channel writes are unobservable; protected approval trusts the exact candidate as fully privileged same-UID code",
  };
  await writeFile(join(root, "receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
  if (failure) {
    throw new Error("Acceptance cleanup could not be confirmed");
  }
}

async function aggregate(path: string | undefined): Promise<void> {
  assert.ok(path, "Acceptance receipt path is required");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  assert.ok(
    receipt.version === 1 &&
      receipt.source === networkProxyAcceptance.source &&
      receipt.runId === process.env.GITHUB_RUN_ID &&
      receipt.attempt === "1" &&
      receipt.identitiesVerified === true &&
      receipt.apiKeyModelVerified === true &&
      receipt.hello?.app === networkProxyAcceptance.app &&
      receipt.hello?.numConnections === 1 &&
      receipt.hello?.closed === true &&
      receipt.hello?.continuousAuthoritativeMonitoring === false &&
      receipt.status === "passed" &&
      receipt.subscriptions === "unverified; accepted off-channel App Home/Assistant risk" &&
      receipt.limitations ===
        "observational intended seven-post budget; no Slack-side hard cap; transient between-poll posts/deletions and off-channel writes are unobservable; protected approval trusts the exact candidate as fully privileged same-UID code" &&
      receipt.cleanup === true,
    "Acceptance receipt identity or cleanup is invalid",
  );
  assert.deepEqual(receipt.zero, zeroCases);
  assert.deepEqual(receipt.qaPreflight, { auth: "codex_pat", passed: true });
  assert.ok(
    /^sha256:[a-f0-9]{64}$/u.test(receipt.controller?.hostImageId ?? "") &&
      /^\S+@sha256:[a-f0-9]{64}$/u.test(receipt.controller?.reference ?? ""),
    "Controller admission evidence is missing",
  );
  assert.deepEqual(
    receipt.checkpoints.map(({ stage, reserved, cumulative, gates }: Checkpoint) => ({
      stage,
      reserved,
      cumulative,
      gates,
    })),
    [
      { stage: "topology", reserved: 2, cumulative: 2, gates: ["sender"] },
      { stage: "helm", reserved: 2, cumulative: 4, gates: ["sender"] },
      { stage: "qa", reserved: 3, cumulative: 7, gates: ["sender", "qa-root"] },
    ],
  );
  assert.deepEqual(
    receipt.checkpoints.map(({ sender, receiver, fixtureEvidence }: Checkpoint) => ({
      sender,
      receiver,
      fixtureEvidence,
    })),
    [
      { sender: 1, receiver: 1, fixtureEvidence: true },
      { sender: 2, receiver: 2, fixtureEvidence: true },
      { sender: 3, receiver: 4, fixtureEvidence: true },
    ],
  );
  assert.deepEqual(
    receipt.checkpoints.map((item: Checkpoint) => item.selected),
    [stageTests.topology, stageTests.helm, stageTests.qa],
  );
}

export async function runAcceptanceOperation(mode: string, path?: string): Promise<void> {
  switch (mode) {
    case "zero":
      return zero();
    case "setup":
      return setup();
    case "qa-preflight":
      return qaPreflight();
    case "arm":
      return arm();
    case "confirm":
      return confirm();
    case "postings":
      return postings();
    case "cleanup":
      return cleanup();
    case "aggregate":
      return aggregate(path);
    default:
      throw new Error("Unsupported acceptance operation");
  }
}
