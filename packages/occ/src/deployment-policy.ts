import type { Configuration } from "@openclaw-enterprise/contracts";

import { ScopeViolationError } from "./errors.ts";

export type ConfigurationOwnership = Readonly<
  Pick<Configuration, "id" | "namespaceId" | "kind" | "generation" | "secretBindings" | "createdAt">
>;

export function assertAgentConfiguration(
  metadata: ConfigurationOwnership | undefined,
  namespaceId: string,
  id: string,
): asserts metadata is ConfigurationOwnership {
  if (metadata?.kind !== "agent" || metadata.namespaceId !== namespaceId || metadata.id !== id) {
    throw new ScopeViolationError(
      "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
    );
  }
}
