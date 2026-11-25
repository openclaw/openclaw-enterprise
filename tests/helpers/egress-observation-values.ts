import assert from "node:assert/strict";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasStringField<Field extends string>(
  value: unknown,
  field: Field,
): value is Record<string, unknown> & Record<Field, string> {
  return isRecord(value) && typeof value[field] === "string";
}

export function hasResourceId(value: unknown): value is Record<string, unknown> & { id: string } {
  return hasStringField(value, "id");
}

export function hasPodIdentity(value: unknown): value is Record<string, unknown> & {
  metadata: { name: string; uid: string };
} {
  return (
    isRecord(value) &&
    hasStringField(value.metadata, "name") &&
    hasStringField(value.metadata, "uid")
  );
}

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function isChoice<Value>(choices: readonly Value[], value: unknown): value is Value {
  return choices.some((choice) => choice === value);
}

export function isBoundedInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function parseJson(source: string): unknown {
  return JSON.parse(source);
}

export function entries(value: unknown): Record<string, unknown>[] {
  if (value == null) {
    return [];
  }
  assert.ok(isArray(value) && value.every(isRecord), "expected observation objects");
  return value;
}

export function readString(value: unknown): string {
  if (typeof value !== "string") {
    assert.fail("expected a string observation");
  }
  return value;
}
