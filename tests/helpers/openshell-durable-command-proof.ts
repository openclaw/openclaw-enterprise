import { isArray, isRecord, parseJson } from "./egress-observation-values.ts";

export function hasOrderedDurableCommands(content: string, nonces: readonly string[]): boolean {
  let next = 0;
  // The rollout writer may still be flushing its final record.
  for (const line of content.split("\n").slice(0, -1).filter(Boolean)) {
    let record: unknown;
    try {
      record = parseJson(line);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return false;
      }
      throw error;
    }
    if (!isRecord(record) || typeof record.type !== "string") {
      return false;
    }
    if (record.type !== "event_msg") {
      continue;
    }
    const { payload } = record;
    if (!isRecord(payload) || typeof payload.type !== "string") {
      return false;
    }
    if (payload.type !== "item_completed") {
      continue;
    }
    const { item } = payload;
    if (!isRecord(item) || typeof item.type !== "string") {
      return false;
    }
    if (item.type !== "CommandExecution") {
      continue;
    }
    const { command, exit_code: exitCode, aggregated_output: output } = item;
    if (
      !isArray(command) ||
      !command.every((arg) => typeof arg === "string") ||
      (exitCode != null && !Number.isInteger(exitCode)) ||
      (output != null && typeof output !== "string")
    ) {
      return false;
    }
    const nonce = nonces[next];
    if (
      nonce !== undefined &&
      exitCode === 0 &&
      output?.trim() === nonce &&
      command.join(" ").includes(nonce)
    ) {
      next += 1;
    }
  }
  return next === nonces.length;
}
