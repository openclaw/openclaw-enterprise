import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const installation = fileURLToPath(
  new URL("../../docs/snippets/openshell-quickstart/kubernetes/installation.jq", import.meta.url),
);

// Read the resources the quickstart installs. Packaged-chart parity is checked
// independently by the openshell_chart_integration Go test in occdev.
export function openShellWorkspaceChartResources() {
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
  return JSON.parse(document).drivers.sandbox.configuration.gateway.operatorWorkspaceResources;
}
