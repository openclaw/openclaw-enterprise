type DiagnosticDetails = {
  disposition?: string | null;
  elapsedMs?: number;
  cadence?: {
    complete: boolean;
    startOffsetMs: number;
    endOffsetMs: number;
    unprobedSlots: number;
  } | null;
  responseSummary?: {
    successful: number;
    unsuccessful: number;
    maxSuccessfulResponseIntervalMs: number | null;
  };
};

export function upgradeRehearsalDiagnostic(
  row: string,
  { disposition, elapsedMs, cadence, responseSummary }: DiagnosticDetails,
): string {
  if (responseSummary) {
    const duration = cadence?.complete
      ? `${Math.round(cadence.endOffsetMs - cadence.startOffsetMs)} ms`
      : "unknown";
    const { successful, unsuccessful, maxSuccessfulResponseIntervalMs } = responseSummary;
    const longestGap =
      maxSuccessfulResponseIntervalMs === null
        ? "unknown"
        : `${maxSuccessfulResponseIntervalMs} ms`;
    return (
      `OBSERVED ${row} (action ${duration}, requests ${successful} successful / ${unsuccessful} unsuccessful, ` +
      `longest gap between successful samples ${longestGap}, unprobed slots ${cadence?.unprobedSlots ?? "unknown"})`
    );
  }

  const elapsed = typeof elapsedMs === "number" ? ` (${elapsedMs} ms)` : "";
  return `${disposition ?? "PASS"} ${row}${elapsed}`;
}
