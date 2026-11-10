import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function selectPolicyProbeCommand(items, { uri, port }, diagnostic) {
  const commands = items
    .filter(({ method }) => method === "item/completed")
    .map(({ params }) => params?.item)
    .filter((item) => item?.type === "commandExecution");
  const executed = commands.find((item) => item.command?.includes("urllib.request"));
  try {
    assert.ok(executed, "the real Agent must execute the Python command");
    assert.ok(executed.command.includes("/usr/bin/python3.11"));
    assert.ok(executed.command.includes(uri));
    return executed;
  } catch (error) {
    // Keep model-authored content private and preserve the original assertion,
    // even if diagnostic projection or its writer fails.
    try {
      const hash = (value) => createHash("sha256").update(value).digest("hex");
      const selectedIndex = commands.indexOf(executed);
      const start = Math.max(0, selectedIndex);
      diagnostic({
        kind: "openshell-policy-probe",
        role: port === 8082 ? "control" : "policy",
        port,
        targetHash: hash(uri),
        commandCount: commands.length,
        candidateCount: commands.filter((item) => item.command?.includes("urllib.request")).length,
        selectedIndex: selectedIndex < 0 ? null : selectedIndex,
        laterUriMatches:
          selectedIndex < 0
            ? 0
            : commands.slice(selectedIndex + 1).filter((item) => item.command?.includes(uri))
                .length,
        commands: commands.slice(start, start + 8).map(({ command }) => ({
          hash: hash(command),
          hasUrllib: command.includes("urllib.request"),
          hasInterpreter: command.includes("/usr/bin/python3.11"),
          hasExpectedUri: command.includes(uri),
        })),
      });
    } catch {
      // Diagnostics do not change whether the real probe passed.
    }
    throw error;
  }
}
