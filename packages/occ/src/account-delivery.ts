import { createHash } from "node:crypto";

/** A profile is shared only by presentations with the same account, Agent, sender, and admitted slot configuration. */
export function accountDeliveryProfileId(
  sourceId: string,
  gatewayId: string,
  agentId: string,
  config: Readonly<Record<string, string>>,
): string {
  const identity = JSON.stringify([
    sourceId,
    gatewayId,
    agentId,
    Object.entries(config).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  return "account-" + createHash("sha256").update(identity).digest("hex");
}
