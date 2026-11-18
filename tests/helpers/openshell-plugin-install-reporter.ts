import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  boundedProgressLines,
  openShellProgress,
  openShellProgressPrefix,
} from "../../scripts/ci/openshell-progress.mjs";
import { DEPLOYMENT_FAILURE_STEPS } from "../../packages/occ/src/deployment-failure-steps.ts";

const pluginInstallCase = "OpenShell installs selected Codex plugins before WebSocket startup";

const policyCode = "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE";
const denialCategories = ["sandbox-mode-denied", "named-profile-denied", "reviewer-denied"];
const prerequisiteMessages = [
  "The selected Harness requires OPENAI_API_KEY (native or custom endpoint) or CODEX_ACCESS_TOKEN (default Codex).",
  "OCC_TEST_OPENSHELL_HELM must point at the Helm binary used to install the namespace-scoped OpenShell gateway.",
];
const deploymentFailed = "OpenShell revision deployment failed.";
const teardownFailed = "OpenShell plugin installation fixture teardown failed.";
const timedOut = "OpenShell plugin installation child timed out; child details withheld.";
const failureMessages = [
  ...prerequisiteMessages,
  deploymentFailed,
  "final native process must discover the installed selection (ERR_ASSERTION)",
  "removed selection must not remain enabled (ERR_ASSERTION)",
  "OpenShell plugin installation assertion failed (ERR_ASSERTION)",
  "OpenShell plugin installation case failed; child details withheld.",
] as const;
const incomplete =
  "OpenShell plugin installation did not complete one exact passing case; child details withheld.";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

type DeploymentFailure = { code: string; categories: string };

function canonicalCategories(value: string): string {
  const parts = value.split("_");
  const canonical = denialCategories.filter((category) => parts.includes(category)).join("_");
  return canonical === value ? canonical : "";
}

function failureMessage(value: unknown): string | DeploymentFailure {
  const error = record(value);
  // Unwrap only Node's test failure, never arbitrary application cause payloads.
  const cause = error.code === "ERR_TEST_FAILURE" ? record(error.cause) : error;
  const message = typeof cause.message === "string" ? cause.message : "";
  // The fixture inherits Error's name; Node preserves that name, code and message.
  const deployment = /^OpenShell revision [\w-]+ deployment failed(?: \(([^\r\n]*)\))?\.$/u.exec(
    message,
  );
  if (cause.name === "Error" && deployment) {
    const code = cause.code;
    if (
      typeof code === "string" &&
      Object.hasOwn(DEPLOYMENT_FAILURE_STEPS, code) &&
      (deployment[1] === code || (code === policyCode && deployment[1]?.startsWith(`${code}: `)))
    ) {
      return {
        code,
        categories:
          code === policyCode
            ? canonicalCategories((deployment[1] ?? "").slice(code.length + 2))
            : "",
      };
    }
    return deploymentFailed;
  }
  if (cause.code === "ERR_ASSERTION") {
    const prerequisite = prerequisiteMessages.find((summary) => message === summary);
    if (prerequisite !== undefined) {
      return prerequisite;
    }
    if (
      message.split("\n", 1)[0] === "final native process must discover the installed selection"
    ) {
      return "final native process must discover the installed selection (ERR_ASSERTION)";
    }
    if (message.split("\n", 1)[0] === "removed selection must not remain enabled") {
      return "removed selection must not remain enabled (ERR_ASSERTION)";
    }
    return "OpenShell plugin installation assertion failed (ERR_ASSERTION)";
  }
  return "OpenShell plugin installation case failed; child details withheld.";
}

type PluginStage = {
  kind: "openshell-stage";
  stage: "installation" | "exposure-auth";
  outcome: "started" | "passed" | "failed";
};

function validPluginTransition(previous: PluginStage | undefined, next: PluginStage): boolean {
  if (!previous) {
    return next.stage === "installation" && next.outcome === "started";
  }
  if (previous.outcome === "started") {
    return next.stage === previous.stage && next.outcome !== "started";
  }
  return (
    previous.stage === "installation" &&
    previous.outcome === "passed" &&
    next.stage === "exposure-auth" &&
    next.outcome === "started"
  );
}

function nextPluginStage(line: string, previous: PluginStage | undefined): PluginStage | undefined {
  if (!line.startsWith(openShellProgressPrefix)) {
    return undefined;
  }
  try {
    const value = openShellProgress(JSON.parse(line.slice(openShellProgressPrefix.length)));
    if (
      value?.kind === "openshell-stage" &&
      (value.stage === "installation" || value.stage === "exposure-auth") &&
      line === `${openShellProgressPrefix}${JSON.stringify(value)}` &&
      validPluginTransition(previous, value as PluginStage)
    ) {
      return value as PluginStage;
    }
  } catch {
    // Arbitrary diagnostics and malformed records never cross this boundary.
  }
  return undefined;
}

// Only complete, validated stdout stage records precede the terminal frame.
export default async function* reporter(source: AsyncIterable<{ type: string; data: unknown }>) {
  // The transition check admits at most four frames across the entire child.
  const pending: string[] = [];
  let progress: PluginStage | undefined;
  const readProgress = boundedProgressLines((line: string) => {
    const value = nextPluginStage(line, progress);
    if (value) {
      progress = value;
      pending.push(line + "\n");
    }
  });
  let passed = 0;
  let failed = false;
  let complete = false;
  let primary: string | DeploymentFailure | undefined;
  let teardown = false;
  for await (const event of source) {
    const data = record(event.data);
    if (event.type === "test:stdout" && typeof data.message === "string") {
      readProgress(data.message);
      for (const frame of pending.splice(0)) {
        yield frame;
      }
    }
    if (
      event.type === "test:diagnostic" &&
      data.nesting === 0 &&
      data.message ===
        'openclaw-ci-measurement {"kind":"openshell-fixture-teardown","outcome":"failed"}'
    ) {
      teardown = true;
    }
    if (event.type === "test:fail") {
      failed = true;
      if (data.name === pluginInstallCase && data.nesting === 0) {
        const error = record(record(data.details).error);
        if (error.failureType !== "hookFailed") {
          primary ??= failureMessage(error);
        }
      }
    }
    if (event.type === "test:pass") {
      if (
        data.name === pluginInstallCase &&
        data.nesting === 0 &&
        record(data.details).type === "test" &&
        !data.skip &&
        !data.todo
      ) {
        passed += 1;
      } else {
        failed = true;
      }
    }
    if (event.type === "test:summary" && data.file === undefined) {
      const counts = record(data.counts);
      complete =
        data.success === true &&
        counts.tests === 1 &&
        counts.passed === 1 &&
        counts.failed === 0 &&
        counts.cancelled === 0 &&
        counts.skipped === 0 &&
        counts.todo === 0 &&
        counts.suites === 0;
    }
  }
  if (!primary && !teardown && !failed && complete && passed === 1) {
    yield JSON.stringify("passed");
    return;
  }
  yield JSON.stringify({ primary: primary ?? (teardown ? null : incomplete), teardown });
}

export function pluginInstallOutcome(
  stdout: string,
  cleanExit: boolean,
  killedByTimeout = false,
): string | undefined {
  if (killedByTimeout) {
    return timedOut;
  }
  // Exact serialized values also reject partial, duplicated or malformed output.
  if (cleanExit && stdout === JSON.stringify("passed")) {
    return undefined;
  }
  // Validate the bounded protocol before rendering any child-provided fields.
  if (stdout.length > 4096) {
    return incomplete;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return incomplete;
  }
  const outcome = record(parsed);
  if (
    typeof outcome.teardown !== "boolean" ||
    stdout !== JSON.stringify({ primary: outcome.primary, teardown: outcome.teardown })
  ) {
    return incomplete;
  }
  let primary: string;
  if (outcome.primary === null && outcome.teardown) {
    return teardownFailed;
  }
  if (typeof outcome.primary === "string") {
    if (
      outcome.primary !== incomplete &&
      !failureMessages.some((message) => message === outcome.primary)
    ) {
      return incomplete;
    }
    primary = outcome.primary;
  } else {
    const failure = record(outcome.primary);
    const code = failure.code;
    const categories = failure.categories;
    if (
      typeof code !== "string" ||
      !Object.hasOwn(DEPLOYMENT_FAILURE_STEPS, code) ||
      typeof categories !== "string" ||
      categories !== canonicalCategories(categories) ||
      (code !== policyCode && categories !== "") ||
      JSON.stringify(outcome.primary) !== JSON.stringify({ code, categories })
    ) {
      return incomplete;
    }
    primary = `OpenShell revision deployment failed (${code}${categories ? `: ${categories}` : ""}).`;
  }
  return outcome.teardown ? `${primary} ${teardownFailed}` : primary;
}

// Keep the last complete stage even if execFile's deadline interrupts the child.
// Only canonical leading frames are removed; all remaining bytes still face the
// exact terminal protocol, so extra or malformed output cannot turn into a pass.
export function pluginInstallResult(
  stdout: string,
  cleanExit: boolean,
  killedByTimeout = false,
): { progress: PluginStage | undefined; failure: string | undefined } {
  let progress: PluginStage | undefined;
  let offset = 0;
  while (stdout.startsWith(openShellProgressPrefix, offset)) {
    const end = stdout.indexOf("\n", offset);
    if (end === -1 || end - offset > 256) {
      break;
    }
    const line = stdout.slice(offset, end);
    const value = nextPluginStage(line, progress);
    if (!value) {
      break;
    }
    progress = value;
    offset = end + 1;
  }
  return {
    progress,
    failure: pluginInstallOutcome(stdout.slice(offset), cleanExit, killedByTimeout),
  };
}

export async function runPluginInstallCase(testFile: string, timeout: number): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OCC_TEST_OPENSHELL_HARNESS: "codex",
    OCC_TEST_OPENSHELL_SCENARIO: "plugin-install",
  };
  delete env.NODE_TEST_CONTEXT;
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--test",
      `--test-reporter=${fileURLToPath(import.meta.url)}`,
      `--test-name-pattern=^${pluginInstallCase}$`,
      testFile,
    ],
    { env, timeout, maxBuffer: 32 * 1024 * 1024 },
  ).then(
    ({ stdout }) => ({ stdout, cleanExit: true, killedByTimeout: false }),
    (error: unknown) => {
      const details = error !== null && typeof error === "object" ? error : {};
      return {
        stdout: "stdout" in details && typeof details.stdout === "string" ? details.stdout : "",
        cleanExit: false,
        // execFile owns this kill marker: its only kill paths are timeout and
        // maxBuffer. A nested runner may drain SIGTERM and close with exit 1.
        killedByTimeout:
          "killed" in details &&
          details.killed === true &&
          !("code" in details && details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"),
      };
    },
  );
  const { progress, failure } = pluginInstallResult(
    result.stdout,
    result.cleanExit,
    result.killedByTimeout,
  );
  if (failure !== undefined) {
    const stage = progress
      ? `\nLast reported OpenShell stage was ${progress.stage} (${progress.outcome}).`
      : "";
    throw new Error(failure + stage);
  }
}
