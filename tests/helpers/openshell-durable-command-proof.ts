import { isArray, isRecord, parseJson } from "./egress-observation-values.ts";

export function hasOrderedDurableCommands(content: string, nonces: readonly string[]): boolean {
  const [first, second] = nonces;
  if (
    nonces.length !== 2 ||
    typeof first !== "string" ||
    first.trim() === "" ||
    typeof second !== "string" ||
    second.trim() === "" ||
    first === second
  ) {
    return false;
  }

  const firstMatches = new Set<string | undefined>();
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
    const { command, exit_code: exitCode, aggregated_output: output, id, status } = item;
    if (
      !isArray(command) ||
      !command.every((arg) => typeof arg === "string") ||
      (exitCode != null && !Number.isInteger(exitCode)) ||
      (output != null && typeof output !== "string")
    ) {
      return false;
    }
    const nonce = output?.trim();
    if (
      exitCode !== 0 ||
      (status !== undefined && status !== "completed") ||
      (nonce !== first && nonce !== second) ||
      !command.join(" ").includes(nonce)
    ) {
      continue;
    }

    const { thread_id: threadId, turn_id: turnId } = payload;
    const identity =
      typeof threadId === "string" && typeof turnId === "string" && typeof id === "string"
        ? JSON.stringify([threadId, turnId, id])
        : undefined;
    if (nonce === first) {
      firstMatches.add(identity);
    } else if (
      firstMatches.size > 0 &&
      // Only two complete, equal identities can establish that the witnesses are the same item.
      (identity === undefined || !firstMatches.has(identity) || firstMatches.size > 1)
    ) {
      return true;
    }
  }
  return false;
}
