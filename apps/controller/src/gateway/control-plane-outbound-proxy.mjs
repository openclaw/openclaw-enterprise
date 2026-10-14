import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createBundledChannelDriver } from "../composition/channel.ts";
import { runOutboundProxy } from "./outbound-proxy.mjs";

/** The proxy loads trusted Driver requirements without starting OCC or reading credentials. */
export function controlPlaneOutboundPolicy(configuration) {
  if (
    typeof configuration !== "object" ||
    configuration === null ||
    Array.isArray(configuration) ||
    Object.keys(configuration).length !== 1 ||
    !Array.isArray(configuration.denyCidrs) ||
    configuration.denyCidrs.length === 0
  ) {
    throw new Error("Control-plane outbound proxy configuration requires only denyCidrs.");
  }
  const requirements = createBundledChannelDriver().controlPlaneNetworkRequirements();
  return {
    mode: "restricted",
    destinations: requirements.flatMap(({ destinations }) => destinations),
    denyCidrs: configuration.denyCidrs,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const path = process.env.OCC_CONTROL_PLANE_OUTBOUND_PROXY_CONFIG_PATH;
    if (path === undefined || !isAbsolute(path)) {
      throw new Error("OCC_CONTROL_PLANE_OUTBOUND_PROXY_CONFIG_PATH requires an absolute path.");
    }
    const maximumBytes = 1024 * 1024;
    const information = await stat(path);
    if (!information.isFile() || information.size > maximumBytes) {
      throw new Error("Invalid control-plane outbound proxy configuration file.");
    }
    const bytes = await readFile(path);
    if (bytes.length > maximumBytes) {
      throw new Error("Invalid control-plane outbound proxy configuration file.");
    }
    const configuration = JSON.parse(bytes.toString("utf8"));
    await runOutboundProxy(controlPlaneOutboundPolicy(configuration));
  } catch {
    process.stderr.write('{"event":"control_plane_outbound_proxy.startup_failed"}\n');
    process.exitCode = 1;
  }
}
