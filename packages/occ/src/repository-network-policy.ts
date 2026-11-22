import type { IAMDriver } from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError, ResourceStateConflictError } from "./errors.ts";

function unchanged(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

export function bindRepositoryPolicyAuthorization(current: () => IAMDriver) {
  const driver = current();
  try {
    const authorize = driver.authorize;
    if (typeof authorize === "function") {
      return {
        inputs: [driver, authorize] as const,
        assertCurrent() {
          if (!unchanged(() => current() === driver && driver.authorize === authorize)) {
            throw new ResourceStateConflictError(
              "The selected authorization Driver changed during repository network policy admission. Reload before editing.",
            );
          }
        },
      };
    }
  } catch {
    // A Driver method getter can contain private diagnostics.
  }
  throw new DependencyUnavailableError(
    "The selected authorization Driver could not verify the operation.",
  );
}
