import { redactedQaTail } from "./qa-secrets.mjs";

function failureSummary(error, lines) {
  const text = error instanceof Error ? error.message : String(error);
  return redactedQaTail(text, process.env, { lines, lineChars: 130 }).join(" | ");
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
      // Node's reporter retains only the outer message. Redact before shortening, and
      // keep both inner-stage summaries when original-policy restoration also fails.
      const message = `${combinedMessage}\nExercise: ${failureSummary(cause, 2)}\nRestoration: ${failureSummary(errors[1], 1)}`;
      throw new AggregateError(errors, message, { cause });
    }
    throw cause;
  }
  await restore();
  return result;
}
