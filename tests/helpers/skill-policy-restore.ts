import { redactedQaTail } from "./qa-secrets.ts";

const stageSummaries = new WeakMap<object, string[]>();

function failureSummaries(error: unknown, limit: number): string[] {
  const previous =
    typeof error === "object" && error !== null ? stageSummaries.get(error) : undefined;
  if (previous) {
    return previous.slice(0, limit);
  }
  try {
    const text = error instanceof Error ? error.message : String(error);
    // Mask the entire message before choosing lines, including multi-line private keys.
    const lines = redactedQaTail(text, process.env, { lines: Infinity, lineChars: 100 });
    const header =
      lines.find((line) => /^\s*\w*Error(?:\s*\[[^\]]*\])?:/.test(line)) ?? lines[0] ?? "";
    const tail = lines.at(-1) ?? "";
    return [tail === header ? header : `${header} | ${tail.slice(0, 40)}`];
  } catch {
    return ["Failure details unavailable"];
  }
}

export async function withSkillPolicyRestore<T>(
  run: () => T | PromiseLike<T>,
  restore: () => unknown,
  combinedMessage: string,
): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (cause) {
    try {
      await restore();
    } catch (restorationError) {
      // Node's reporter retains only the outer message. Keep at most three bounded
      // stage summaries so both nested restores fit its 600-character message limit.
      const exercise = failureSummaries(cause, 2);
      const restoration = failureSummaries(restorationError, 1);
      const message = `${combinedMessage}\nExercise: ${exercise.join(" | ")}\nRestoration: ${restoration.join(" | ")}`;
      const combined = new AggregateError([cause, restorationError], message, { cause });
      stageSummaries.set(combined, [...exercise, ...restoration]);
      throw combined;
    }
    throw cause;
  }
  await restore();
  return result;
}
