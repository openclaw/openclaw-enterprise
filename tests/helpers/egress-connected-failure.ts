import { constants } from "node:os";
import { summarizeCustodyContext, summarizeCustodyOutcome } from "./egress-custody-diagnostics.ts";
import type { GatewayTurnSummary } from "./egress-gateway-turn-observation.ts";
import { readNativeFailure } from "./egress-native-exec-observation.ts";
import { isBoundedInteger, isChoice } from "./egress-observation-values.ts";

const operations = [
  "before-custody-supervisor-get",
  "before-custody-log-read",
  "before-custody-supervisor-recheck",
  "gateway-selection-list",
  "gateway-exec-target-get",
  "gateway-codex-exec",
  "gateway-turn-verification",
  "after-custody-observation",
  "after-custody-supervisor-get",
  "after-custody-log-read",
  "after-custody-supervisor-recheck",
] as const;

const signals = new Set(Object.keys(constants.signals));
const outcomes = ["exit", "signal", "cancelled", "deadline", "transport"] as const;
type Operation = (typeof operations)[number];
const failedOperations = new WeakMap<
  Error,
  {
    operation: Operation;
    nativeTurnResult: GatewayTurnSummary | undefined;
  }
>();
const kubectlOutcomes = new WeakMap<Error, ReturnType<typeof summarizeKubectlOutcome>>();
const custodyOutcomes = new WeakMap<Error, ReturnType<typeof summarizeCustodyOutcome>>();
const custodyContexts = new WeakMap<
  Error,
  NonNullable<ReturnType<typeof summarizeCustodyContext>>
>();
export async function observeConnectedOperation<Result>(
  operation: unknown,
  action: () => Result,
  nativeTurnResult?: GatewayTurnSummary,
): Promise<Awaited<Result>> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && isChoice(operations, operation) && !failedOperations.has(error)) {
      failedOperations.set(error, {
        operation,
        nativeTurnResult: operation === "gateway-turn-verification" ? nativeTurnResult : undefined,
      });
    }
    throw error;
  }
}

type KubectlInput = {
  outcome: unknown;
  exitCode?: unknown;
  signal?: unknown;
  killed?: unknown;
  signalAborted?: unknown;
};
type NativeFailureInput = { stderr?: string; tag: string; clientExit: boolean };

function summarizeKubectlOutcome(
  { outcome, exitCode, signal, killed, signalAborted }: KubectlInput,
  nativeFailure?: NativeFailureInput,
) {
  return {
    kubectl: {
      outcome: isChoice(outcomes, outcome) ? outcome : "transport",
      exitCode: isBoundedInteger(exitCode, 255) ? exitCode : null,
      signal: typeof signal === "string" && signals.has(signal) ? signal : null,
      killed: typeof killed === "boolean" ? killed : null,
      signalAborted: signalAborted === true,
    },
    nativeExec:
      nativeFailure === undefined
        ? undefined
        : readNativeFailure(nativeFailure.stderr, nativeFailure.tag, nativeFailure.clientExit),
  };
}

export function rememberKubectlOutcome<Failure extends Error>(
  error: Failure,
  value: KubectlInput,
  nativeFailure?: NativeFailureInput,
): Failure {
  kubectlOutcomes.set(error, summarizeKubectlOutcome(value, nativeFailure));
  return error;
}

export function rememberCustodyOutcome<Failure>(
  error: Failure,
  value: Parameters<typeof summarizeCustodyOutcome>[0],
): Failure {
  if (error instanceof Error) {
    custodyOutcomes.set(error, summarizeCustodyOutcome(value));
  }
  return error;
}

// Session proximity does not bind an observed session to a custody request.
export function rememberCustodyContext<Failure>(
  error: Failure,
  phase: string,
  sessions: unknown,
): Failure {
  if (error instanceof Error) {
    const context = summarizeCustodyContext(phase, sessions);
    if (context !== undefined) {
      custodyContexts.set(error, context);
    }
  }
  return error;
}

// The test owns stage through its checkpoints. Error payloads cannot choose it.
type FailureDiagnostic = {
  kind: "assertion" | "operation";
  operation: Operation | null;
  kubectl: ReturnType<typeof summarizeKubectlOutcome>["kubectl"] | null;
  nativeExec?: ReturnType<typeof readNativeFailure>;
  custody?: Omit<ReturnType<typeof summarizeCustodyOutcome>, "evidence">;
  custodyEvidence?: NonNullable<ReturnType<typeof summarizeCustodyOutcome>["evidence"]>;
  custodyContext?: NonNullable<ReturnType<typeof summarizeCustodyContext>>;
  nativeTurnResult?: GatewayTurnSummary;
};

export async function safeConnectedFailure(
  error: unknown,
  stage: string,
  recordFailure?: (diagnostic: FailureDiagnostic) => unknown,
) {
  // Only fixed source names and bounded V8 coordinates can reach the reporter.
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  // V8 prefixes the frames with the complete Error string, including message
  // newlines. That untrusted prefix cannot choose a source location.
  const headers = error instanceof Error ? [Error.prototype.toString.call(error)] : [];
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    headers.push(`${error.name} [${error.code}]: ${error.message}`);
  }
  const header = headers.find((value) => stack.startsWith(value + "\n"));
  const frames = header === undefined ? "" : stack.slice(header.length + 1);
  const frame = frames.match(
    /^ +at [^\n]*[/\\]((?:agent-openshell-static-egress-k3d-real\.test|egress-(?:connected-inputs|custody-observations|installed-(?:agent|resource-cleanup|stack)|managed-workload-exec)|openshell-kubernetes-real)\.mjs|egress-(?:supplier-custody-transitions|controller-(?:upgrade|processes|retirement|retained-state)|supervisor-(?:reconnect|processes|sessions))\.ts):(\d{1,5}):(\d{1,4})(?:\))?$/m,
  );
  const location = frame ? `${frame[1]}:${frame[2]}:${frame[3]}` : "external-operation";
  const kind =
    ((typeof error === "object" && error !== null) || typeof error === "function") &&
    "code" in error &&
    error.code === "ERR_ASSERTION"
      ? "assertion"
      : "operation";
  const { operation = null, nativeTurnResult } =
    (error instanceof Error ? failedOperations.get(error) : undefined) ?? {};
  const local = error instanceof Error ? kubectlOutcomes.get(error) : undefined;
  const kubectl = local?.kubectl ?? null;
  const observedCustody = error instanceof Error ? custodyOutcomes.get(error) : undefined;
  const custodyEvidence = observedCustody?.evidence;
  let custody: FailureDiagnostic["custody"];
  if (observedCustody !== undefined) {
    const { evidence: _evidence, ...summary } = observedCustody;
    custody = summary;
  }
  const custodyContext = error instanceof Error ? custodyContexts.get(error) : undefined;
  const nativeExec = operation === "gateway-codex-exec" ? local?.nativeExec : undefined;
  if (operation !== null || kubectl !== null) {
    try {
      await recordFailure?.({
        kind,
        operation,
        kubectl,
        ...(nativeExec && { nativeExec }),
        ...(custody && { custody }),
        ...(custodyEvidence && { custodyEvidence }),
        ...(custodyContext && { custodyContext }),
        ...(nativeTurnResult && { nativeTurnResult }),
      });
    } catch {
      // A diagnostic write must not replace the triggering failure or interrupt cleanup.
    }
  }
  const step = operation === null ? "" : ` / ${operation}`;
  const process = kubectl === null ? "" : ` kubectl=${JSON.stringify(kubectl)}`;
  const native = nativeExec === undefined ? "" : ` nativeExec=${JSON.stringify(nativeExec)}`;
  const observed = custody ? ` custody=${JSON.stringify(custody)}` : "";
  const turn = nativeTurnResult ? ` nativeTurnResult=${JSON.stringify(nativeTurnResult)}` : "";
  return new Error(
    `Connected egress ${kind} failed at ${stage}${step} (${location})${process}${native}${turn}${observed}; inspect the per-run ledger`,
  );
}
