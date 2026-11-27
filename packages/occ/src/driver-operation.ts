import {
  DependencyUnavailableError,
  CredentialDeliveryFailedError,
  ResourceConflictError,
  ResourceStateConflictError,
  ScopeViolationError,
  CredentialServiceSourceInputError,
} from "./errors.ts";

export async function driverOperation<T>(
  operation: () => Promise<T>,
  capability:
    "Configuration" | "ServiceAccount" | "Compute" | "CredentialService" = "Configuration",
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (capability === "CredentialService") {
      // Driver errors can contain the material supplied to it. Retain only the error category.
      if (error instanceof CredentialDeliveryFailedError) {
        throw new CredentialDeliveryFailedError();
      }
      if (error instanceof CredentialServiceSourceInputError) {
        throw new CredentialServiceSourceInputError(
          "The CredentialService rejected the source input.",
        );
      }
      if (error instanceof ResourceStateConflictError) {
        throw new ResourceStateConflictError(
          "The CredentialService cannot complete this source operation.",
        );
      }
      if (error instanceof ResourceConflictError) {
        throw new ResourceConflictError(
          "The CredentialService source conflicts with current state.",
        );
      }
      if (error instanceof ScopeViolationError) {
        throw new ScopeViolationError(
          "The CredentialService source is unavailable to this operation.",
        );
      }
      throw new DependencyUnavailableError("The selected CredentialService Driver is unavailable.");
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
