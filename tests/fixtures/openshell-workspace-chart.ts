import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { asRecord } from "../../packages/utils/src/index.ts";

type WorkspaceResource = Record<string, unknown> & {
  metadata: Record<string, unknown> & { name: string };
};

function isWorkspaceResource(value: unknown): value is WorkspaceResource {
  const metadata = asRecord(asRecord(value)?.metadata);
  return typeof metadata?.name === "string";
}

const installation = fileURLToPath(
  new URL("../../docs/snippets/openshell-quickstart/kubernetes/installation.jq", import.meta.url),
);

// Read the resources the quickstart installs. Packaged-chart parity is checked
// independently by the openshell_chart_integration Go test in occdev.
export function openShellWorkspaceChartResources(): WorkspaceResource[] {
  const document = execFileSync(
    "jq",
    [
      "-n",
      "--argjson",
      "cluster",
      "{}",
      "--argjson",
      "proxyCidrs",
      "[]",
      "--arg",
      "runtime",
      "",
      "--arg",
      "openshellIP",
      "",
      "--arg",
      "hostname",
      "",
      "--arg",
      "storageClass",
      "",
      "-f",
      installation,
    ],
    { encoding: "utf8" },
  );
  const parsed: unknown = JSON.parse(document);
  const drivers = asRecord(asRecord(parsed)?.drivers);
  const sandbox = asRecord(drivers?.sandbox);
  const configuration = asRecord(sandbox?.configuration);
  const rendered = asRecord(configuration?.gateway)?.operatorWorkspaceResources;
  const resources: unknown[] | undefined = Array.isArray(rendered) ? rendered : undefined;
  assert.ok(
    resources !== undefined && resources.every(isWorkspaceResource),
    "Quickstart operatorWorkspaceResources must contain named Kubernetes resource records.",
  );
  return resources;
}
