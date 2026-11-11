import { createHash } from "node:crypto";
import type { Agent, Configuration } from "@openclaw-enterprise/contracts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function managementInputFingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Covers reviewed editable settings, not external ownership or runtime observations. */
export function agentAdoptionFingerprint(
  agent: Readonly<Agent>,
  configuration: Readonly<Configuration>,
): string {
  const { externalManagement: _management, ...settings } = agent;
  return createHash("sha256")
    .update(canonical({ agent: settings, configuration }))
    .digest("hex");
}
