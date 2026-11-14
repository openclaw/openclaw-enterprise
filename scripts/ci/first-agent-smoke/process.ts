import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { GATEWAY_STOP_TIMEOUT_MS } from "../../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const occ = join(root, "bin", "occ");
export const workDirectory = resolve(
  process.env.OCC_FIRST_AGENT_SMOKE_DIRECTORY ??
    join(process.env.RUNNER_TEMP ?? "/tmp", "first-agent-smoke"),
);
// OCC_FIRST_AGENT_SMOKE_SLOT (0-31, default 0) picks this run's host-wide names,
// port and subnet, so concurrent smokes on one Docker host do not collide.
// Unset, empty and 0 keep the names CI uses.
export function smokeSlotNames(value?: string | null) {
  value ||= "0";
  if (!/^(?:0|[1-9][0-9]?)$/.test(value) || Number(value) > 31) {
    throw new Error(
      `OCC_FIRST_AGENT_SMOKE_SLOT must be an integer from 0 to 31, got ${JSON.stringify(value)}`,
    );
  }
  const slot = Number(value);
  if (slot === 0) {
    return {
      cluster: "occ-dev-first-agent-smoke",
      registryContainer: "oce-first-agent-smoke-registry",
      registry: "127.0.0.1:5000",
      model: "oce-first-agent-smoke-model",
      subnet: "11.111.0.0/29",
      modelAddress: "11.111.0.2",
      nodeModelAddress: "11.111.0.3",
    };
  }
  const base = 8 * slot;
  return {
    cluster: `occ-dev-smoke-s${slot}`,
    registryContainer: `oce-smoke-s${slot}-registry`,
    registry: `127.0.0.1:${15000 + slot}`,
    model: `oce-smoke-s${slot}-model`,
    subnet: `11.111.0.${base}/29`,
    modelAddress: `11.111.0.${base + 2}`,
    nodeModelAddress: `11.111.0.${base + 3}`,
  };
}
export const slotNames = smokeSlotNames(process.env.OCC_FIRST_AGENT_SMOKE_SLOT);
export const registry = slotNames.registry;
// Agent NetworkPolicies allow model egress only to public addresses on TCP/443,
// and OpenClaw refuses provider addresses in private or special-use ranges. The
// stand-in provider therefore uses a globally routable address, reachable only
// on this host's Docker network; nothing outside the runner is contacted.
export const modelNetwork = { name: slotNames.model, subnet: slotNames.subnet };
export const modelAddress = slotNames.modelAddress;
export const nodeModelAddress = slotNames.nodeModelAddress;
export const modelContainer = slotNames.model;
export const noncePattern = "OCE_SMOKE_[A-Za-z0-9-]+|FIRST_AGENT_[A-Za-z0-9-]+";
export const minute = 60_000;
// Both stop requests share one serial worker. Per Agent, allow the selected
// gateway grace, two minutes for a dedicated workload to terminate and one
// minute for API observation/finalization. This is a finite smoke allowance,
// not a change to runtime grace, worker retries or the 40-minute CI job bound.
export const STOP_PHASE_TIMEOUT_MS = 2 * (GATEWAY_STOP_TIMEOUT_MS + 3 * minute);
export function log(message: string) {
  process.stdout.write(`[first-agent-smoke] ${message}\n`);
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  timeout?: number;
  label?: string;
  signal?: AbortSignal | undefined;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function run(
  command: string,
  args: readonly string[],
  { env = process.env, input, timeout = 5 * minute, label, signal: abortSignal }: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolveRun, reject: (reason: unknown) => void) => {
    abortSignal?.throwIfAborted();
    const child = spawn(command, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stream = (target: NodeJS.WriteStream, chunks: Buffer[]) => (chunk: Buffer) => {
      chunks.push(chunk);
      if (label) {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim()) {
            target.write(`[${label}] ${line}\n`);
          }
        }
      }
    };
    child.stdout.on("data", stream(process.stdout, stdout));
    child.stderr.on("data", stream(process.stderr, stderr));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(stop, timeout);
    abortSignal?.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", stop);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (abortSignal?.aborted) {
        reject(abortSignal.reason);
        return;
      }
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolveRun(result);
        return;
      }
      const error = new Error(
        `${command} ${args.slice(0, 3).join(" ")} exited ${code ?? signal}\n${result.stderr.slice(-4000)}`,
      );
      Object.assign(error, { result });
      reject(error);
    });
  });
}

type Operation<T> = () => T | PromiseLike<T>;

type Phase =
  | "local-setup"
  | "install-reader"
  | "route-model"
  | "initial-admissions"
  | "admit-embedded"
  | "admit-codex"
  | "admit-reader-control"
  | "codex-chat"
  | "public-read"
  | "reader-retirement"
  | "agent-logs"
  | "stop-agents"
  | "start-agents"
  | "chat-after-start";

interface TimingRow {
  name: string | undefined;
  seconds: number;
  status: "ok" | "failed";
  phase: Phase | undefined;
  startMs: number;
  endMs: number;
}

export type Step = <T>(name: string, operation: Operation<T>) => Promise<T>;

export function createStepRecorder(now = () => performance.now()) {
  const origin = now();
  const timings: TimingRow[] = [];
  const phases = new Map<Phase, string>([
    ["local-setup", "Local Setup (occ dev up)"],
    ["install-reader", "install public reader and select its peer"],
    ["route-model", "route api.openai.com to the stand-in provider"],
    ["initial-admissions", "initial Agent admissions"],
    ["admit-embedded", "embedded OpenClaw Agent via scripts/first-agent.ts"],
    ["admit-codex", "dedicated Codex Agent via the API"],
    ["admit-reader-control", "selected reader control via the API"],
    ["codex-chat", "dedicated Codex chat turn"],
    ["public-read", "selected Agent managed-skill public read"],
    ["reader-retirement", "reader retirement and unselected successor"],
    ["agent-logs", "occ agent logs"],
    ["stop-agents", "stop both Agents"],
    ["start-agents", "start both Agents"],
    ["chat-after-start", "chat turns after start"],
  ]);

  async function step<T>(
    name: string | undefined,
    operation: Operation<T>,
    phase?: Phase,
  ): Promise<T> {
    const started = now();
    log(`${name}: started`);
    function record(status: TimingRow["status"]) {
      const ended = now();
      const seconds = Math.round((ended - started) / 1000);
      timings.push({
        name,
        seconds,
        status,
        phase,
        startMs: Math.round(started - origin),
        endMs: Math.round(ended - origin),
      });
      return seconds;
    }
    try {
      const result = await operation();
      const seconds = record("ok");
      log(`${name}: ok (${seconds}s)`);
      return result;
    } catch (error) {
      record("failed");
      log(`${name}: FAILED`);
      throw error;
    }
  }

  function smokeStep<T>(phase: Phase, operation: Operation<T>): Promise<T> {
    return step(phases.get(phase), operation, phase);
  }

  function initialAdmissions<Embedded, Codex, Control>({
    embedded,
    codex,
    control,
  }: {
    embedded: Operation<Embedded>;
    codex: Operation<Codex>;
    control: Operation<Control>;
  }) {
    return smokeStep("initial-admissions", () =>
      Promise.all([
        smokeStep("admit-embedded", embedded),
        smokeStep("admit-codex", codex),
        smokeStep("admit-reader-control", control),
      ]),
    );
  }

  async function writeTimingReport(runnerTemp: string) {
    // A phase without a completed row is unknown. In particular, a rejected
    // Promise.all can finish before some of its branches do.
    const rows = timings
      .filter(({ phase }) => phase !== undefined && phases.has(phase))
      .map(({ phase, startMs, endMs, status }) => ({ phase, startMs, endMs, status }));
    const file = join(runnerTemp, "first-agent-smoke-timing.json");
    const temporary = `${file}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, rows }) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, file);
    } catch {
      log("Timing report unavailable");
    }
  }

  return { step, smokeStep, initialAdmissions, timings, writeTimingReport };
}

function validTimeout(timeout: unknown): asserts timeout is number {
  assert.ok(
    typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout > 0,
    "Timeout must be a positive finite integer.",
  );
}

interface Clock {
  now?: () => number;
  sleep?: (milliseconds: number) => PromiseLike<unknown>;
}

interface Observation<T> {
  done?: unknown;
  value?: T;
  state?: unknown;
}

export async function waitFor<T = undefined>(
  description: string,
  operation: Operation<Observation<T> | null | undefined>,
  timeout: number | null,
  { now = Date.now, sleep = delay }: Clock = {},
): Promise<T | undefined> {
  validTimeout(timeout);
  const deadline = now() + timeout;
  let last: Observation<T> | null | undefined;
  while (now() < deadline) {
    last = await operation();
    if (now() > deadline) {
      break;
    }
    if (last?.done) {
      return last.value;
    }
    const remaining = deadline - now();
    if (remaining > 0) {
      await sleep(Math.min(2_000, remaining));
    }
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(last?.state ?? null)}`);
}

export interface AgentStopState {
  activeRevisionId?: unknown;
  desiredRuntimeState?: unknown;
  status?: unknown;
}

function agentStopState(agent: AgentStopState | null | undefined) {
  const revision = agent?.activeRevisionId;
  return {
    desiredRuntimeState:
      agent?.desiredRuntimeState === "running" || agent?.desiredRuntimeState === "stopped"
        ? agent.desiredRuntimeState
        : "unknown",
    activeRevisionId:
      revision == null
        ? null
        : typeof revision === "string" &&
            /^rev_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(revision)
          ? revision
          : "invalid",
    status: agent?.status === "active" || agent?.status === "deleting" ? agent.status : "unknown",
  };
}

export async function agentStopDiagnostic(readAgent: Operation<AgentStopState | null | undefined>) {
  try {
    return { phase: "agent-state", ...agentStopState(await readAgent()) };
  } catch {
    // A failed diagnostic read must not replace the smoke's original failure.
    return { phase: "agent-state", unavailable: true };
  }
}

export async function observeAgentStop(
  label: string,
  readAgent: Operation<AgentStopState>,
  readPods: Operation<readonly unknown[]>,
  {
    timeout = STOP_PHASE_TIMEOUT_MS,
    now = Date.now,
    sleep = delay,
  }: Clock & { timeout?: number } = {},
) {
  validTimeout(timeout);
  const started = now();
  const deadline = started + timeout;
  const clock = { now, sleep };
  await waitFor(
    `${label} to stop`,
    async () => {
      const current = await readAgent();
      assert.ok(
        current.desiredRuntimeState === "stopped",
        `${label}: desired state changed while stopping`,
      );
      return {
        done: !current.activeRevisionId,
        state: { phase: "active-revision", elapsedMs: now() - started, ...agentStopState(current) },
      };
    },
    timeout,
    clock,
  );
  const remaining = deadline - now();
  assert.ok(remaining > 0, `${label}: stop observation deadline expired before Pods were checked`);
  await waitFor(
    `${label} Pods to terminate after a reported stop`,
    async () => {
      const pods = await readPods();
      return {
        done: pods.length === 0,
        state: { phase: "pods", elapsedMs: now() - started, remainingPods: pods.length },
      };
    },
    Math.min(2 * minute, remaining),
    clock,
  );
}
