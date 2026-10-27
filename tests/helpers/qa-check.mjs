import { redactQaError } from "./qa-secrets.mjs";

/** Reporting must never prevent an action, especially teardown and withdrawal. */
export async function runQaCheck({ result, save, name, action }) {
  const entry = { name, status: "running", startedAt: new Date().toISOString() };
  result.checks.push(entry);
  const failures = [];
  const persist = async () => {
    try {
      await save();
    } catch (error) {
      const safe = redactQaError(error);
      failures.push(safe);
      (entry.reportingErrors ??= []).push(String(safe));
    }
  };
  await persist();
  process.stderr.write(`# Strands Box: ${name}\n`);
  let value;
  try {
    value = await action();
    entry.status = "passed";
  } catch (error) {
    const safe = redactQaError(error);
    failures.push(safe);
    entry.status = "failed";
    entry.error = String(safe);
  } finally {
    entry.finishedAt = new Date().toISOString();
    await persist();
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${name}: ${failures.map(String).join("; ")}`);
  }
  return value;
}
