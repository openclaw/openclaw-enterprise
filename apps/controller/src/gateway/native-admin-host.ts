import { createHash } from "node:crypto";
import type { Agent } from "@openclaw-enterprise/contracts";

export function deriveNativeAdminHost(
  installationId: string,
  agent: Pick<Agent, "namespaceId" | "id">,
  domain: string,
): string {
  const digest = createHash("sha256")
    .update(`${installationId}\0${agent.namespaceId}\0${agent.id}`)
    .digest("hex")
    .slice(0, 32);
  return `agent-${digest}.${domain}`;
}
