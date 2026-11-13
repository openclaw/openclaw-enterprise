export function controlPlaneAuditEnabled(
  mode: "development" | "production",
  value: string | undefined,
): boolean {
  if (value === undefined) {
    return mode === "development";
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  throw new Error("OCC_CONTROL_PLANE_AUDIT_ENABLED must be true or false.");
}

// A client deadline also covers a connection that stops responding.
export const controlPlaneAuditDatabaseOptions = {
  connectionTimeoutMillis: 15_000,
  query_timeout: 15_000,
} as const;

export const CONTROL_PLANE_AUDIT_WRITE_TIMEOUT_MS = 2_000;
