/** Ordered enforced profile. Earlier installation exchanges did not pin a complete response. */
export const openShellExchangeCapabilities = Object.freeze([
  "openshell.supervisor-middleware.http-credential-access.v1",
  "openshell.supervisor-middleware.installation-exchange.v1",
  "openshell.supervisor-middleware.response-custody.v1",
  "openshell.supervisor-middleware.execution-authority.v1",
  "openshell.supervisor-middleware.protected-no-material.v1",
]);

/** Discovery is unordered. Each profile capability must occur exactly once; others may be advertised. */
export function advertisesOpenShellExecutionProfile(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return openShellExchangeCapabilities.every((capability) => {
    const index = value.indexOf(capability);
    return index !== -1 && index === value.lastIndexOf(capability);
  });
}
