import { readFile, writeFile } from "node:fs/promises";

const [gatewayDigest = "", agentDigest = "", openClawGatewayDigest = ""] = process.argv.slice(2);
const selectCodex = Boolean(gatewayDigest || agentDigest);
if (selectCodex || openClawGatewayDigest) {
  const digest = /^sha256:[0-9a-f]{64}$/u;
  if (selectCodex && (!digest.test(gatewayDigest) || !digest.test(agentDigest))) {
    throw new Error(
      "Select exact Gateway and Agent image manifest digests for inspected Workspace.",
    );
  }
  if (openClawGatewayDigest && !digest.test(openClawGatewayDigest)) {
    throw new Error("Select an exact Dedicated OpenClaw Gateway image manifest digest.");
  }

  const file = "apps/controller/src/drivers/sandbox/inspected-workspace-release.ts";
  let source = await readFile(file, "utf8");
  if (selectCodex) {
    source = selectPin(source, "const pin: InspectedWorkspaceRelease | undefined", {
      gatewayDigest,
      agentDigest,
    });
  }
  if (openClawGatewayDigest) {
    source = selectPin(
      source,
      "const openClawPin: { readonly gatewayDigest: string } | undefined",
      {
        gatewayDigest: openClawGatewayDigest,
      },
    );
  }
  await writeFile(file, source);
}

function selectPin(
  source: string,
  declaration: string,
  images: { gatewayDigest: string; agentDigest?: string },
) {
  const disabled = `${declaration} = undefined;`;
  if (source.split(disabled).length !== 2) {
    throw new Error(
      `Expected exactly one disabled inspected Workspace release pin: ${declaration}.`,
    );
  }
  return source.replace(disabled, `${declaration} = Object.freeze(${JSON.stringify(images)});`);
}
