import assert from "node:assert/strict";

export function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

export function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

export function jsonRecord(source: string) {
  return record(JSON.parse(source));
}

export function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
