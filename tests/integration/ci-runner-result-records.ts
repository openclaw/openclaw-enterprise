import assert from "node:assert/strict";

import { isRecord } from "../../scripts/ci/reporter-diagnostics.ts";

export function runnerRecord(value: unknown, label: string): Record<string, unknown> {
  assert(isRecord(value), `Expected ${label} to be an object`);
  return value;
}

export function parseRunnerRecord(text: string, label: string) {
  const value: unknown = JSON.parse(text);
  return runnerRecord(value, label);
}

export function runnerArray(value: unknown, label: string): readonly unknown[] {
  assert(Array.isArray(value), `Expected ${label} to be an array`);
  return value;
}

export function runnerRecords(value: unknown, label: string) {
  return runnerArray(value, label).map((row) => runnerRecord(row, label));
}

export function runnerNamedRows(
  value: unknown,
  label: string,
): (Record<string, unknown> & { name: string })[] {
  return runnerRecords(value, label).map((row) => {
    const { name } = row;
    assert(typeof name === "string", `Expected a name in ${label}`);
    return { ...row, name };
  });
}

export function firstRunnerRecord(value: unknown, label: string) {
  return runnerRecord(runnerArray(value, label)[0], label);
}

export function runnerText(value: unknown, label: string): string {
  assert(typeof value === "string", `Expected ${label} to be text`);
  return value;
}
