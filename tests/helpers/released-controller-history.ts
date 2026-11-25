import { isRecord } from "../../scripts/ci/records.ts";

function parseEvent(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Input streams come from the bounded execFile capture. An interrupted Docker
// invocation supplies no settled migration check, even if it wrote an event first.
export function releasedControllerHistoryStatus(outcome: unknown) {
  if (!isRecord(outcome)) {
    return undefined;
  }
  const { code, killed, signal, stdout, stderr } = outcome;
  if (
    typeof code !== "number" ||
    !Number.isInteger(code) ||
    code < 0 ||
    code >= 124 ||
    killed !== false ||
    signal !== null ||
    typeof stdout !== "string" ||
    typeof stderr !== "string"
  ) {
    // 124 denotes a timeout in command wrappers. Docker reserves 125–127 and
    // reports signalled container exits as 128 plus the signal number.
    return undefined;
  }
  const failures = stderr
    .split("\n")
    .filter((line) => line.trimStart().startsWith("{"))
    .map(parseEvent)
    .filter((event) => event?.event === "migration.failed");
  if (code === 0 && failures.length === 0) {
    const event = parseEvent(stdout);
    if (event?.event === "migration.checked" && event.history === "completed") {
      return "current";
    }
  }
  if (
    code === 1 &&
    stdout.trim() === "" &&
    failures.length === 1 &&
    failures[0]?.code === "MIGRATION_HISTORY_UNSUPPORTED"
  ) {
    return "unsupported";
  }
  return "unconfirmed";
}
