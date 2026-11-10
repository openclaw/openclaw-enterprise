import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { redactedQaTail, redactQaError, registerQaSecret } from "./qa-secrets.mjs";

type Run = (diagnostic: (message: string) => void) => Promise<{
  runId: string;
  agentId: string;
  baselineRevisionId: string;
  revisionId: string;
}>;

// The connected runner resolves only after acceptance and owned cleanup.
export async function verifyQaPublicEgress(artifacts: string, run: Run) {
  const serviceKey = process.env.OCC_TEST_PUBLIC_EGRESS_SERVICE_KEY;
  if (serviceKey) {
    registerQaSecret(serviceKey);
  }
  const messages: string[] = [];
  const evidence = resolve(artifacts, "public-egress-runtime.log");
  let receipt: Awaited<ReturnType<Run>> | undefined;
  let failure: { error: unknown } | undefined;
  try {
    receipt = await run((message) => messages.push(message));
    messages.push(JSON.stringify(receipt));
  } catch (error) {
    const safeError: unknown = redactQaError(error);
    failure = { error: safeError };
    messages.push(safeError instanceof Error ? safeError.message : String(safeError));
  }

  const text = redactedQaTail(messages.join("\n"), process.env, {
    lines: 100_000,
    lineChars: 8000,
  }).join("\n");
  try {
    await writeFile(evidence, text + "\n", { mode: 0o600 });
  } catch (error) {
    if (failure) {
      throw new AggregateError(
        [failure.error, error],
        "Public egress workflow and log write failed",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  if (!receipt) {
    throw new Error("Public egress workflow failed; see " + evidence, { cause: failure?.error });
  }
  return {
    evidence,
    outcome: "real protected Agent public and restricted egress with managed Git/model access",
    ...receipt,
  };
}
