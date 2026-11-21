import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";

export async function driverOperation<T>(
  operation: () => Promise<T>,
  capability: "Configuration" | "ServiceAccount" | "Compute" | "TokenService" = "Configuration",
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof DependencyUnavailableError ||
      error instanceof ScopeViolationError ||
      error instanceof ResourceConflictError
    ) {
      throw error;
    }
    throw new DependencyUnavailableError(`The selected ${capability} Driver is unavailable.`);
  }
}
