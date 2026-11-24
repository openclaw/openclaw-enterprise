import assert from "node:assert/strict";

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(isJsonObject(value));
  return value;
}
