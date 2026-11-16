import type { ResourceRef } from "../../packages/contracts/src/index.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/state/platform-state.ts";

export function agentResource(id: string, namespaceId = "namespace-a"): ResourceRef {
  return { kind: "agent", id, namespaceId };
}

// Creates the Installation and the ready Namespaces (id -> name) in one State transaction.
export async function createInstallationNamespaces(
  unit: PlatformUnitOfWork,
  namespaces: Record<string, string> = { "namespace-a": "local" },
) {
  await unit.installations.createInstallation({
    id: "installation",
    name: "Test",
    createdAt: new Date().toISOString(),
  });
  for (const [id, name] of Object.entries(namespaces)) {
    await unit.namespaces.createNamespace({
      id,
      name,
      status: "ready",
      createdAt: new Date().toISOString(),
    });
  }
}
