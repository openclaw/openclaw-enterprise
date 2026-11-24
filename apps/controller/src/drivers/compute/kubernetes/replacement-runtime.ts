import type { AgentRevision } from "@openclaw-enterprise/contracts";
import { imageReferenceProblem } from "@openclaw-enterprise/occ";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";

const PREFIX = "planned-runtime:v1:";
const REPOSITORY_POLICY_PREFIX = "planned-runtime:v2:";
const INSPECTED_WORKSPACE_PREFIX = "planned-runtime:v3:";

export const IMMUTABLE_IMAGE_DIGEST = /@sha256:[a-f0-9]{64}$/;

export function immutableRuntimeImages({
  gateway,
  agent,
}: Pick<ReplacementRuntime, "gateway" | "agent">): boolean {
  return [gateway, agent].every(
    (image) => IMMUTABLE_IMAGE_DIGEST.test(image) && imageReferenceProblem(image) === undefined,
  );
}

export interface ReplacementRuntime {
  readonly gateway: string;
  readonly agent: string;
  readonly compatibility: string;
  readonly scope?: "repository-policy";
  readonly workspace?: Readonly<{ url: string; mode: "service" | "legacy" }>;
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

export function encodeReplacementRuntime({ scope, ...runtime }: ReplacementRuntime): string {
  const prefix =
    scope === "repository-policy"
      ? runtime.workspace
        ? INSPECTED_WORKSPACE_PREFIX
        : REPOSITORY_POLICY_PREFIX
      : PREFIX;
  return prefix + JSON.stringify(runtime);
}

/** Undefined means legacy; null means a malformed or unknown version, never legacy. */
export function decodeReplacementRuntime(
  admission: string | undefined,
): Readonly<ReplacementRuntime> | null | undefined {
  if (admission === undefined) {
    return undefined;
  }
  if (typeof admission !== "string" || admission.length > 4_096) {
    return null;
  }
  const inspected = admission.startsWith(INSPECTED_WORKSPACE_PREFIX);
  const scoped = inspected || admission.startsWith(REPOSITORY_POLICY_PREFIX);
  const prefix = inspected
    ? INSPECTED_WORKSPACE_PREFIX
    : scoped
      ? REPOSITORY_POLICY_PREFIX
      : PREFIX;
  if (!admission.startsWith(prefix)) {
    return null;
  }
  let value: Record<string, unknown> | undefined;
  try {
    value = asRecord(JSON.parse(admission.slice(prefix.length)));
  } catch {
    return null;
  }
  if (
    !value ||
    Object.keys(value).some(
      (key) =>
        !(key === "workspace" && inspected) && !["gateway", "agent", "compatibility"].includes(key),
    ) ||
    typeof value.gateway !== "string" ||
    !value.gateway.trim() ||
    typeof value.agent !== "string" ||
    !value.agent.trim() ||
    typeof value.compatibility !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.compatibility)
  ) {
    return null;
  }
  const runtime = {
    gateway: value.gateway,
    agent: value.agent,
    compatibility: value.compatibility,
  };
  if (scoped && !immutableRuntimeImages(runtime)) {
    return null;
  }
  if (inspected) {
    const workspace = asRecord(value.workspace);
    if (
      !workspace ||
      Object.keys(workspace).length !== 2 ||
      typeof workspace.url !== "string" ||
      !workspace.url.startsWith("wss://") ||
      (workspace.mode !== "service" && workspace.mode !== "legacy")
    ) {
      return null;
    }
    return Object.freeze({
      ...runtime,
      scope: "repository-policy",
      workspace: Object.freeze({ url: workspace.url, mode: workspace.mode }),
    });
  }
  return Object.freeze({ ...runtime, ...(scoped && { scope: "repository-policy" as const }) });
}
