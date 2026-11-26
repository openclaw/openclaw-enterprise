import { constants } from "node:os";

const launchCodes = [
  "E2BIG",
  "EACCES",
  "EAGAIN",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOEXEC",
  "ENOMEM",
  "ENOTDIR",
  "EPERM",
] as const;

type Disposition = { kind: "openshell-startup-process" } & (
  | { outcome: "output-limit" }
  | { outcome: "signal"; signal: keyof typeof constants.signals }
  | { outcome: "exit"; exitCode: number }
  | { outcome: "launch-error"; code: (typeof launchCodes)[number] }
);

function startupDisposition(error: unknown): Disposition | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  const kind = "openshell-startup-process";
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { kind, outcome: "output-limit" };
  }
  const signal = "signal" in error ? error.signal : undefined;
  if (signal !== null && signal !== undefined) {
    if (
      error.code === null &&
      typeof signal === "string" &&
      Object.hasOwn(constants.signals, signal)
    ) {
      return { kind, outcome: "signal", signal: signal as keyof typeof constants.signals };
    }
    return undefined;
  }
  if (
    typeof error.code === "number" &&
    Number.isInteger(error.code) &&
    error.code > 0 &&
    error.code <= 255
  ) {
    return { kind, outcome: "exit", exitCode: error.code };
  }
  if (
    "syscall" in error &&
    typeof error.syscall === "string" &&
    error.syscall.startsWith("spawn ")
  ) {
    const code = launchCodes.find((candidate) => candidate === error.code);
    if (code !== undefined) {
      return { kind, outcome: "launch-error", code };
    }
  }
  return undefined;
}

export function attachDevUpStartupDisposition(failure: Error, childError: unknown): void {
  const diagnostic = startupDisposition(childError);
  if (diagnostic !== undefined) {
    // The CI reporter reads the property across Node's test process boundary.
    // Keep it out of the direct test reporter's ordinary error display.
    Object.defineProperty(failure, "openclawCiDiagnostic", { value: diagnostic });
  }
}
