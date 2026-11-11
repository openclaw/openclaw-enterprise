const operations = new Set([
  "before-custody-supervisor-get",
  "before-custody-log-read",
  "before-custody-supervisor-recheck",
  "after-custody-observation",
  "after-custody-supervisor-get",
  "after-custody-log-read",
  "after-custody-supervisor-recheck",
]);
const failedOperations = new WeakMap();
const custodyOutcomes = new WeakMap();

export async function observeConnectedOperation(operation, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && operations.has(operation) && !failedOperations.has(error)) {
      failedOperations.set(error, operation);
    }
    throw error;
  }
}

// A fixed projection of observer-owned counters; supplier strings and request
// IDs never become diagnostic fields, even when validation rejects a log entry.
export function rememberCustodyOutcome(error, value) {
  if (!(error instanceof Error)) {
    return error;
  }
  const count = (number) =>
    Number.isSafeInteger(number) && number >= 0 && number <= 2000 ? number : null;
  const choice = (value, allowed) => (allowed.includes(value) ? value : "unknown");
  const labels = new Set([
    "resolve_accepted",
    "resolve_no_material_accepted",
    "resolve_refused",
    "permit_accepted",
    "permit_no_material_accepted",
    "no_permit",
    "response_released",
    "response_blocked",
    "response_delivery_incomplete",
  ]);
  custodyOutcomes.set(error, {
    readAttempts: count(value.readAttempts),
    successfulReads: count(value.successfulReads),
    lastRead: choice(value.lastRead, ["unobserved", "pending", "returned", "deadline", "error"]),
    ring: choice(value.ring, [
      "unobserved",
      "valid",
      "incomplete",
      "prefix-disappeared",
      "prefix-changed",
      "foreign-sandbox",
      "invalid-transition",
    ]),
    lineCount: count(value.lineCount),
    bufferTotal: count(value.bufferTotal),
    freshCount: count(value.freshCount),
    labels: value.labels.filter((label) => labels.has(label)).slice(0, 9),
    sequence: choice(value.sequence, ["unobserved", "none", "partial", "complete", "invalid"]),
  });
  return error;
}

// The test owns stage through its checkpoints. Error payloads cannot choose it.
export async function safeConnectedFailure(error, stage, recordFailure) {
  // Only fixed source names and bounded V8 coordinates can reach the reporter.
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  // V8 prefixes the frames with the complete Error string, including message
  // newlines. That untrusted prefix cannot choose a source location.
  const headers = error instanceof Error ? [Error.prototype.toString.call(error)] : [];
  if (error instanceof Error && typeof error.code === "string") {
    headers.push(`${error.name} [${error.code}]: ${error.message}`);
  }
  const header = headers.find((value) => stack.startsWith(value + "\n"));
  const frames = header === undefined ? "" : stack.slice(header.length + 1);
  const frame = frames.match(
    /^ +at [^\n]*[/\\](agent-openshell-static-egress-k3d-real\.test|egress-(?:connected-inputs|custody-observations|installed-(?:agent|resource-cleanup|stack)|managed-workload-exec|supplier-custody-transitions)|openshell-kubernetes-real)\.mjs:(\d{1,5}):(\d{1,4})(?:\))?$/m,
  );
  const location = frame ? `${frame[1]}.mjs:${frame[2]}:${frame[3]}` : "external-operation";
  const kind = error?.code === "ERR_ASSERTION" ? "assertion" : "operation";
  const operation = failedOperations.get(error) ?? null;
  const custody = custodyOutcomes.get(error);
  if (operation !== null) {
    try {
      await recordFailure?.({
        kind,
        operation,
        ...(custody && { custody }),
      });
    } catch {
      // A diagnostic write must not replace the triggering failure or interrupt cleanup.
    }
  }
  const step = operation === null ? "" : ` / ${operation}`;
  const observed = custody ? ` custody=${JSON.stringify(custody)}` : "";
  return new Error(
    `Connected egress ${kind} failed at ${stage}${step} (${location})${observed}; inspect the per-run ledger`,
  );
}
