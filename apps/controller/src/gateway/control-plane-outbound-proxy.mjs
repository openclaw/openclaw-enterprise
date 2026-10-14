import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createBundledChannelDriver } from "../composition/channel.ts";
import { runOutboundProxy } from "./outbound-proxy.mjs";
import { readProxyConfiguration } from "./proxy-configuration.mjs";

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
    const configuration = await readProxyConfiguration(path);
    await runOutboundProxy(controlPlaneOutboundPolicy(configuration));
  } catch {
    process.stderr.write('{"event":"control_plane_outbound_proxy.startup_failed"}\n');
    process.exitCode = 1;
  }
}
