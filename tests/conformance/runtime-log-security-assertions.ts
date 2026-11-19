import assert from "node:assert/strict";

const surfaceLabels = {
  sandboxPage: "Sandbox page",
  sandboxDownload: "Sandbox download",
  commandRecords: "command records",
  refusedPage: "refused page",
  refusedDownload: "refused download",
  audit: "audit",
  runtimeStatus: "runtime status",
} as const;

const valueLabels = [
  "CLONE_TOKEN",
  "CURL_BEARER",
  "QUERY_TOKEN",
  "QUERY_SIG",
  "FIELD_URL_KEY",
  "PASSWORD",
  "PROMPT",
  "GITHUB_PAT",
  "CURL_USER_PASSWORD",
  "SSHPASS_PASSWORD",
  "ARGUMENT_SECRET",
  "REFUSED_CONTENT",
  "DRIVER_ERROR",
] as const;

type SensitiveValues = Partial<Record<(typeof valueLabels)[number], string>>;

export function assertSensitiveValuesAbsent(
  serializedSurface: string,
  surface: keyof typeof surfaceLabels,
  values: SensitiveValues,
): void {
  for (const label of valueLabels) {
    const value = values[label];
    if (value !== undefined) {
      assert.equal(
        serializedSurface.includes(value),
        false,
        `${surfaceLabels[surface]}: ${label} must be absent`,
      );
    }
  }
}
