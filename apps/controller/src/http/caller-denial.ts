import type { PermissionAction, ResourceKind, ResourceRef } from "@openclaw-enterprise/contracts";

// A caller's own denial with no grant to name, such as an unprovisioned identity. Clients that
// still match it exactly keep working (finding 2534).
export const GENERIC_DENIAL = "The exact platform operation was not authorized.";
// Every denial that names the caller's missing grant starts with this prefix, so clients can tell
// it from the generic text and from refusals that name another principal.
export const NAMED_DENIAL_PREFIX = "Not authorized:";

// Resource kinds in the permissions cheat sheet's words.
const KIND_LABELS: Readonly<Record<ResourceKind, string>> = Object.freeze({
  installation: "Installation",
  namespace: "Namespace",
  configuration: "Configuration",
  preset: "Preset",
  service_account: "ServiceAccount",
  secret: "Secret",
  agent: "Agent",
  agent_revision: "AgentRevision",
  credential_source: "credential source",
  sandbox_policy: "SandboxPolicy",
});

// A resource ID shows only in this plain shape; any other reads as "a <Kind> this request uses".
const SHOWN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const ASK = "Ask an Installation administrator to grant it.";

// A native admin request the caller may not make. The Agent comes from the host name, not from
// the caller, so the text names no Agent, and an unknown host gets it too.
export const NATIVE_ADMIN_DENIAL = `${NAMED_DENIAL_PREFIX} opening this Agent's native admin UI needs Agent administer on it. ${ASK}`;

/**
 * The text for the caller's own denial of `action` on `resource` (finding 2534). It names the
 * grant the request checked and who grants it. The disclosure rules:
 * - It names a resource ID only when the request itself carried it (`requested`), so it never
 *   names an ID read from stored state, such as a Secret an Agent binds.
 * - It never names a binding, Role, Restriction or another principal, and it reads the same
 *   whether a Restriction denied the request or no grant allowed it.
 * - It depends only on the request and the checked grant, never on whether the resource exists,
 *   so an unknown ID and one the caller cannot read get the same answer.
 */
export function callerDenialMessage(
  authorization: { readonly action: PermissionAction; readonly resource: ResourceRef },
  requested: (value: string) => boolean = () => false,
): string {
  const { action, resource } = authorization;
  const kind = KIND_LABELS[resource.kind] ?? resource.kind;
  const named = (id: string | undefined) =>
    id !== undefined && SHOWN_ID.test(id) && requested(id) ? id : undefined;
  if (resource.kind === "installation") {
    return action === "administer"
      ? `${NAMED_DENIAL_PREFIX} this needs Installation administer. Ask an Installation administrator to do it for you or to grant it.`
      : `${NAMED_DENIAL_PREFIX} this needs Installation ${action}. ${ASK}`;
  }
  if (action === "create") {
    // A collection create targets its parent: the Installation for a Namespace, otherwise the
    // Namespace. Namespace Roles cannot grant create, so only an Installation administrator can.
    if (resource.kind === "namespace") {
      return `${NAMED_DENIAL_PREFIX} this needs Namespace create. Ask an Installation administrator to create the Namespace for you or to grant it.`;
    }
    const namespaceId = named(resource.namespaceId);
    const where = namespaceId === undefined ? " in this Namespace" : ` in Namespace ${namespaceId}`;
    return `${NAMED_DENIAL_PREFIX} this needs ${kind} create${where}. Namespace Roles cannot grant create: ask an Installation administrator to create the ${kind} for you or to grant it.`;
  }
  const id = named(resource.id);
  const article = /^[AEIOU]/.test(kind) ? "an" : "a";
  const target = id === undefined ? `${article} ${kind} this request uses` : `${kind} ${id}`;
  // Log text also accepts administer, unless a Restriction denies read_logs; the text says so for
  // every caller, so it never tells which case applied.
  const grant =
    action === "read_logs"
      ? "Agent read_logs (or Agent administer when no Restriction applies)"
      : `${kind} ${action}`;
  return `${NAMED_DENIAL_PREFIX} this needs ${grant} on ${target}. ${ASK}`;
}

/**
 * The string values a request carried in its path, query and body, for `callerDenialMessage`.
 * The walk is bounded: a value past the bounds is simply not named.
 */
export function requestedValues(...sources: readonly unknown[]): (value: string) => boolean {
  const found = new Set<string>();
  let budget = 4096;
  const visit = (value: unknown, depth: number) => {
    if (budget <= 0 || depth > 24) {
      return;
    }
    budget -= 1;
    if (typeof value === "string") {
      found.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
    } else if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) {
        visit(item, depth + 1);
      }
    }
  };
  for (const source of sources) {
    visit(source, 0);
  }
  return (value) => found.has(value);
}
