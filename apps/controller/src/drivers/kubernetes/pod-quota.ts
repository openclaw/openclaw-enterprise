import { asRecord } from "@openclaw-enterprise/utils";
import { compareResourceQuantities } from "../compute/kubernetes/resource-quantities.ts";

// The API server's quota refusal, `exceeded quota: <name>, requested: <resource>=<quantity>[,...],
// used: ..., limited: ...`, lists only the resources over their limit.
const QUOTA_REFUSAL = /\bexceeded quota: ([^\s,]+), requested: ([^\s,]+(?:,[^\s,]+)*), used: /u;
const POD_QUOTA_RESOURCES = ["pods", "count/pods"] as const;

// The ResourceQuota a Pod creation refusal names when that quota had no Pods left.
export function podQuotaRefusal(message: unknown): string | undefined {
  const refusal = typeof message === "string" ? QUOTA_REFUSAL.exec(message) : null;
  return refusal?.[2]?.split(",").some((entry) => {
    const resource = entry.split("=", 1)[0];
    return POD_QUOTA_RESOURCES.some((name) => name === resource);
  })
    ? refusal[1]
    : undefined;
}

// True when a ResourceQuota's status shows its Pods all used: a Pod needs one more.
export function podQuotaFull(quota: unknown): boolean {
  const status = asRecord(asRecord(quota)?.status);
  const hard = asRecord(status?.hard);
  const used = asRecord(status?.used);
  return POD_QUOTA_RESOURCES.some((resource) => {
    const limit = hard?.[resource];
    const count = used?.[resource];
    return (
      typeof limit === "string" &&
      typeof count === "string" &&
      (compareResourceQuantities(count, limit) ?? -1) >= 0
    );
  });
}
