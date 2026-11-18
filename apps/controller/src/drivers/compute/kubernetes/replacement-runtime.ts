import type { AgentRevision } from "@openclaw-enterprise/contracts";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";

const PREFIX = "planned-runtime:v1:";

export interface ReplacementRuntime {
  readonly gateway: string;
  readonly agent: string;
  readonly compatibility: string;
}

/** An image update may not silently change any other admitted execution input. */
export function replacementCompatibility(
  revision: Readonly<AgentRevision>,
  driverInputs: unknown,
  policyAdmission: string | undefined,
): string {
  const definition: Record<string, unknown> = { ...revision };
  delete definition.id;
  delete definition.revision;
  delete definition.createdAt;
  definition.compute = {
    id: revision.compute.id,
    implementation: revision.compute.implementation,
    admission: policyAdmission,
  };
  return sha256Hex(
    JSON.stringify([definition, driverInputs], (_key, value: unknown) => {
      const record = asRecord(value);
      return record === undefined
        ? value
        : Object.fromEntries(
            Object.entries(record).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          );
    }),
  );
}

export function encodeReplacementRuntime(runtime: ReplacementRuntime): string {
  return PREFIX + JSON.stringify(runtime);
}

/** Undefined means legacy; null means a malformed or unknown version, never legacy. */
export function decodeReplacementRuntime(
  admission: string | undefined,
): Readonly<ReplacementRuntime> | null | undefined {
  if (admission === undefined) {
    return undefined;
  }
  if (!admission.startsWith(PREFIX) || admission.length > 4_096) {
    return null;
  }
  let value: Record<string, unknown> | undefined;
  try {
    value = asRecord(JSON.parse(admission.slice(PREFIX.length)));
  } catch {
    return null;
  }
  if (
    !value ||
    Object.keys(value).some((key) => !["gateway", "agent", "compatibility"].includes(key)) ||
    typeof value.gateway !== "string" ||
    !value.gateway.trim() ||
    typeof value.agent !== "string" ||
    !value.agent.trim() ||
    typeof value.compatibility !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.compatibility)
  ) {
    return null;
  }
  return Object.freeze({
    gateway: value.gateway,
    agent: value.agent,
    compatibility: value.compatibility,
  });
}
