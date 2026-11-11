import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const chartPackage = "ghcr.io/openclaw/charts/openclaw-enterprise";
export const chartPushParent = "oci://ghcr.io/openclaw/charts";

export function pushChart(archive: string, parent: string) {
  const result = spawnSync(process.env.OCC_HELM_BIN ?? "helm", ["push", archive, parent], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, 0, result.stderr || "Helm chart push failed.");
  const digest = result.stderr.match(/^Digest: (sha256:[a-f0-9]{64})$/mu)?.[1];
  assert.ok(digest, "Helm did not report the chart digest on stderr.");
  return digest;
}

export async function writeBootstrapChart(directory: string, version: string) {
  assert.match(version, /^0\.0\.0-bootstrap\.[1-9][0-9]*\.[1-9][0-9]*$/);
  await mkdir(join(directory, "templates"), { recursive: true });
  await writeFile(
    join(directory, "Chart.yaml"),
    [
      "apiVersion: v2",
      "name: openclaw-enterprise",
      `version: ${version}`,
      "description: Non-deployable GHCR chart package bootstrap marker",
      "type: application",
      "sources:",
      "  - https://github.com/openclaw/openclaw-enterprise",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "templates", "marker.yaml"),
    '{{ fail "This bootstrap marker is not a deployable OpenClaw Enterprise chart." }}\n',
  );
}
