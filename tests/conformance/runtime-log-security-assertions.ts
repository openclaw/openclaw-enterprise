import assert from "node:assert/strict";

const surfaceLabels = {
  sandboxPage: "Sandbox page",
  sandboxDownload: "Sandbox download",
  commandRecords: "command records",
  refusedPage: "refused page",
  refusedDownload: "refused download",
  audit: "audit",
  runtimeStatus: "runtime status",
  runtimeDescription: "runtime description",
  runtimePage: "runtime page",
  runtimeDownload: "runtime download",
  apiError: "API error",
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

const checkLabels = {
  registeredValue: "sensitive value label must be registered",
  status: "unexpected status",
  schema: "unexpected response schema",
  code: "unexpected error code",
  header: "unexpected header",
  content: "unexpected content",
  metadata: "unexpected metadata",
  record0: "activity record 0 mismatch",
  record1: "activity record 1 mismatch",
  record2: "activity record 2 mismatch",
  record3: "activity record 3 mismatch",
  record4: "activity record 4 mismatch",
  record5: "activity record 5 mismatch",
  record6: "activity record 6 mismatch",
  record7: "activity record 7 mismatch",
  commandField: "command field mismatch",
  commandMessage: "command message mismatch",
} as const;

export function assertLogSecurityCondition(
  condition: boolean,
  surface: keyof typeof surfaceLabels,
  check: keyof typeof checkLabels,
): asserts condition {
  assert.equal(condition, true, `${surfaceLabels[surface]}: ${checkLabels[check]}`);
}

type SensitiveValues = Partial<Record<(typeof valueLabels)[number], string>>;

export function assertSensitiveValuesAbsent(
  serializedSurface: string,
  surface: keyof typeof surfaceLabels,
  values: SensitiveValues,
): void {
  for (const [suppliedLabel, value] of Object.entries(values)) {
    const label = valueLabels.find((candidate) => candidate === suppliedLabel);
    assertLogSecurityCondition(label !== undefined, surface, "registeredValue");
    if (value !== undefined) {
      assert.equal(
        serializedSurface.includes(value),
        false,
        `${surfaceLabels[surface]}: ${label} must be absent`,
      );
    }
  }
}
