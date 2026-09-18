import { asRecord } from "./objects.ts";

/** Read numeric SDK status fields in precedence order, without coercion or classification. */
export function numericErrorStatus(error: unknown): number | undefined {
  const value = asRecord(error);
  const response = asRecord(value?.response);
  for (const candidate of [
    value?.code,
    value?.statusCode,
    response?.statusCode,
    response?.status,
  ]) {
    if (typeof candidate === "number") {
      return candidate;
    }
  }
  return undefined;
}
