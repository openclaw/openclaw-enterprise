import assert from "node:assert/strict";

type InjectedResponse = { statusCode: number; body: string; json(): unknown };
type ParsedResponse = { status: number; body?: unknown; statusCode?: undefined };
type ApiResponse = InjectedResponse | ParsedResponse;

function isInjected(response: ApiResponse): response is InjectedResponse {
  return typeof response.statusCode === "number";
}

function property(value: unknown, key: "error" | "code"): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  }
  if (typeof value === "object" || typeof value === "function") {
    if (key === "error" && "error" in value) {
      return value.error;
    }
    if (key === "code" && "code" in value) {
      return value.code;
    }
  }
  return undefined;
}

/** Assert the status before decoding an injected response, retaining its raw diagnostic body. */
export function assertApiError(
  response: ApiResponse,
  status: number,
  code: string,
  label?: string,
): void {
  const injected = isInjected(response);
  const body = injected ? response.body : JSON.stringify(response.body);
  const message = label === undefined ? body : `${label}: ${body}`;
  assert.equal(injected ? response.statusCode : response.status, status, message);
  const decoded = injected ? response.json() : response.body;
  assert.equal(property(property(decoded, "error"), "code"), code, message);
}
