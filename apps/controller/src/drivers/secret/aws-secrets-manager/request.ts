import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { currentMutationDeadline } from "../../../admission/mutation-deadline.ts";
import { currentComputeAbortSignal } from "../../compute/operation-context.ts";

export async function awsRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  mutation = false,
): Promise<T> {
  const parent = currentComputeAbortSignal();
  const deadline = Math.min(Date.now() + 30_000, currentMutationDeadline() ?? Infinity);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new DependencyUnavailableError("AWS Secret operation failed; no mutation was submitted.");
  }
  const signal = AbortSignal.any([AbortSignal.timeout(remaining), ...(parent ? [parent] : [])]);
  let submitted = false;
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    // Mutation callbacks submit immediately; their response verification remains
    // inside this boundary. Pre-aborted requests never reach submission.
    submitted = mutation;
    const result = await Promise.race([operation(signal), cancelled]);
    signal.throwIfAborted();
    // The event loop can deliver a response before it runs an overdue abort timer.
    if (Date.now() >= deadline) {
      throw new Error("AWS request deadline elapsed.");
    }
    return result;
  } catch {
    // Do not expose AWS diagnostics, values, or credentials. Never recover by name.
    throw new DependencyUnavailableError(
      submitted
        ? "AWS Secret mutation may have applied; reconciliation required."
        : "AWS Secret operation failed; no mutation was submitted.",
    );
  } finally {
    if (abort) {
      signal.removeEventListener("abort", abort);
    }
  }
}
