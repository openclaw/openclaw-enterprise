import { asRecord } from "./objects.ts";

/**
 * Read numeric SDK HTTP status fields in precedence order, without coercion or classification.
 * Only integers from 100 to 599 count: a DOMException's legacy code (TIMEOUT_ERR 23,
 * ABORT_ERR 20) and a gRPC status (PERMISSION_DENIED 7) also sit in `code` and are no
 * HTTP status (findings 1386, 1390).
 */
export function numericErrorStatus(error: unknown): number | undefined {
  const value = asRecord(error);
  const response = asRecord(value?.response);
  for (const candidate of [
    value?.code,
    value?.statusCode,
    response?.statusCode,
    response?.status,
  ]) {
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 100 &&
      candidate <= 599
    ) {
      return candidate;
    }
  }
  return undefined;
}
