import { SecretsManagerServiceException } from "@aws-sdk/client-secrets-manager";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { currentMutationDeadline } from "../../../admission/mutation-deadline.ts";
import { currentComputeOperationLifetime } from "../../compute/operation-context.ts";

class AwsMutationRejectedError extends Error {}

/** Only a structured service rejection of the mutation itself proves it did not apply. */
export async function sendMutation<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (
      error instanceof SecretsManagerServiceException &&
      error.$fault === "client" &&
      error.$metadata.httpStatusCode !== undefined &&
      error.$metadata.httpStatusCode >= 400 &&
      error.$metadata.httpStatusCode < 500 &&
      ["AccessDeniedException", "InvalidParameterException", "ResourceNotFoundException"].includes(
        error.name,
      )
    ) {
      throw new AwsMutationRejectedError();
    }
    throw error;
  }
}

export async function awsRequest<T>(
  operation: (signal: AbortSignal, deadline: number) => Promise<T>,
  mutation = false,
): Promise<T> {
  const lifetime = currentComputeOperationLifetime();
  const parent = lifetime?.signal;
  const deadline = Math.min(
    Date.now() + 30_000,
    currentMutationDeadline() ?? Infinity,
    lifetime?.deadline ?? Infinity,
  );
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
    if (Date.now() >= deadline) {
      throw new Error("AWS request deadline elapsed.");
    }
    submitted = mutation;
    const result = await Promise.race([operation(signal, deadline), cancelled]);
    signal.throwIfAborted();
    // The event loop can deliver a response before it runs an overdue abort timer.
    if (Date.now() >= deadline) {
      throw new Error("AWS request deadline elapsed.");
    }
    return result;
  } catch (error) {
    // Do not expose AWS diagnostics, values, or credentials. Never recover by name.
    if (error instanceof AwsMutationRejectedError) {
      throw new DependencyUnavailableError("AWS Secret mutation was rejected.");
    }
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
