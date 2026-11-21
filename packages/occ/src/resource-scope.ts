import type { Agent, Namespace } from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { ScopeViolationError } from "./errors.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";

export function namespaceIdentity(namespaceId: string): void {
  if (!isNonEmptyString(namespaceId)) {
    throw new ScopeViolationError("The exact Namespace identity is missing.");
  }
}

export async function exactNamespace(
  state: Pick<PlatformReadView, "namespaces">,
  namespaceId: string,
): Promise<Readonly<Namespace>> {
  namespaceIdentity(namespaceId);
  const namespace = await state.namespaces.findNamespace(namespaceId);
  if (!namespace) {
    throw new ScopeViolationError(
      "The Namespace does not belong to the server-owned Installation.",
    );
  }
  return namespace;
}

export async function exactAgent(
  state: Pick<PlatformReadView, "namespaces" | "agents">,
  namespaceId: string,
  agentId: string,
): Promise<{ namespace: Readonly<Namespace>; agent: Readonly<Agent> }> {
  const namespace = await exactNamespace(state, namespaceId);
  const agent = await state.agents.findAgent(namespace.id, agentId);
  if (!agent) {
    throw new ScopeViolationError(
      "The Agent does not belong to the exact Installation and Namespace.",
    );
  }
  return { namespace, agent };
}

export async function lockNamespace(
  state: Pick<PlatformUnitOfWork, "namespaces">,
  namespaceId: string,
): Promise<Readonly<Namespace>> {
  namespaceIdentity(namespaceId);
  const namespace = await state.namespaces.lockNamespace(namespaceId);
  if (!namespace) {
    throw new ScopeViolationError(
      "The Namespace does not belong to the server-owned Installation.",
    );
  }
  return namespace;
}
