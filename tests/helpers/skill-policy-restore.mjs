import { redactedQaTail } from "./qa-secrets.mjs";

const stageSummaries = new WeakMap();

function failureSummaries(error, limit) {
  const previous = stageSummaries.get(error);
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

export async function withSkillPolicyRestore(run, restore, combinedMessage) {
  let result;
  try {
    result = await run();
  } catch (cause) {
    const errors = [cause];
    try {
      await restore();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 1) {
      // Node's reporter retains only the outer message. Keep at most three bounded
      // stage summaries so both nested restores fit its 600-character message limit.
      const exercise = failureSummaries(cause, 2);
      const restoration = failureSummaries(errors[1], 1);
      const message = `${combinedMessage}\nExercise: ${exercise.join(" | ")}\nRestoration: ${restoration.join(" | ")}`;
      const combined = new AggregateError(errors, message, { cause });
      stageSummaries.set(combined, [...exercise, ...restoration]);
      throw combined;
    }
    throw cause;
  }
  await restore();
  return result;
}
