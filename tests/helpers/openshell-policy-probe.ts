import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { isRecord } from "./egress-observation-values.ts";

type CommandExecution = Record<string, unknown> & { type: "commandExecution" };
type CommandWithText = CommandExecution & { command: string };
type ProbeCommand = CommandWithText & {
  exitCode?: number | null | undefined;
  aggregatedOutput?: string | null | undefined;
};

type ProbeTarget = { uri: string; port: 8082 | 8083 };
type ProbeDiagnostic = {
  kind: "openshell-policy-probe";
  role: "control" | "policy";
  port: ProbeTarget["port"];
  targetHash: string;
  commandCount: number;
  candidateCount: number;
  selectedIndex: number | null;
  laterUriMatches: number;
  commands: {
    hash: string;
    hasUrllib: boolean;
    hasInterpreter: boolean;
    hasExpectedUri: boolean;
  }[];
};

const urllib = "urllib.request";
const interpreter = "/usr/bin/python3.11";

export function selectPolicyProbeCommand(
  items: readonly unknown[],
  { uri, port }: ProbeTarget,
  diagnostic: (receipt: ProbeDiagnostic) => void,
): ProbeCommand {
  const commands = items.flatMap(completedCommand);
  const executed = commands.find(usesUrllib);
  try {
    assert.ok(executed, "the real Agent must execute the Python command");
    assert.ok(executed.command.includes(interpreter));
    assert.ok(executed.command.includes(uri));
    assert.ok(hasProbeResult(executed), "expected a Codex command result");
    return executed;
  } catch (error) {
    // Keep model-authored content private and preserve the original assertion,
    // even if diagnostic projection or its writer fails.
    try {
      const selectedIndex = executed === undefined ? null : commands.indexOf(executed);
      const start = selectedIndex ?? 0;
      diagnostic({
        kind: "openshell-policy-probe",
        role: port === 8082 ? "control" : "policy",
        port,
        targetHash: hash(uri),
        commandCount: commands.length,
        candidateCount: commands.filter(usesUrllib).length,
        selectedIndex,
        laterUriMatches:
          selectedIndex === null
            ? 0
            : commands.slice(selectedIndex + 1).filter((item) => readCommand(item)?.includes(uri))
                .length,
        commands: commands.slice(start, start + 8).map((item) => {
          const command = readCommand(item);
          assert.ok(command !== undefined);
          return {
            hash: hash(command),
            hasUrllib: command.includes(urllib),
            hasInterpreter: command.includes(interpreter),
            hasExpectedUri: command.includes(uri),
          };
        }),
      });
    } catch {
      // Diagnostics do not change whether the real probe passed.
    }
    throw error;
  }
}

function completedCommand(message: unknown): CommandExecution[] {
  if (!isRecord(message) || message.method !== "item/completed" || !isRecord(message.params)) {
    return [];
  }
  const { item } = message.params;
  return isCommandExecution(item) ? [item] : [];
}

function isCommandExecution(item: unknown): item is CommandExecution {
  return isRecord(item) && item.type === "commandExecution";
}

function readCommand({ command }: CommandExecution): string | undefined {
  if (command == null) {
    return undefined;
  }
  assert.ok(typeof command === "string", "expected a Codex command string");
  return command;
}

function usesUrllib(item: CommandExecution): item is CommandWithText {
  return readCommand(item)?.includes(urllib) === true;
}

function hasProbeResult(item: CommandWithText): item is ProbeCommand {
  const { exitCode, aggregatedOutput } = item;
  return (
    (exitCode == null || typeof exitCode === "number") &&
    (aggregatedOutput == null || typeof aggregatedOutput === "string")
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
