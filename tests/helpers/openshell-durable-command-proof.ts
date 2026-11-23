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

  // Per thread, retain the sole known first identity. Null means an unknown identity or
  // more than one distinct identity, so a later completion can always pair with one of them.
  const firstMatches = new Map<string | undefined, string | null>();
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
    const thread = typeof threadId === "string" ? threadId : undefined;
    const identity =
      typeof turnId === "string" && typeof id === "string" ? JSON.stringify([turnId, id]) : null;
    const firstIdentity = firstMatches.get(thread);
    if (nonce === first) {
      firstMatches.set(
        thread,
        firstIdentity === undefined || firstIdentity === identity ? identity : null,
      );
    } else if (
      (thread === undefined && firstMatches.size > 0) ||
      firstMatches.has(undefined) ||
      (firstIdentity !== undefined && (identity === null || firstIdentity !== identity))
    ) {
      return true;
    }
  }
  return false;
}
