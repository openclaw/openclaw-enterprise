import { ScopeViolationError } from "../errors.ts";
import type { ConfigurationOwnership } from "../ports/configurations.ts";

export function assertConfigurationMetadata(configuration: ConfigurationOwnership): void {
  if (
    configuration.kind !== "agent" ||
    !Number.isSafeInteger(configuration.generation) ||
    configuration.generation <= 0
  ) {
    throw new ScopeViolationError("The Configuration kind or generation is invalid.");
  }
}

export function configurationGenerationRangeError(): ScopeViolationError {
  return new ScopeViolationError("The Configuration generation exceeds its supported range.");
}
