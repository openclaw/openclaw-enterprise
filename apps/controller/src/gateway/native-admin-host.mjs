import { createHash } from "node:crypto";

export function deriveNativeAdminHost(installationId, agent, domain) {
  const digest = createHash("sha256")
    .update(`${installationId}\0${agent.namespaceId}\0${agent.id}`)
    .digest("hex")
    .slice(0, 32);
  return `agent-${digest}.${domain}`;
}
