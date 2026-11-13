import assert from "node:assert/strict";
import { basename, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { teamReviewProof } from "../../tests/fixtures/skipper-team-review-journey.mjs";

export const skipperImageScope = "checkout-images-with-synthetic-model-trust-layer";
const installedTestPath = "tests/integration/skipper-prepared-git-installed.test.mjs";
const installedTestName =
  "same Compute-owned Skipper chats, authors private Git, loses Git during an authenticated fetch, and still chats";
const passedCounts = { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 };

export function skipperInstalledProof(teamReview: boolean): string[] {
  return [
    "deployed-revision-gateway-and-harness-ready",
    "chat-before-private-git-verified",
    "prepared-before-native-git",
    ...(teamReview ? teamReviewProof : ["native-commit-confirmed-by-independent-fetch"]),
    "wrong-repository-hook-refusal-and-broker-denied-mixed-push",
    "native-authenticated-post-after-withdrawal-refused",
    "fresh-authenticated-fetch-after-effective-withdrawal-refused",
    "same-compute-owned-skipper-chat-after-git-withdrawal-verified",
    "same-compute-owned-skipper-chat-git-and-live-withdrawal-observed",
    "owned-agent-retired-cluster-cleanup-still-required",
  ];
}

export function skipperTestCheckpoints(teamReview: boolean): string[] {
  return [
    ...skipperInstalledProof(teamReview).slice(0, -1), // Retirement can follow a failure before proof.
    "create-synthetic-model-secret",
    "deploy-request-started",
    "observe-installed-agent-readonly-skill-directories",
    "gateway-chat-refused",
    "native-command-started",
    "repository-binding-withdrawn-discovery-released",
    "native-command-completion-mismatch",
    "native-command-and-model-observed",
  ];
}

export function skipperSelectedFailure(resultText: string) {
  const files = record(JSON.parse(resultText)).files;
  assert.ok(Array.isArray(files));
  const file = files.map(record).find((entry) => entry.path === installedTestPath);
  assert.ok(file && Array.isArray(file.tests));
  const failed = file.tests.map(record).find((entry) => entry.status === "failed");
  const fileFailure = failed?.error == null ? record(file.fileFailure) : undefined;
  return { error: record(failed?.error ?? fileFailure?.error), fileFailure };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Publish the passed runner result without copying diagnostics or inventing coverage. */
export function projectSkipperRunnerReceipt(value: unknown) {
  const summary = record(value);
  assert.ok(
    summary.version === 1 && summary.command === "run",
    "Invalid installed Skipper runner result",
  );
  assert.ok(typeof summary.sourceSha === "string" && /^[a-f0-9]{40}$/.test(summary.sourceSha));
  assert.ok(
    summary.status === "passed" &&
      summary.exitCode === 0 &&
      isDeepStrictEqual(summary.counts, passedCounts) &&
      isDeepStrictEqual(summary.issues, []),
    "Invalid installed Skipper runner outcome",
  );
  assert.ok(Array.isArray(summary.files) && summary.files.length === 1);
  const file = record(summary.files[0]);
  assert.ok(
    file.path === installedTestPath && isDeepStrictEqual(file.cleanup, { status: "passed" }),
    "Invalid installed Skipper file result",
  );
  assert.ok(Array.isArray(file.tests) && file.tests.length === 1);
  const test = record(file.tests[0]);
  assert.ok(
    test.name === installedTestName && test.status === "passed",
    "Invalid installed Skipper test result",
  );
  const { durationMs } = test;
  assert.ok(
    durationMs === undefined ||
      (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0),
  );
  const scope = summary.scope === "full" || summary.scope === "focused" ? summary.scope : undefined;
  const complete =
    scope === "full" &&
    file.exercised === true &&
    file.signal === null &&
    file.nodeExitCode === 0 &&
    file.fileFailure === undefined &&
    file.status === "passed" &&
    isDeepStrictEqual(file.counts, passedCounts) &&
    Array.isArray(file.issues) &&
    file.issues.length === 0;
  const counts = { ...passedCounts };
  return {
    version: 1,
    command: "run",
    sourceSha: summary.sourceSha,
    status: "passed",
    counts,
    exitCode: 0,
    scope,
    issues: [],
    files: [
      {
        path: installedTestPath,
        status: "passed",
        counts,
        cleanup: { status: "passed" },
        tests: [{ name: installedTestName, status: "passed", durationMs }],
        ...(complete ? { exercised: true, signal: null, nodeExitCode: 0, issues: [] } : {}),
      },
    ],
  };
}

export const skipperOperations = [
  "command-input",
  "gateway-chat",
  "gateway-exec",
  "native-observation",
  "model-observation",
  "command-cleanup",
] as const;
type SkipperOperation = (typeof skipperOperations)[number];
export const skipperGatewayChatPhases = [
  "before-private-git",
  "native-git",
  "after-withdrawal",
] as const;

/** Only this closed projection may leave the installed test's private result. */
export function skipperOperationDiagnostic(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const diagnostic = value as Record<string, unknown>;
  if (
    diagnostic.kind !== "skipper-operation" ||
    !skipperOperations.some((operation) => operation === diagnostic.operation)
  ) {
    return undefined;
  }
  const { operation, exitCode, signal, code, gatewayCategory, httpStatus } = diagnostic;
  const gatewayChatPhase = skipperGatewayChatPhases.find(
    (phase) => phase === diagnostic.gatewayChatPhase,
  );
  const { runtimeSignal, modelRequestObservation } = diagnostic;
  const attributed = operation === "gateway-chat" && gatewayChatPhase !== undefined;
  return {
    ...(attributed &&
    typeof runtimeSignal === "string" &&
    [
      "thread-filesystem-sandbox-denied",
      "thread-start",
      "model-transport",
      "no-known-signal",
      "logs-unavailable",
    ].includes(runtimeSignal)
      ? { runtimeSignal }
      : {}),
    ...(attributed &&
    typeof modelRequestObservation === "string" &&
    ["observed", "none-in-window", "unavailable"].includes(modelRequestObservation)
      ? { modelRequestObservation }
      : {}),
    kind: "skipper-operation",
    operation: operation as SkipperOperation,
    ...(operation === "gateway-chat" && gatewayChatPhase ? { gatewayChatPhase } : {}),
    ...(typeof gatewayCategory === "string" &&
    [
      "gateway-credential-unavailable",
      "authentication",
      "permission",
      "workspace",
      "agent-runtime",
      "timeout",
      "unavailable",
      "unclassified",
      "transport",
      "client-deadline",
      "response-body",
      "response-json",
    ].includes(gatewayCategory)
      ? { gatewayCategory }
      : {}),
    ...(typeof httpStatus === "number" &&
    (httpStatus === 0 || (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599))
      ? { httpStatus }
      : {}),
    ...(Number.isInteger(exitCode) &&
    typeof exitCode === "number" &&
    exitCode >= 0 &&
    exitCode <= 255
      ? { exitCode }
      : {}),
    ...(typeof signal === "string" && ["SIGTERM", "SIGKILL", "SIGABRT"].includes(signal)
      ? { signal }
      : {}),
    ...(typeof code === "string" &&
    [
      "ERR_ASSERTION",
      "ENOENT",
      "EACCES",
      "E2BIG",
      "ETIMEDOUT",
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    ].includes(code)
      ? { code }
      : {}),
  };
}

/** Preserve the original rejection, including asynchronous subprocess errors without user frames. */
export async function runSkipperOperation<T>(
  operation: SkipperOperation,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const error =
      cause instanceof Error ? cause : new Error("Installed Skipper operation failed", { cause });
    try {
      const fields = error as Error & {
        code?: unknown;
        signal?: unknown;
        openclawCiDiagnostic?: unknown;
      };
      // Keep the innermost known operation when a caller adds its broader context.
      if (!skipperOperationDiagnostic(fields.openclawCiDiagnostic)) {
        Object.assign(error, {
          openclawCiDiagnostic: skipperOperationDiagnostic({
            kind: "skipper-operation",
            operation,
            exitCode: typeof fields.code === "number" ? fields.code : undefined,
            code: typeof fields.code === "string" ? fields.code : undefined,
            signal: fields.signal,
          }),
        });
      }
    } catch {
      // A frozen or unusual Error must keep its original failure.
    }
    throw error;
  }
}

/** Keep the selected failure's location and category together, without publishing its text. */
export function skipperFailureSummary(resultText: string, root: string, fallback: string): string {
  const coordinate = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
  let text = fallback;
  let site;
  let category;
  let operationDetail;
  try {
    const { error, fileFailure } = skipperSelectedFailure(resultText);
    const path = installedTestPath;
    const cause = record(error.cause ?? {});
    const location = record(error.location ?? {});
    const diagnostic = skipperOperationDiagnostic(error.diagnostic);
    if (diagnostic) {
      operationDetail = [
        `operation=${diagnostic.operation}`,
        diagnostic.exitCode === undefined ? undefined : `child-exit=${diagnostic.exitCode}`,
        diagnostic.signal === undefined ? undefined : `signal=${diagnostic.signal}`,
        diagnostic.code === undefined ? undefined : `code=${diagnostic.code}`,
        diagnostic.httpStatus === undefined ? undefined : `gateway-status=${diagnostic.httpStatus}`,
        diagnostic.gatewayCategory === undefined
          ? undefined
          : `gateway-category=${diagnostic.gatewayCategory}`,
      ]
        .filter(Boolean)
        .join(", ");
    }
    // Commit selected state only after its nested records validate. Never pair
    // one case's location with another case's error from the lane output.
    text = [error.message, error.frame].filter((value) => typeof value === "string").join("\n");
    if (fileFailure?.diagnosticKind === "post-test-async-activity") {
      category = "post-test-async-activity";
    } else if (cause.code === "ERR_ASSERTION") {
      category = "ERR_ASSERTION";
    } else if (error.code === "ERR_TEST_FAILURE") {
      category = "ERR_TEST_FAILURE";
    }
    const source = [path, "tests/helpers/skipper-prepared-compute.mjs"].find(
      (name) => location.file === resolve(root, name),
    );
    if (source && coordinate(location.line) && coordinate(location.column)) {
      site = `${basename(source)}:${location.line}:${location.column}`;
    }
  } catch {
    // Missing or malformed diagnostics must not replace the original test failure.
  }
  if (!site) {
    const match = text.match(
      /((?:skipper-prepared-compute|skipper-prepared-git-installed\.test)\.mjs):(\d+):(\d+)(?!\d)/,
    );
    const line = Number(match?.[2]);
    const column = Number(match?.[3]);
    if (match && coordinate(line) && coordinate(column)) {
      site = `${match[1]}:${line}:${column}`;
    }
  }
  // Prefer a specific signal in this error to the generic Node test wrapper.
  category =
    text.match(
      /RTM_NEWADDR|bwrap|native command failed|missing-env|test-timeout|selected-zero|timed out:/,
    )?.[0] ??
    category ??
    text.match(/ERR_ASSERTION|expected-test-not-passed/)?.[0];
  return [site ?? "location unavailable", category ?? "unclassified", operationDetail]
    .filter(Boolean)
    .join(", ");
}

function digest(value: unknown): string {
  assert.ok(typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value));
  return value;
}

/** The aggregate's explicit control file is independent of the installed receipt. */
export function qualifySkipperRelease(selection: unknown, evidence: unknown, currentSha: string) {
  const expected = record(selection);
  assert.ok(typeof expected.sourceSha === "string" && /^[a-f0-9]{40}$/.test(expected.sourceSha));
  assert.equal(expected.sourceSha, currentSha);
  const selectedImages = record(expected.images);
  const receipt = record(evidence);
  assert.equal(receipt.sourceSha, expected.sourceSha);
  assert.equal(receipt.imageScope, skipperImageScope);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.command, "run");
  assert.equal(receipt.lane, "skipper-prepared-git-installed");
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.exitCode, 0);
  const counts = passedCounts;
  assert.deepEqual(receipt.counts, counts);
  assert.deepEqual(receipt.issues ?? [], []);
  assert.ok(Array.isArray(receipt.files) && receipt.files.length === 1);
  const file = record(receipt.files[0]);
  assert.equal(file.path, installedTestPath);
  assert.equal(file.status, "passed");
  assert.deepEqual(file.counts, counts);
  assert.deepEqual(file.cleanup, { status: "passed" });
  assert.ok(Array.isArray(file.tests) && file.tests.length === 1);
  const test = record(file.tests[0]);
  assert.equal(test.name, installedTestName);
  assert.equal(test.status, "passed");
  assert.ok(Array.isArray(receipt.proof));
  const teamReview = receipt.proof.includes(teamReviewProof[0]);
  assert.deepEqual(receipt.proof, [
    ...skipperInstalledProof(teamReview),
    "owned-cluster-and-synthetic-model-removed",
  ]);
  const observed = record(receipt.imageDigests);
  const images: Record<string, string> = {};
  for (const name of ["controller", "runtime", "repository"]) {
    const image = record(observed[name]);
    images[name] = digest(selectedImages[name]);
    assert.equal(digest(image.built), images[name]);
    // Imported manifests can differ from the built manifest; checkImage already
    // verified the actual CRI config against the selected local image config.
    digest(image.installed);
    digest(image.config);
  }
  return { sourceSha: expected.sourceSha, images, imageScope: skipperImageScope };
}
