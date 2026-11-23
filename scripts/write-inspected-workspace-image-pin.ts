import { readFile, writeFile } from "node:fs/promises";

const [gatewayDigest = "", agentDigest = ""] = process.argv.slice(2);
if (gatewayDigest || agentDigest) {
  const digest = /^sha256:[0-9a-f]{64}$/u;
  if (!digest.test(gatewayDigest) || !digest.test(agentDigest)) {
    throw new Error(
      "Select exact Gateway and Agent image manifest digests for inspected Workspace.",
    );
  }

  const file = "apps/controller/src/drivers/sandbox/inspected-workspace-release.ts";
  const disabledPin = "const pin: InspectedWorkspaceRelease | undefined = undefined;";
  const source = await readFile(file, "utf8");
  if (source.split(disabledPin).length !== 2) {
    throw new Error("Expected exactly one disabled inspected Workspace release pin.");
  }

  const selectedPin = [
    "const pin: InspectedWorkspaceRelease | undefined = Object.freeze({",
    `  gatewayDigest: "${gatewayDigest}",`,
    `  agentDigest: "${agentDigest}",`,
    "});",
  ].join("\n");
  await writeFile(file, source.replace(disabledPin, selectedPin));
}
