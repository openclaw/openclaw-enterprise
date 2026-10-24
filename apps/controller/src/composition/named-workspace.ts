import type { PostgresPlatformState } from "@openclaw-enterprise/occ";

export interface NamedWorkspace {
  readonly stage: "runtime";
  readonly installationId: string;
  readonly namespaceId: string;
  readonly uid: string;
  readonly startupCycle: "independent" | "gateway-readiness";
}

/** Runtime attachment is an identity assertion, never an adoption or bootstrap operation. */
export function readNamedWorkspace(raw: string | undefined): NamedWorkspace | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = JSON.parse(raw);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    value.stage !== "runtime" ||
    typeof value.installationId !== "string" ||
    !/^ins_[a-zA-Z0-9_-]{1,60}$/.test(value.installationId) ||
    typeof value.namespaceId !== "string" ||
    !/^ns_[a-zA-Z0-9_-]{1,60}$/.test(value.namespaceId) ||
    typeof value.uid !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.uid) ||
    !["independent", "gateway-readiness"].includes(value.startupCycle)
  ) {
    throw new Error(
      "OCC_NAMED_WORKSPACE requires exactly runtime stage, installationId, namespaceId, uid and startupCycle (independent or gateway-readiness).",
    );
  }
  return Object.freeze(value);
}

export async function verifyNamedWorkspace(
  state: PostgresPlatformState,
  binding: NamedWorkspace | undefined,
): Promise<void> {
  if (!binding) {
    return;
  }
  await state.read(async (view) => {
    const installation = await view.installations.getInstallation();
    const namespace = await view.namespaces.findNamespace(binding.namespaceId);
    if (
      installation?.id !== binding.installationId ||
      namespace === undefined ||
      !["provisioning", "ready"].includes(namespace.status) ||
      namespace.existingNamespace !== undefined
    ) {
      throw new Error(
        "Named workspace requires the original Installation and an existing provisioning or ready, OCE-owned logical Namespace.",
      );
    }
  });
}
