import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/objects.ts";
import {
  dumpYaml as sdkDumpYaml,
  loadYaml as sdkLoadYaml,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";

export const loadYaml: (text: string) => unknown = sdkLoadYaml;
export const dumpYaml: (value: unknown) => string = sdkDumpYaml;

// Return the original mapping so fixture edits are included when the document is dumped.
export function yamlMapping(value: unknown, ...path: string[]): Record<string, unknown> {
  let mapping = asRecord(value);
  assert.ok(mapping, "expected a YAML mapping");
  for (const key of path) {
    mapping = asRecord(mapping[key]);
    assert.ok(mapping, `expected a YAML mapping for ${key}`);
  }
  return mapping;
}

export function yamlDocuments(text: string): string[] {
  return text
    .split(/^---\s*$/m)
    .filter((document) =>
      document.split("\n").some((line) => line.trim() && !line.trim().startsWith("#")),
    );
}
