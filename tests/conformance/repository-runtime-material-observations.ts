import assert from "node:assert/strict";
import {
  jsonRecord,
  present,
  type MaterialFixture,
} from "./repository-runtime-material-fixture.ts";
import type { MaterialApiCall } from "./repository-runtime-material-kubernetes-fixture.ts";

function configMapDocument(f: MaterialFixture, key: string, namespace?: string): string {
  const configurations = [...f.objects.values()].filter(
    (object) =>
      object.kind === "ConfigMap" &&
      (namespace === undefined || object.metadata.namespace === namespace) &&
      typeof object.data?.[key] === "string",
  );
  assert.equal(configurations.length, 1);
  return present(configurations[0]?.data?.[key], key);
}

export function preparedCodexConfig(f: MaterialFixture) {
  return configMapDocument(f, "config.toml", f.namespace);
}

export function preparedCodexManifest(f: MaterialFixture) {
  return parseRecord(configMapDocument(f, "runtime.json", f.namespace));
}

export function preparedNativeDocument(f: MaterialFixture) {
  return configMapDocument(f, "openclaw.json");
}

export function parseRecord(source: string) {
  const parsed: unknown = JSON.parse(source);
  return jsonRecord(parsed);
}

export function runtimeWrites(calls: readonly MaterialApiCall[]) {
  return calls.filter(
    ({ operation, kind }) =>
      operation === "write" && (kind === "ConfigMap" || kind === "Deployment"),
  );
}

export function deepFreeze(value: unknown) {
  if (value && typeof value === "object") {
    const children: unknown[] = Object.values(value as Record<string, unknown>);
    for (const child of children) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
