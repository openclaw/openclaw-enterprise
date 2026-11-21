import {
  DependencyUnavailableError,
  ResourceConflictError,
  ResourceStateConflictError,
  ScopeViolationError,
  TokenServiceRegistrationRefusedError,
  TokenServiceSourceInputError,
} from "./errors.ts";

export async function driverOperation<T>(
  operation: () => Promise<T>,
  capability: "Configuration" | "ServiceAccount" | "Compute" | "TokenService" = "Configuration",
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (capability === "TokenService") {
      // Driver errors can contain the material supplied to it. Retain only the error category.
      if (error instanceof TokenServiceRegistrationRefusedError) {
        throw new TokenServiceRegistrationRefusedError(
          "The TokenService refused the source registration.",
        );
      }
      if (error instanceof TokenServiceSourceInputError) {
        throw new TokenServiceSourceInputError("The TokenService rejected the source input.");
      }
      if (error instanceof ResourceStateConflictError) {
        throw new ResourceStateConflictError(
          "The TokenService cannot complete this source operation.",
        );
      }
      if (error instanceof ResourceConflictError) {
        throw new ResourceConflictError("The TokenService source conflicts with current state.");
      }
      if (error instanceof ScopeViolationError) {
        throw new ScopeViolationError("The TokenService source is unavailable to this operation.");
      }
      throw new DependencyUnavailableError("The selected TokenService Driver is unavailable.");
    }
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
