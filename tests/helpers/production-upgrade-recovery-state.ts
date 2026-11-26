import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/objects.ts";

// A command reads the persisted observation, which can differ from the authored
// seed. Validate only what the selected operation consumes.
export type RecoveryState = Record<string, unknown>;

export type PreflightFault = { target?: string; mode: string | null; uid?: string };
export type PreflightIdentity = { kind: string; name: string; uid: string };
export type CapabilityProbe = {
  dispatches: number;
  requests: { method?: string; path?: string; body: string }[];
};

export function requireRecoveryPreflight(state: RecoveryState): RecoveryState {
  return record(state.preflight, "recorded upgrade recovery preflight state");
}

export function journalInteger(value: unknown, context: string, minimum = 0): number {
  assert.ok(
    typeof value === "number" && Number.isInteger(value) && value >= minimum,
    `expected an integer of at least ${minimum} for ${context}`,
  );
  return value;
}

// Use required reads for ordinary property access, and optional reads only
// where the command treats null and absence as equivalent.
export function field(value: unknown, key: string | number): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  }
  const target: object = Object(value);
  return Reflect.get(target, key);
}

export function optionalField(value: unknown, key: string | number): unknown {
  return value === null || value === undefined ? undefined : field(value, key);
}

export function record(value: unknown, context: string): Record<string, unknown> {
  const mapping = asRecord(value);
  assert.ok(mapping, `expected a mapping for ${context}`);
  return mapping;
}

export function isList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function list(value: unknown, context: string): unknown[] {
  assert.ok(isList(value), `expected an array for ${context}`);
  return value;
}

export function properties(value: unknown): Record<string, unknown> {
  const source: object = Object(value);
  return { ...source };
}
