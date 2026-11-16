import {
  dumpYaml as sdkDumpYaml,
  loadYaml as sdkLoadYaml,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";

export const loadYaml = sdkLoadYaml<unknown>;
export const dumpYaml: (value: unknown, options?: Parameters<typeof sdkDumpYaml>[1]) => string =
  sdkDumpYaml;

export function yamlDocuments(text: string): string[] {
  return text
    .split(/^---\s*$/m)
    .filter((document) =>
      document.split("\n").some((line) => line.trim() && !line.trim().startsWith("#")),
    );
}
